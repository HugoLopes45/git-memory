/**
 * Persistent memory for LLMs, branch-scoped, backed by git refs.
 *
 * - `record(opts)` — save a note to refs/agent-memory/<scope>/<slug>
 * - `list(opts?)` — list headlines from current scope + main fallback
 * - `read(opts)` — fetch a note's full body
 * - `forget(opts)` — delete a note from a scope or all scopes
 *
 * Scope defaults to the current git branch. Slug defaults to sha1(body)[:12].
 * Older note versions are accessible via `git log refs/agent-memory/<scope>/<slug>`.
 */

export { context, type ContextOpts, type ContextResult } from "./context.js";
export {
  ConflictError,
  MneoError,
  type MneoErrorCode,
  InvalidInputError,
  NotFoundError,
  RepoBrokenError,
  UntrustedError,
} from "./errors.js";

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
  RepoBrokenError,
  UntrustedError,
} from "./errors.js";

/** Root namespace for all memory refs. */
export const REF_ROOT = "refs/agent-memory/";

/** Default scope (trunk) when not on a branch. */
export const TRUNK_SCOPE = "main";

/** Max note body length in chars. */
export const MAX_BODY = 5000;

/** Max slug length in chars. */
export const MAX_SLUG = 80;

/** Max scope length in chars. */
export const MAX_SCOPE = 80;

/** Max headline length in chars (first line of note body). */
export const HEADLINE_MAX = 80;

/**
 * Default limit for list(). Heuristic — chosen as a budget-conscious cap
 * for the auto-injected hook bundle (~50 × 80-char headlines ≈ 4kB).
 * Exposed so callers can tune; the surfaced `more` count tells the caller
 * when the cap silently dropped entries.
 */
export const LIST_DEFAULT_LIMIT = 50;

/**
 * Default max age in days for list(). Heuristic — typical sprint window;
 * reasonable proxy for "what an agent likely cares about right now."
 * The surfaced `hidden` count lets callers retry with maxAgeDays:0 to
 * reach older notes.
 */
export const LIST_DEFAULT_MAX_AGE_DAYS = 30;

/**
 * Skew tolerance for committer timestamps in list(). Commits whose date is
 * more than this many seconds ahead of `now` are dropped: they could not
 * have been legitimately created yet, and accepting them lets a malicious
 * pushed ref pin itself at the top of the list and bypass the maxAgeDays
 * filter forever. 60s covers honest cross-machine clock skew.
 */
export const SKEW_TOLERANCE_SECONDS = 60;

/**
 * Max retries on CAS lock contention.
 * N-way contention needs ~N retries; 20 covers realistic agent concurrency.
 */
export const RECORD_MAX_RETRIES = 20;

// Jitter between retries so losers don't slam git in lockstep — gives
// the current winner room to finish before the next CAS attempt.
const RETRY_JITTER_MAX_MS = 10;

// Cross-runtime sync sleep. Atomics.wait on a SharedArrayBuffer is the only
// portable synchronous delay that works in Node and Bun without busy-looping
// the CPU. The buffer is shared across all calls — Atomics.wait blocks the
// current thread up to `ms`, returning early if the int32 at offset 0 is
// awoken (we never wake it, so it always times out).
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

const SLUG_RE = /^[a-z0-9][a-z0-9\-/]*$/;
const SCOPE_RE = /^[a-z0-9][a-z0-9\-]*$/;

// MNEO_AUTHOR is validated on read so a stale or hostile env (CRLF
// injected into commit headers, oversized identity) can't bypass the same
// rules `by` enforces. Throws on bad env, returns undefined when unset.
function envAuthor(): string | undefined {
  const v = process.env.MNEO_AUTHOR;
  if (v === undefined) return undefined;
  if (!v || v.length > 80 || !BY_RE.test(v)) {
    throw new InvalidInputError("bad MNEO_AUTHOR: must be a single line, 1-80 chars");
  }
  return v;
}

function sh(repo: string, args: readonly string[], stdin?: string, by?: string): string {
  // `by` overrides the author/committer name for this single invocation —
  // routed through env so process.env is never mutated. Falls back to
  // MNEO_AUTHOR (validated), then the standard git env, then the
  // package default. LC_ALL=C locks git's stderr to English so CAS race
  // detection (record()) doesn't break under non-English locales.
  const envName = envAuthor();
  const name = by ?? envName ?? process.env.GIT_AUTHOR_NAME ?? "mneo";
  const committer = by ?? envName ?? process.env.GIT_COMMITTER_NAME ?? "mneo";
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    input: stdin,
    env: {
      ...process.env,
      LC_ALL: "C",
      LANG: "C",
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "agent@mneo",
      GIT_COMMITTER_NAME: committer,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "agent@mneo",
    },
  });
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").toString().trim();
    throw new Error(`git ${args[0]}: ${stderr || `exit ${r.status}`}`);
  }
  return (r.stdout ?? "").toString();
}

function shTry(repo: string, args: readonly string[]): string | null {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").toString().trim() : null;
}

// Trust gate. Opt-in via MNEO_REQUIRE_SIGNED=1 (or "true"). When set, the
// SDK refuses to surface notes whose commit doesn't pass `git verify-commit`
// — defends against the documented push-injection vector when the user has
// fetched refs from a peer they can't fully trust. The user is responsible
// for configuring git's signing keys (gpg.format / user.signingkey /
// gpg.ssh.allowedSignersFile); this helper only asks git the question.
function requireSigned(): boolean {
  const v = process.env.MNEO_REQUIRE_SIGNED;
  return v === "1" || v === "true";
}

function isSignedCommit(repo: string, sha: string): boolean {
  const r = spawnSync("git", ["-C", repo, "verify-commit", sha], { encoding: "utf8" });
  return r.status === 0;
}

/** Find the git repository root. Respects MNEO_REPO env var. Throws RepoBrokenError if no repo found. */
export function findRepo(start: string = process.cwd()): string {
  const env = process.env.MNEO_REPO;
  if (env) {
    const p = resolve(env);
    // Delegate the repo check to git itself — `existsSync('${p}/HEAD')`
    // false-accepts any directory containing a stray file named HEAD. git
    // rev-parse --git-dir handles working trees, bare repos, and linked
    // worktrees uniformly.
    if (shTry(p, ["rev-parse", "--git-dir"]) === null) {
      throw new RepoBrokenError(`MNEO_REPO points to non-repo: ${p}`);
    }
    return p;
  }
  // git's --show-toplevel handles walk-up internally and supports linked
  // worktrees natively. Single spawn vs. one per parent dir.
  const top = shTry(resolve(start), ["rev-parse", "--show-toplevel"]);
  if (top) return top;
  throw new RepoBrokenError(`no git repo found from ${start}`);
}

// Branch names like `feat/auth` get translated for use as a scope. Only
// applied to auto-detected branches and MNEO_SCOPE — never to user
// input via the API, which is validated strictly.
//
// Strict alphabet: lowercase + slash-replace, then validate against
// SCOPE_RE. Branches with `_`, `.`, `~`, `@`, etc. (all valid git refnames)
// throw InvalidInputError instead of producing a confusing "bad scope"
// error far from the source. The recovery prompt names MNEO_SCOPE so
// the LLM has a path forward without needing to rename the branch.
function branchToScope(input: string): string {
  const normalized = input.replace(/\//g, "-").toLowerCase();
  if (!normalized || normalized.length > MAX_SCOPE || !SCOPE_RE.test(normalized)) {
    throw new InvalidInputError(
      `bad scope: '${input}' cannot normalize to [a-z0-9-] (≤${MAX_SCOPE} chars); set MNEO_SCOPE explicitly`,
    );
  }
  return normalized;
}

/** Sentinel value to delete/list across all scopes. SCOPE_RE rejects "*" as a literal scope. */
export const ALL_SCOPES = "*";

/** Get the current scope (normalized branch name or main). Respects MNEO_SCOPE env var. */
export function currentScope(repo: string): string {
  const env = process.env.MNEO_SCOPE;
  if (env) {
    const s = branchToScope(env);
    validateScope(s);
    return s;
  }
  const branch = shTry(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") return TRUNK_SCOPE;
  const scope = branchToScope(branch);
  // branchToScope is lossy: '/' → '-', case folded. Two distinct branches can
  // collapse to the same scope (e.g. 'feat/foo-bar' and 'feat-foo-bar'),
  // silently sharing a ref namespace. Bail at the boundary so the LLM gets a
  // recovery prompt instead of cross-branch reads with no warning. Bypass via
  // explicit `scope` arg or MNEO_SCOPE (handled above).
  const peers = shTry(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  if (peers) {
    const collisions: string[] = [];
    for (const other of peers.split("\n")) {
      if (!other || other === branch) continue;
      let otherScope: string;
      try {
        otherScope = branchToScope(other);
      } catch {
        // Branches outside the scope alphabet ('_', '.', '@', etc.) cannot
        // produce a valid scope — they are not collision candidates.
        continue;
      }
      if (otherScope === scope) collisions.push(other);
    }
    if (collisions.length > 0) {
      throw new InvalidInputError(
        `branch '${branch}' normalizes to scope '${scope}' which collides with: ${collisions.join(
          ", ",
        )}; set MNEO_SCOPE explicitly or pass an explicit scope to disambiguate`,
      );
    }
  }
  return scope;
}

function validateScope(scope: string) {
  if (!scope || scope.length > MAX_SCOPE || !SCOPE_RE.test(scope)) {
    throw new InvalidInputError(`bad scope: ${scope} (lowercase a-z0-9-, ≤${MAX_SCOPE} chars)`);
  }
}

function validateSlug(slug: string) {
  if (!slug || slug.length > MAX_SLUG || !SLUG_RE.test(slug)) {
    throw new InvalidInputError(`bad slug: ${slug} (lowercase a-z0-9-/, ≤${MAX_SLUG} chars)`);
  }
  if (slug.includes("//") || slug.endsWith("/")) {
    throw new InvalidInputError(`bad slug: ${slug} (no // or trailing /)`);
  }
}

function refOf(scope: string, slug: string): string {
  return `${REF_ROOT}${scope}/${slug}`;
}

// Strip control chars from a headline before returning it to the caller.
// Headlines come from `%(subject)` on refs we may have FETCHED from a
// remote — the trust boundary documented in the README. A malicious commit
// subject can carry ANSI escapes (ESC = 0x1B) that rewrite terminal output,
// or BEL/BS/DEL that corrupt downstream JSON consumers. Drop everything
// outside printable ASCII + tab; let LF/CR be removed too (subjects are
// single-line anyway, but a lone CR can sneak through CRLF inputs).
// Bodies are NOT sanitized here — that's the user's contract per the
// README's "treat memory pushes like code pushes" stance.
// biome-ignore lint/suspicious/noControlCharactersInRegex: targeting these on purpose
const HEADLINE_STRIP_RE = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

/** Remove control characters from a headline (defense against malicious git refs). */
export function sanitizeHeadline(s: string): string {
  return s.replace(HEADLINE_STRIP_RE, "");
}

function autoSlug(body: string): string {
  return createHash("sha1").update(body).digest("hex").slice(0, 12);
}

export interface RecordOpts {
  repo?: string | undefined;
  body: string;
  slug?: string | undefined;
  scope?: string | undefined;
  /** Override commit author name. Defaults to MNEO_AUTHOR or "mneo". */
  by?: string | undefined;
}

const BY_RE = /^[^\r\n]+$/;
function validateBy(by: string) {
  if (!by || by.length > 80 || !BY_RE.test(by)) {
    throw new InvalidInputError("bad by: must be a single line, 1-80 chars");
  }
}

export interface RecordResult {
  slug: string;
  scope: string;
  sha: string;
  unchanged: boolean;
}

// Generator carrying the shared record() logic. Yields jitter-ms whenever
// the CAS loop loses a race, so the wrapper decides how to wait — sync via
// sleepSync (default `record`) or async via setTimeout (`recordAsync`, used
// by the MCP server to keep the stdio event loop responsive).
function* recordSteps(opts: RecordOpts): Generator<number, RecordResult, void> {
  if (typeof opts.body !== "string" || opts.body.trim().length === 0) {
    throw new InvalidInputError("body must be a non-empty string");
  }
  if (opts.body.length > MAX_BODY) {
    throw new InvalidInputError(`body length ${opts.body.length} > ${MAX_BODY}`);
  }
  if (opts.by !== undefined) validateBy(opts.by);
  const repo = opts.repo ?? findRepo();
  // Explicit scope: validate strictly, no auto-normalization. Only the auto-
  // detected branch in `currentScope` is normalized (slashes → dashes).
  const scope = opts.scope ?? currentScope(repo);
  validateScope(scope);
  const slug = opts.slug ?? autoSlug(opts.body);
  validateSlug(slug);

  const ref = refOf(scope, slug);
  const by = opts.by;
  const blob = sh(repo, ["hash-object", "-w", "--stdin"], opts.body).trim();
  const tree = sh(repo, ["mktree"], `100644 blob ${blob}\tnote.md\n`).trim();
  const headline = (opts.body.split("\n")[0] ?? "").slice(0, HEADLINE_MAX).trim() || slug;

  // CAS loop. Another writer can move the ref between our rev-parse and
  // update-ref; git rejects with "cannot lock ref ... but expected ...".
  // Re-read parent (which may now point to our exact body — idempotency
  // catches that on the next iteration) and try again.
  for (let attempt = 0; attempt <= RECORD_MAX_RETRIES; attempt++) {
    const parent = shTry(repo, ["rev-parse", "--verify", "--quiet", ref]);
    if (parent && shTry(repo, ["rev-parse", `${parent}^{tree}`]) === tree) {
      return { slug, scope, sha: parent, unchanged: true };
    }
    const args = ["commit-tree", tree, ...(parent ? ["-p", parent] : [])];
    const sha = sh(repo, args, `${headline}\n`, by).trim();
    try {
      sh(repo, ["update-ref", ref, sha, parent ?? ""]);
      return { slug, scope, sha, unchanged: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // CAS race only. Git emits two race messages:
      //   - new-ref creation lost: "reference already exists"
      //   - existing-ref sha mismatch: "is at <SHA> but expected <SHA>"
      // The structural file/directory conflict (slug `a/b/c` blocked by
      // existing slug `a/b`) emits "'<path>' exists" with the parent path
      // quoted — non-transient, must NOT be retried.
      if (!/reference already exists|but expected/.test(msg)) throw e;
      // Loser of the race: orphan commit-tree object stays unreachable
      // until git gc. Yield jitter-ms; wrapper sleeps how it likes.
      yield 1 + Math.floor(Math.random() * RETRY_JITTER_MAX_MS);
    }
  }
  throw new ConflictError(
    `record: ${scope}/${slug} contended after ${RECORD_MAX_RETRIES} retries — transient lock from concurrent writers; wait briefly and retry, or pass a different slug if you want a separate note`,
  );
}

/** Save a note. Slug defaults to sha1(body)[:12]. Throws on validation failure or lock exhaustion. */
export function record(opts: RecordOpts): RecordResult {
  const it = recordSteps(opts);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
    sleepSync(step.value);
  }
}

/**
 * Async version of `record` — yields the JS event loop between CAS retries
 * via setTimeout. Use this from any async host (MCP server, web handler)
 * where blocking the event loop for tens to hundreds of ms is unacceptable.
 * Identical contract and validation as `record`.
 */
export async function recordAsync(opts: RecordOpts): Promise<RecordResult> {
  const it = recordSteps(opts);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
    await new Promise<void>((r) => setTimeout(r, step.value));
  }
}

export interface ListEntry {
  slug: string;
  scope: string;
  h: string;
  ts: number;
}

export interface ListResult {
  entries: ListEntry[];
  /** Count of entries dropped by maxAgeDays. Retry with maxAgeDays:0 to surface older notes. */
  hidden: number;
  /**
   * Count of entries dropped because their commit signature failed verification.
   * Only present when MNEO_REQUIRE_SIGNED is set; absent (not 0) when the
   * trust gate is off, so the trust posture is visible in the result shape.
   */
  untrusted?: number;
  /**
   * Count of entries dropped because their commit timestamp is implausibly
   * far in the future (> SKEW_TOLERANCE_SECONDS ahead of now). Defends against
   * pinning-by-future-date attacks. Present only when > 0.
   */
  skewed?: number;
  /**
   * Count of entries that satisfied every filter (age, trust, skew) but did
   * not fit under `limit`. Present only when > 0; signals that the limit
   * silently truncated data and a higher `limit` would surface more.
   */
  more?: number;
}

export interface ListOpts {
  repo?: string | undefined;
  /** Scope filter: ALL_SCOPES for every namespace, string(s) for specific scopes. Defaults to current + main. */
  scope?: string | typeof ALL_SCOPES | string[] | undefined;
  prefix?: string | undefined;
  limit?: number | undefined;
  /** Hide notes older than N days. Pass 0 to disable. Defaults to 30 (typical sprint window). */
  maxAgeDays?: number | undefined;
}

function resolveScopes(repo: string, requested: ListOpts["scope"]): string[] {
  if (requested === ALL_SCOPES) return [];
  if (Array.isArray(requested)) {
    requested.forEach(validateScope);
    return requested;
  }
  if (typeof requested === "string") {
    validateScope(requested);
    return [requested];
  }
  const cur = currentScope(repo);
  return cur === TRUNK_SCOPE ? [TRUNK_SCOPE] : [cur, TRUNK_SCOPE];
}

/** List note headlines, newest first. Returns entries and a count of hidden older notes. */
export function list(opts: ListOpts = {}): ListResult {
  const repo = opts.repo ?? findRepo();
  const prefix = opts.prefix ?? "";
  if (prefix && !/^[a-z0-9][a-z0-9\-/]*$/.test(prefix)) {
    throw new InvalidInputError(`bad prefix: ${prefix}`);
  }
  const scopes = resolveScopes(repo, opts.scope);

  const refPatterns =
    scopes.length === 0 ? [REF_ROOT] : scopes.map((s) => `${REF_ROOT}${s}/${prefix}`);
  // for-each-ref can fail on corrupted refs (planted bad SHA, broken pack).
  // Translate to RepoBrokenError so context() / CLI can degrade gracefully
  // and the LLM gets a code, not a raw `git for-each-ref: ...` string.
  let out: string;
  try {
    out = sh(repo, [
      "for-each-ref",
      "--sort=-creatordate",
      "--format=%(refname)\t%(objectname)\t%(creatordate:unix)\t%(subject)",
      ...refPatterns,
    ]);
  } catch (e) {
    throw new RepoBrokenError(`list: ${e instanceof Error ? e.message : String(e)}`);
  }

  // De-dup by slug: globally newest commit wins (for-each-ref --sort=-creatordate
  // already puts those first; iteration order = winner). Tied timestamps fall
  // back to refname ASC. Scope-array order is NOT a priority — see
  // edge-cases.test.ts "scope-array order is NOT a priority".
  // `sha` is carried locally so the trust gate (below) can ask git to
  // verify-commit without re-resolving the ref.
  // Skew check happens BEFORE seen.add so a future-dated dup doesn't suppress
  // a legitimate same-slug entry that comes later in the sort order.
  const now = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  const entries: Array<ListEntry & { sha: string }> = [];
  let skewed = 0;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const refname = parts[0] ?? "";
    const sha = parts[1] ?? "";
    const ts = parts[2] ?? "0";
    const h = sanitizeHeadline(parts.slice(3).join("\t"));
    if (!refname.startsWith(REF_ROOT)) continue;
    const tail = refname.slice(REF_ROOT.length); // <scope>/<slug...>
    const slash = tail.indexOf("/");
    if (slash < 0) continue;
    const scope = tail.slice(0, slash);
    const slug = tail.slice(slash + 1);
    // When scopes is empty (scope: "all" or []), the for-each-ref glob
    // doesn't constrain by prefix — apply it client-side here.
    if (scopes.length === 0 && prefix && !slug.startsWith(prefix)) continue;
    const tsNum = Number(ts);
    if (tsNum > now + SKEW_TOLERANCE_SECONDS) {
      // Future-dated past honest clock skew: drop. Cannot have legitimately
      // been written yet; accepting it lets a malicious push pin itself at
      // the top of list and bypass maxAgeDays forever (now - future < 0
      // always passes the age check). Don't add to `seen` so a later same-
      // slug entry with a sane ts is still surfaced.
      skewed++;
      continue;
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    entries.push({ slug, scope, h, ts: tsNum, sha });
  }
  // for-each-ref sorts globally; re-sort to keep newest-first after dedup.
  entries.sort((a, b) => b.ts - a.ts);

  const maxAgeDays = opts.maxAgeDays ?? LIST_DEFAULT_MAX_AGE_DAYS;
  const filtered =
    maxAgeDays > 0 ? entries.filter((e) => now - e.ts <= maxAgeDays * 86400) : entries;
  const hidden = entries.length - filtered.length;

  const limit = opts.limit ?? LIST_DEFAULT_LIMIT;
  const requireSig = requireSigned();
  // Verify signatures inline during the slice so the cost is bounded by
  // `limit` rather than the total ref count. Untrusted entries don't count
  // toward the limit — the user asked for N signed notes, not N attempts.
  // `more` records how many filtered entries were not surfaced because the
  // limit was hit; an over-estimate when the trust gate is on (some of those
  // remaining might also fail verify), but the binary "there's more" signal
  // is what callers need.
  const capped: ListEntry[] = [];
  let untrusted = 0;
  let more = 0;
  for (let i = 0; i < filtered.length; i++) {
    const e = filtered[i] as ListEntry & { sha: string };
    if (limit > 0 && capped.length >= limit) {
      more = filtered.length - i;
      break;
    }
    if (requireSig && !isSignedCommit(repo, e.sha)) {
      untrusted++;
      continue;
    }
    const { sha: _sha, ...entry } = e;
    capped.push(entry);
  }
  const result: ListResult = { entries: capped, hidden };
  if (requireSig) result.untrusted = untrusted;
  if (skewed > 0) result.skewed = skewed;
  if (more > 0) result.more = more;
  return result;
}

export interface ReadOpts {
  repo?: string | undefined;
  slug: string;
  scope?: string | undefined;
}

export interface ReadResult {
  slug: string;
  scope: string;
  body: string;
}

/** Read a note's full body. Falls back to main scope if not found locally. Throws NotFoundError if missing. */
export function read(opts: ReadOpts): ReadResult {
  if (!opts.slug) throw new InvalidInputError("slug required");
  const repo = opts.repo ?? findRepo();
  if (opts.scope) validateScope(opts.scope);
  const explicit = opts.scope ? [opts.scope] : null;
  // Default lookup order: current scope, then trunk.
  const tryScopes =
    explicit ??
    (() => {
      const cur = currentScope(repo);
      return cur === TRUNK_SCOPE ? [TRUNK_SCOPE] : [cur, TRUNK_SCOPE];
    })();

  const requireSig = requireSigned();
  for (const scope of tryScopes) {
    const ref = refOf(scope, opts.slug);
    const sha = shTry(repo, ["rev-parse", "--verify", "--quiet", ref]);
    if (!sha) continue;
    // Trust gate: when the user opted into MNEO_REQUIRE_SIGNED, a ref that
    // exists but fails verify-commit is a distinct failure from "not found"
    // — surface UNTRUSTED so the caller can suggest the right recovery
    // (configure signing, or unset the env to bypass).
    if (requireSig && !isSignedCommit(repo, sha)) {
      throw new UntrustedError(
        `note ${opts.slug} in scope ${scope} has unverified signature; configure git's signing keys (gpg.format / user.signingkey / gpg.ssh.allowedSignersFile) or unset MNEO_REQUIRE_SIGNED to bypass`,
      );
    }
    // Race window: a concurrent forget can delete the ref between rev-parse
    // and show. Re-resolve the ref after a show failure: gone now → race,
    // fall through to next scope; still resolvable → real corruption (bad
    // object, packfile damage), surface as RepoBrokenError instead of
    // masquerading as NotFound.
    let body: string;
    try {
      body = sh(repo, ["show", `${ref}:note.md`]);
    } catch (e) {
      if (shTry(repo, ["rev-parse", "--verify", "--quiet", ref]) !== null) {
        throw new RepoBrokenError(
          `read: ${ref} resolves but blob unreadable: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      continue;
    }
    return { slug: opts.slug, scope, body };
  }
  throw new NotFoundError(`note not found: ${opts.slug} (tried scopes: ${tryScopes.join(", ")})`);
}

export interface ForgetOpts {
  repo?: string | undefined;
  slug: string;
  /** Pass ALL_SCOPES ("*") to delete from every scope at once. */
  scope?: string | typeof ALL_SCOPES | undefined;
}

export interface ForgetResult {
  deleted: boolean;
  scope: string;
  /** Populated only when scope === ALL_SCOPES: the scopes the slug was actually deleted from. */
  scopes?: string[];
}

/** Delete a note from a scope or from all scopes (scope: ALL_SCOPES). Best-effort + idempotent. */
export function forget(opts: ForgetOpts): ForgetResult {
  if (!opts.slug) throw new InvalidInputError("slug required");
  validateSlug(opts.slug);
  const repo = opts.repo ?? findRepo();

  if (opts.scope === ALL_SCOPES) {
    // Best-effort + idempotent: walk every ref under REF_ROOT and delete the
    // ones matching `slug`. A per-ref failure (concurrent writer moved or
    // deleted the ref between our rev-parse and update-ref) does NOT abort
    // the loop — re-running forget after a partial converges trivially,
    // since deleted refs no longer match the slug filter.
    let out: string;
    try {
      out = sh(repo, ["for-each-ref", "--format=%(refname)", REF_ROOT]);
    } catch (e) {
      throw new RepoBrokenError(`forget: ${e instanceof Error ? e.message : String(e)}`);
    }
    const scopes: string[] = [];
    for (const ref of out.split("\n").filter(Boolean)) {
      const tail = ref.slice(REF_ROOT.length);
      const slash = tail.indexOf("/");
      if (slash < 0) continue;
      const scope = tail.slice(0, slash);
      const slug = tail.slice(slash + 1);
      if (slug !== opts.slug) continue;
      const sha = shTry(repo, ["rev-parse", "--verify", "--quiet", ref]);
      if (!sha) continue;
      try {
        sh(repo, ["update-ref", "-d", ref, sha]);
        scopes.push(scope);
      } catch {
        // Ref moved or vanished between rev-parse and update-ref. Skip and
        // keep going — caller can re-run to catch refs that materialize
        // later, and this ref is either gone or owned by a fresher writer.
      }
    }
    return { deleted: scopes.length > 0, scope: ALL_SCOPES, scopes };
  }

  const scope = opts.scope ?? currentScope(repo);
  validateScope(scope);
  const ref = refOf(scope, opts.slug);
  const sha = shTry(repo, ["rev-parse", "--verify", "--quiet", ref]);
  if (!sha) return { deleted: false, scope };
  // Race window: the ref existed at rev-parse but a concurrent writer can
  // delete or move it before update-ref lands. Stay idempotent — match the
  // ALL_SCOPES path by treating the failure as "already gone".
  try {
    sh(repo, ["update-ref", "-d", ref, sha]);
  } catch {
    return { deleted: false, scope };
  }
  return { deleted: true, scope };
}

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
  GitMemoryError,
  type GitMemoryErrorCode,
  InvalidInputError,
  NotFoundError,
  RepoBrokenError,
} from "./errors.js";

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { ConflictError, InvalidInputError, NotFoundError, RepoBrokenError } from "./errors.js";

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

/** Default limit for list(). */
export const LIST_DEFAULT_LIMIT = 50;

/** Default max age in days for list(). */
export const LIST_DEFAULT_MAX_AGE_DAYS = 30;

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

function sh(repo: string, args: readonly string[], stdin?: string, by?: string): string {
  // `by` overrides the author/committer name for this single invocation —
  // routed through env so process.env is never mutated. Falls back to
  // GIT_MEMORY_AUTHOR, then the standard git env, then the package default.
  const name = by ?? process.env.GIT_MEMORY_AUTHOR ?? process.env.GIT_AUTHOR_NAME ?? "git-memory";
  const committer =
    by ?? process.env.GIT_MEMORY_AUTHOR ?? process.env.GIT_COMMITTER_NAME ?? "git-memory";
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    input: stdin,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "agent@git-memory",
      GIT_COMMITTER_NAME: committer,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "agent@git-memory",
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

/** Find the git repository root. Respects GIT_MEMORY_REPO env var. Throws RepoBrokenError if no repo found. */
export function findRepo(start: string = process.cwd()): string {
  const env = process.env.GIT_MEMORY_REPO;
  if (env) {
    const p = resolve(env);
    // Delegate the repo check to git itself — `existsSync('${p}/HEAD')`
    // false-accepts any directory containing a stray file named HEAD. git
    // rev-parse --git-dir handles working trees, bare repos, and linked
    // worktrees uniformly.
    if (shTry(p, ["rev-parse", "--git-dir"]) === null) {
      throw new RepoBrokenError(`GIT_MEMORY_REPO points to non-repo: ${p}`);
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
// applied to auto-detected branches and GIT_MEMORY_SCOPE — never to user
// input via the API, which is validated strictly.
//
// Strict alphabet: lowercase + slash-replace, then validate against
// SCOPE_RE. Branches with `_`, `.`, `~`, `@`, etc. (all valid git refnames)
// throw InvalidInputError instead of producing a confusing "bad scope"
// error far from the source. The recovery prompt names GIT_MEMORY_SCOPE so
// the LLM has a path forward without needing to rename the branch.
function branchToScope(input: string): string {
  const normalized = input.replace(/\//g, "-").toLowerCase();
  if (!normalized || normalized.length > MAX_SCOPE || !SCOPE_RE.test(normalized)) {
    throw new InvalidInputError(
      `bad scope: '${input}' cannot normalize to [a-z0-9-] (≤${MAX_SCOPE} chars); set GIT_MEMORY_SCOPE explicitly`,
    );
  }
  return normalized;
}

/** Sentinel value to delete/list across all scopes. SCOPE_RE rejects "*" as a literal scope. */
export const ALL_SCOPES = "*";

/** Get the current scope (normalized branch name or main). Respects GIT_MEMORY_SCOPE env var. */
export function currentScope(repo: string): string {
  const env = process.env.GIT_MEMORY_SCOPE;
  if (env) {
    const s = branchToScope(env);
    validateScope(s);
    return s;
  }
  const branch = shTry(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") return TRUNK_SCOPE;
  return branchToScope(branch);
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
  /** Override commit author name. Defaults to GIT_MEMORY_AUTHOR or "git-memory". */
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

/** Save a note. Slug defaults to sha1(body)[:12]. Throws on validation failure or lock exhaustion. */
export function record(opts: RecordOpts): RecordResult {
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
      // until git gc. Sleep with jitter, then retry.
      sleepSync(1 + Math.floor(Math.random() * RETRY_JITTER_MAX_MS));
    }
  }
  throw new ConflictError(
    `record: ${scope}/${slug} contended after ${RECORD_MAX_RETRIES} retries — transient lock from concurrent writers; wait briefly and retry, or pass a different slug if you want a separate note`,
  );
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

  // De-dup by slug across scopes: the first occurrence wins (current scope before trunk).
  const seen = new Set<string>();
  const entries: ListEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const refname = parts[0] ?? "";
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
    if (seen.has(slug)) continue;
    seen.add(slug);
    entries.push({ slug, scope, h, ts: Number(ts) });
  }
  // for-each-ref sorts globally; re-sort to keep newest-first after dedup.
  entries.sort((a, b) => b.ts - a.ts);

  const maxAgeDays = opts.maxAgeDays ?? LIST_DEFAULT_MAX_AGE_DAYS;
  const filtered =
    maxAgeDays > 0
      ? entries.filter((e) => Date.now() / 1000 - e.ts <= maxAgeDays * 86400)
      : entries;
  const hidden = entries.length - filtered.length;

  const limit = opts.limit ?? LIST_DEFAULT_LIMIT;
  const capped = limit > 0 ? filtered.slice(0, limit) : filtered;
  return { entries: capped, hidden };
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

  for (const scope of tryScopes) {
    const ref = refOf(scope, opts.slug);
    if (!shTry(repo, ["rev-parse", "--verify", "--quiet", ref])) continue;
    // Race window: a concurrent forget can delete the ref between rev-parse
    // and show. Treat the failure as not-in-this-scope and let the fallback
    // loop continue — never leak the raw `fatal: ...` string.
    let body: string;
    try {
      body = sh(repo, ["show", `${ref}:note.md`]);
    } catch {
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

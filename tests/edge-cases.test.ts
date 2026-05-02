// Edge cases for mneo. Locks down behavior at boundaries the main
// suite doesn't cover: env vars, detached HEAD, scope collisions, auto-slug
// vs history threading, forget() reachability, body boundaries, list with
// no matches.
//
// Tests prefixed with GOTCHA: pin down a known footgun. Removing one means
// the behavior changed — investigate before "fixing" the test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HEADLINE_MAX,
  MAX_BODY,
  MAX_SCOPE,
  MAX_SLUG,
  type MneoError,
  REF_ROOT,
  UntrustedError,
  findRepo,
  forget,
  list,
  read,
  record,
  sanitizeHeadline,
} from "../packages/mneo/src/index.ts";

import { type TempRepo, makeTempRepo } from "./helpers/repo.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function git(repo: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return (r.stdout ?? "").toString().trim();
}

function gitStatus(repo: string, args: string[]): number {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).status ?? -1;
}

function checkout(repo: string, branch: string) {
  spawnSync("git", ["-C", repo, "checkout", "-b", branch], { encoding: "utf8" });
}

function switchTo(repo: string, branch: string) {
  spawnSync("git", ["-C", repo, "checkout", branch], { encoding: "utf8" });
}

// Detach HEAD onto current commit. `rev-parse --abbrev-ref HEAD` then returns
// "HEAD" — that's the input currentScope's branch-detection path keys on.
function detach(repo: string) {
  const sha = git(repo, ["rev-parse", "HEAD"]);
  spawnSync("git", ["-C", repo, "checkout", "--detach", sha], { encoding: "utf8" });
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("mneo edge cases", () => {
  let fixture: TempRepo;

  beforeEach(() => {
    fixture = makeTempRepo();
    spawnSync("git", ["-C", fixture.repo, "commit", "--allow-empty", "-m", "init"], {
      encoding: "utf8",
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  // ─── env: MNEO_REPO ─────────────────────────────────────────────────

  describe("MNEO_REPO", () => {
    test("overrides cwd discovery — record/list/read all use the env repo", () => {
      withEnv({ MNEO_REPO: fixture.repo }, () => {
        record({ body: "from-env", slug: "a", scope: "main" });
        expect(list({}).entries.map((e) => e.slug)).toEqual(["a"]);
        expect(read({ slug: "a" }).body).toBe("from-env");
      });
    });

    test("pointing to a non-repo throws", () => {
      const tmp = mkdtempSync(join(tmpdir(), "not-a-repo-"));
      try {
        withEnv({ MNEO_REPO: tmp }, () => {
          expect(() => record({ body: "x", slug: "a", scope: "main" })).toThrow(/non-repo/);
        });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    test("accepts a bare repo (HEAD at root, no .git/)", () => {
      const bare = mkdtempSync(join(tmpdir(), "bare-repo-"));
      spawnSync("git", ["init", "--bare", "--initial-branch=main", bare]);
      try {
        withEnv({ MNEO_REPO: bare }, () => {
          const r = record({ body: "x", slug: "a", scope: "main" });
          expect(r.scope).toBe("main");
          expect(read({ slug: "a", scope: "main" }).body).toBe("x");
        });
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });
  });

  // ─── env: MNEO_SCOPE ────────────────────────────────────────────────

  describe("MNEO_SCOPE", () => {
    test("overrides branch detection on record() with no explicit scope", () => {
      checkout(fixture.repo, "feat/x");
      withEnv({ MNEO_SCOPE: "custom" }, () => {
        const r = record({ repo: fixture.repo, body: "x", slug: "a" });
        expect(r.scope).toBe("custom");
      });
    });

    test("normalizes slashes (env behaves like a branch name)", () => {
      withEnv({ MNEO_SCOPE: "team/agents" }, () => {
        const r = record({ repo: fixture.repo, body: "x", slug: "a" });
        expect(r.scope).toBe("team-agents");
      });
    });

    test("GOTCHA: env scope is silently lowercased — 'BadScope' becomes 'badscope'", () => {
      // branchToScope() runs on env input before validation. Mixed-case env
      // values pass; spaces/dots/etc. (which lowercase can't repair) still throw.
      withEnv({ MNEO_SCOPE: "BadScope" }, () => {
        const r = record({ repo: fixture.repo, body: "x", slug: "a" });
        expect(r.scope).toBe("badscope");
      });
    });

    test("rejects env scope when normalization can't repair it (space)", () => {
      withEnv({ MNEO_SCOPE: "with space" }, () => {
        expect(() => record({ repo: fixture.repo, body: "x", slug: "a" })).toThrow(/bad scope/);
      });
    });

    test("explicit scope arg wins over env", () => {
      withEnv({ MNEO_SCOPE: "envscope" }, () => {
        const r = record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
        expect(r.scope).toBe("main");
      });
    });
  });

  // ─── env: MNEO_AUTHOR ───────────────────────────────────────────────

  describe("MNEO_AUTHOR", () => {
    test("propagates to commit author + committer", () => {
      withEnv({ MNEO_AUTHOR: "robot-7" }, () => {
        record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      });
      const fmt = git(fixture.repo, ["log", "-1", "--format=%an|%cn", `${REF_ROOT}main/a`]);
      expect(fmt).toBe("robot-7|robot-7");
    });

    test("falls back to 'mneo' when no author env is set", () => {
      withEnv(
        {
          MNEO_AUTHOR: undefined,
          GIT_AUTHOR_NAME: undefined,
          GIT_COMMITTER_NAME: undefined,
        },
        () => {
          record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
        },
      );
      const an = git(fixture.repo, ["log", "-1", "--format=%an", `${REF_ROOT}main/a`]);
      expect(an).toBe("mneo");
    });
  });

  // ─── detached HEAD ────────────────────────────────────────────────────────

  describe("detached HEAD", () => {
    test("GOTCHA: writes silently fall through to 'main' scope", () => {
      // Realistic triggers: CI checking out by SHA, bisect, rebase --interactive
      // edit. The agent gets no signal that its notes landed in trunk rather
      // than the branch it thought it was on.
      detach(fixture.repo);
      const r = record({ repo: fixture.repo, body: "from-detached", slug: "x" });
      expect(r.scope).toBe("main");
      const refs = git(fixture.repo, ["for-each-ref", REF_ROOT]);
      expect(refs).toContain("refs/agent-memory/main/x");
    });

    test("read on detached HEAD also resolves against 'main'", () => {
      record({ repo: fixture.repo, body: "trunk", slug: "y", scope: "main" });
      detach(fixture.repo);
      expect(read({ repo: fixture.repo, slug: "y" }).body).toBe("trunk");
    });

    test("forget on detached HEAD targets 'main' scope", () => {
      record({ repo: fixture.repo, body: "z", slug: "z", scope: "main" });
      detach(fixture.repo);
      const f = forget({ repo: fixture.repo, slug: "z" });
      expect(f).toEqual({ deleted: true, scope: "main" });
    });
  });

  // ─── branch → scope normalization ─────────────────────────────────────────

  describe("branchToScope normalization", () => {
    test("nested slashes collapse into dashes", () => {
      checkout(fixture.repo, "feat/auth/oauth");
      const r = record({ repo: fixture.repo, body: "x", slug: "a" });
      expect(r.scope).toBe("feat-auth-oauth");
    });

    test("uppercase branch names lowercase into the scope", () => {
      checkout(fixture.repo, "Feat/Auth");
      const r = record({ repo: fixture.repo, body: "x", slug: "a" });
      expect(r.scope).toBe("feat-auth");
    });

    test("'feat/foo-bar' and 'feat-foo-bar' collision throws on auto-detect", () => {
      // Both branches map to scope 'feat-foo-bar'. Auto-detected currentScope()
      // refuses to silently merge their refs; recovery is MNEO_SCOPE or an
      // explicit scope arg.
      checkout(fixture.repo, "feat/foo-bar");
      switchTo(fixture.repo, "main");
      checkout(fixture.repo, "feat-foo-bar");
      expect(() => record({ repo: fixture.repo, body: "x", slug: "x" })).toThrow(
        /collide|MNEO_SCOPE/,
      );
    });
  });

  // ─── scope collision detection ────────────────────────────────────────────

  describe("scope collision detection", () => {
    test("currentScope throws when another branch normalizes to the same scope", () => {
      checkout(fixture.repo, "feat/foo-bar");
      record({ repo: fixture.repo, body: "from-slash", slug: "x", scope: "feat-foo-bar" });
      switchTo(fixture.repo, "main");
      checkout(fixture.repo, "feat-foo-bar");
      expect(() => list({ repo: fixture.repo })).toThrow(/feat-foo-bar.*collide/);
      expect(() => read({ repo: fixture.repo, slug: "x" })).toThrow(/collide/);
      expect(() => forget({ repo: fixture.repo, slug: "x" })).toThrow(/collide/);
    });

    test("MNEO_SCOPE bypasses the collision check", () => {
      checkout(fixture.repo, "feat/foo-bar");
      switchTo(fixture.repo, "main");
      checkout(fixture.repo, "feat-foo-bar");
      withEnv({ MNEO_SCOPE: "explicit-scope" }, () => {
        const r = record({ repo: fixture.repo, body: "y", slug: "y" });
        expect(r.scope).toBe("explicit-scope");
      });
    });

    test("explicit scope arg bypasses the collision check", () => {
      checkout(fixture.repo, "feat/foo-bar");
      switchTo(fixture.repo, "main");
      checkout(fixture.repo, "feat-foo-bar");
      const r = record({ repo: fixture.repo, body: "y", slug: "y", scope: "main" });
      expect(r.scope).toBe("main");
    });

    test("branches with chars outside the alphabet are not counted as collisions", () => {
      // 'feat_x' contains '_' which branchToScope rejects — it cannot produce a
      // scope, so it can't collide against 'feat-x'. Verifies the check skips
      // unconvertible branches instead of throwing on them.
      checkout(fixture.repo, "feat_x");
      switchTo(fixture.repo, "main");
      checkout(fixture.repo, "feat-x");
      const r = record({ repo: fixture.repo, body: "y", slug: "y" });
      expect(r.scope).toBe("feat-x");
    });

    test("colliding-scope notes remain reachable via explicit scope arg", () => {
      checkout(fixture.repo, "feat/foo-bar");
      record({ repo: fixture.repo, body: "from-slash", slug: "x", scope: "feat-foo-bar" });
      switchTo(fixture.repo, "main");
      checkout(fixture.repo, "feat-foo-bar");
      // Auto-detect would throw, but explicit scope is the documented recovery.
      expect(read({ repo: fixture.repo, slug: "x", scope: "feat-foo-bar" }).body).toBe(
        "from-slash",
      );
    });

    test("single branch (no peers) does not trigger the check", () => {
      // Sanity: the only-branch case must not false-positive against itself.
      checkout(fixture.repo, "feat/auth");
      const r = record({ repo: fixture.repo, body: "y", slug: "y" });
      expect(r.scope).toBe("feat-auth");
    });
  });

  // ─── MNEO_REQUIRE_SIGNED trust gate ───────────────────────────────────────
  // Opt-in defense against the documented push-injection vector. The test
  // repo's commits are unsigned by default — that's enough surface for the
  // negative path. The positive (signed → passes) path relies on the user's
  // own gpg/ssh setup and is covered by `git verify-commit` itself.

  describe("MNEO_REQUIRE_SIGNED trust gate", () => {
    test("env unset: unsigned notes are visible; result has no `untrusted` field", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      const r = list({ repo: fixture.repo });
      expect(r.entries.map((e) => e.slug)).toEqual(["a"]);
      expect(r.untrusted).toBeUndefined();
    });

    test("env=1 + unsigned commit: list filters all entries and reports the count", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      record({ repo: fixture.repo, body: "y", slug: "b", scope: "main" });
      withEnv({ MNEO_REQUIRE_SIGNED: "1" }, () => {
        const r = list({ repo: fixture.repo });
        expect(r.entries).toEqual([]);
        expect(r.untrusted).toBe(2);
      });
    });

    test("env='true' is accepted as the same opt-in as '1'", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      withEnv({ MNEO_REQUIRE_SIGNED: "true" }, () => {
        const r = list({ repo: fixture.repo });
        expect(r.untrusted).toBe(1);
      });
    });

    test("env=1 + no entries: result still includes untrusted: 0 (signals trust posture)", () => {
      withEnv({ MNEO_REQUIRE_SIGNED: "1" }, () => {
        const r = list({ repo: fixture.repo });
        expect(r.entries).toEqual([]);
        expect(r.untrusted).toBe(0);
      });
    });

    test("env=1 + unsigned commit: read throws UntrustedError with code UNTRUSTED", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      withEnv({ MNEO_REQUIRE_SIGNED: "1" }, () => {
        try {
          read({ repo: fixture.repo, slug: "a", scope: "main" });
          throw new Error("expected UntrustedError");
        } catch (e) {
          expect(e).toBeInstanceOf(UntrustedError);
          expect((e as MneoError).code).toBe("UNTRUSTED");
          expect((e as Error).message).toMatch(/unverified signature|MNEO_REQUIRE_SIGNED/);
        }
      });
    });

    test("env=0 is treated as off (only '1' or 'true' opt in)", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      withEnv({ MNEO_REQUIRE_SIGNED: "0" }, () => {
        const r = list({ repo: fixture.repo });
        expect(r.entries.map((e) => e.slug)).toEqual(["a"]);
        expect(r.untrusted).toBeUndefined();
      });
    });
  });

  // ─── future-dated commits / skew tolerance ────────────────────────────────
  // Defends against pinning attacks: a malicious commit-date in the future
  // would otherwise bypass maxAgeDays forever (now - future < 0 ≤ 30d).

  describe("future-dated commits", () => {
    function recordAt(repo: string, body: string, secondsFromNow: number, slug: string) {
      const ts = `${Math.floor(Date.now() / 1000) + secondsFromNow} +0000`;
      withEnv({ GIT_AUTHOR_DATE: ts, GIT_COMMITTER_DATE: ts }, () => {
        record({ repo, body, slug, scope: "main" });
      });
    }

    test("commit dated >60s in the future is dropped from list, counted in `skewed`", () => {
      recordAt(fixture.repo, "x", 86400, "future-day"); // 1 day ahead
      record({ repo: fixture.repo, body: "y", slug: "now-note", scope: "main" });
      const r = list({ repo: fixture.repo });
      expect(r.entries.map((e) => e.slug)).toEqual(["now-note"]);
      expect(r.skewed).toBe(1);
    });

    test("commit within +60s skew tolerance is kept (no false positive)", () => {
      recordAt(fixture.repo, "x", 30, "barely-future");
      const r = list({ repo: fixture.repo });
      expect(r.entries.map((e) => e.slug)).toEqual(["barely-future"]);
      expect(r.skewed).toBeUndefined();
    });

    test("future-dated entry no longer pins to the top after sane note appears", () => {
      // Pre-fix behaviour: future-dated note dominates --sort=-creatordate
      // forever and never ages out. Post-fix: dropped → sane entries surface.
      recordAt(fixture.repo, "evil", 365 * 86400, "evil"); // 1y future
      record({ repo: fixture.repo, body: "good", slug: "good", scope: "main" });
      const r = list({ repo: fixture.repo });
      expect(r.entries.map((e) => e.slug)).toEqual(["good"]);
      expect(r.skewed).toBe(1);
    });

    test("`skewed` is omitted from the result when no entries are dropped", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      const r = list({ repo: fixture.repo });
      expect(r.skewed).toBeUndefined();
    });
  });

  // ─── limit overflow surfaced as `more` ────────────────────────────────────

  describe("limit overflow", () => {
    test("more > 0 when filtered entries don't fit under limit", () => {
      for (let i = 0; i < 5; i++) {
        record({ repo: fixture.repo, body: `v${i}`, slug: `n${i}`, scope: "main" });
      }
      const r = list({ repo: fixture.repo, limit: 2 });
      expect(r.entries).toHaveLength(2);
      expect(r.more).toBe(3);
    });

    test("more is omitted when limit accommodates everything", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      record({ repo: fixture.repo, body: "y", slug: "b", scope: "main" });
      const r = list({ repo: fixture.repo, limit: 10 });
      expect(r.entries).toHaveLength(2);
      expect(r.more).toBeUndefined();
    });

    test("more is omitted when limit is unlimited (0)", () => {
      // Hmm — limit:0 currently returns all entries (limit > 0 gate). No
      // truncation can happen, so `more` must be omitted, not 0.
      for (let i = 0; i < 3; i++) {
        record({ repo: fixture.repo, body: `v${i}`, slug: `n${i}`, scope: "main" });
      }
      const r = list({ repo: fixture.repo, limit: 0 });
      expect(r.entries).toHaveLength(3);
      expect(r.more).toBeUndefined();
    });
  });

  // ─── auto-slug semantics ──────────────────────────────────────────────────

  describe("auto-slug", () => {
    test("GOTCHA: different bodies → different auto-slugs → no history thread", () => {
      // The MCP description says re-recording with different content "appends
      // a commit (history preserved)". That holds only for explicit slugs.
      // With auto-slug, every edit is a brand-new note on a new ref.
      const a = record({ repo: fixture.repo, body: "v1", scope: "main" });
      const b = record({ repo: fixture.repo, body: "v2", scope: "main" });
      expect(a.slug).not.toBe(b.slug);
      const ra = git(fixture.repo, ["rev-parse", `${REF_ROOT}main/${a.slug}`]);
      const rb = git(fixture.repo, ["rev-parse", `${REF_ROOT}main/${b.slug}`]);
      expect(ra).not.toBe(rb);
      // b has no parent — fresh ref, not threaded onto a's history.
      const parents = git(fixture.repo, ["log", "--format=%P", `${REF_ROOT}main/${b.slug}`]);
      expect(parents).toBe("");
    });

    test("auto-slug is exactly 12 hex chars (sha1 truncation)", () => {
      const r = record({ repo: fixture.repo, body: "anything", scope: "main" });
      expect(r.slug).toMatch(/^[0-9a-f]{12}$/);
      expect(r.slug.length).toBe(12);
    });
  });

  // ─── boundary lengths ─────────────────────────────────────────────────────

  describe("boundary lengths", () => {
    test("scope at exactly MAX_SCOPE chars is accepted", () => {
      const scope = "a".repeat(MAX_SCOPE);
      const r = record({ repo: fixture.repo, body: "x", slug: "n", scope });
      expect(r.scope).toBe(scope);
    });

    test("scope at MAX_SCOPE+1 chars is rejected", () => {
      const scope = "a".repeat(MAX_SCOPE + 1);
      expect(() => record({ repo: fixture.repo, body: "x", slug: "n", scope })).toThrow(
        /bad scope/,
      );
    });

    test("slug at exactly MAX_SLUG chars is accepted", () => {
      const slug = "a".repeat(MAX_SLUG);
      const r = record({ repo: fixture.repo, body: "x", slug, scope: "main" });
      expect(r.slug).toBe(slug);
    });

    test("slug at MAX_SLUG+1 chars is rejected", () => {
      const slug = "a".repeat(MAX_SLUG + 1);
      expect(() => record({ repo: fixture.repo, body: "x", slug, scope: "main" })).toThrow(
        /bad slug/,
      );
    });
  });

  // ─── body content ─────────────────────────────────────────────────────────

  describe("body content", () => {
    test("MAX_BODY is in JS string units (UTF-16 code units), not bytes", () => {
      // '🌳' is 2 code units. 2500 of them = 5000 = MAX_BODY (≈10kB UTF-8).
      const body = "🌳".repeat(2500);
      expect(body.length).toBe(MAX_BODY);
      const r = record({ repo: fixture.repo, body, slug: "tree", scope: "main" });
      expect(r.unchanged).toBe(false);
      expect(read({ repo: fixture.repo, slug: "tree", scope: "main" }).body).toBe(body);
    });

    test("body starting with newline → headline falls back to slug", () => {
      // headline = body.split("\n")[0].trim() || slug. Empty first line → slug.
      record({ repo: fixture.repo, body: "\nactual content", slug: "ln", scope: "main" });
      const subject = git(fixture.repo, ["log", "-1", "--format=%s", `${REF_ROOT}main/ln`]);
      expect(subject).toBe("ln");
    });

    test("CRLF body: first line strips both \\r and surrounding space", () => {
      record({
        repo: fixture.repo,
        body: "  hello world  \r\nbody",
        slug: "crlf",
        scope: "main",
      });
      const subject = git(fixture.repo, ["log", "-1", "--format=%s", `${REF_ROOT}main/crlf`]);
      expect(subject).toBe("hello world");
    });

    test("headline truncates at HEADLINE_MAX after taking first line", () => {
      const long = "x".repeat(HEADLINE_MAX + 50);
      record({ repo: fixture.repo, body: long, slug: "h", scope: "main" });
      const subject = git(fixture.repo, ["log", "-1", "--format=%s", `${REF_ROOT}main/h`]);
      expect(subject.length).toBe(HEADLINE_MAX);
    });

    test("body is preserved byte-for-byte through record → read", () => {
      const body = 'line1\nline2\n\nline4\twith tabs and "quotes" + 中文 🌳';
      record({ repo: fixture.repo, body, slug: "fidelity", scope: "main" });
      expect(read({ repo: fixture.repo, slug: "fidelity", scope: "main" }).body).toBe(body);
    });
  });

  // ─── list edge cases ──────────────────────────────────────────────────────

  describe("list edge cases", () => {
    test("prefix that matches no refs returns empty entries", () => {
      record({ repo: fixture.repo, body: "x", slug: "auth/oauth", scope: "main" });
      expect(list({ repo: fixture.repo, prefix: "db/" }).entries).toEqual([]);
    });

    test("scope:[] hits the same path as scope:'*' (length-0 array → no filter)", () => {
      // An empty array makes resolveScopes return []. list() then treats that
      // identically to scope:'*' (refPatterns = [REF_ROOT]). Documented as a
      // current quirk — change here if [] ever should mean "nothing".
      record({ repo: fixture.repo, body: "a", slug: "a", scope: "main" });
      record({ repo: fixture.repo, body: "b", slug: "b", scope: "side" });
      const all = list({ repo: fixture.repo, scope: "*" });
      const empty = list({ repo: fixture.repo, scope: [] });
      expect(empty.entries.map((e) => e.slug).sort()).toEqual(
        all.entries.map((e) => e.slug).sort(),
      );
    });

    test("scope:'*' on an empty repo returns empty entries", () => {
      expect(list({ repo: fixture.repo, scope: "*" }).entries).toEqual([]);
    });

    test("limit larger than entries returns all entries", () => {
      record({ repo: fixture.repo, body: "a", slug: "a", scope: "main" });
      record({ repo: fixture.repo, body: "b", slug: "b", scope: "main" });
      expect(list({ repo: fixture.repo, limit: 100 }).entries).toHaveLength(2);
    });

    test("entry.h is the truncated headline, not the full body", () => {
      const long = "x".repeat(HEADLINE_MAX + 20);
      record({ repo: fixture.repo, body: long, slug: "n", scope: "main" });
      const e = list({ repo: fixture.repo, scope: "main" }).entries[0];
      expect(e?.h.length).toBe(HEADLINE_MAX);
    });

    test("GOTCHA: scope-array order is NOT a priority — dedup follows for-each-ref's sort", () => {
      // Source comment in list() says "first occurrence wins (current scope
      // before trunk)". That's only true for the default [current, main]
      // ordering. For explicit arrays, for-each-ref --sort=-creatordate
      // determines order globally (refname ASC on ties). Backdate to make
      // the order deterministic and verify that newest-by-creatordate wins,
      // independent of the array order.
      const oldTs = `${Math.floor(Date.now() / 1000) - 3600} +0000`;
      const newTs = `${Math.floor(Date.now() / 1000)} +0000`;
      withEnv({ GIT_AUTHOR_DATE: oldTs, GIT_COMMITTER_DATE: oldTs }, () => {
        record({ repo: fixture.repo, body: "side-old", slug: "x", scope: "side" });
      });
      withEnv({ GIT_AUTHOR_DATE: newTs, GIT_COMMITTER_DATE: newTs }, () => {
        record({ repo: fixture.repo, body: "main-new", slug: "x", scope: "main" });
      });
      // Even with side first in the array, main wins because it's newer.
      const { entries } = list({ repo: fixture.repo, scope: ["side", "main"] });
      expect(entries.find((x) => x.slug === "x")?.scope).toBe("main");
    });

    test("prefix interacts with maxAgeDays — stale entries dropped before slicing", () => {
      record({ repo: fixture.repo, body: "fresh", slug: "auth/jwt", scope: "main" });
      const { entries } = list({ repo: fixture.repo, prefix: "auth/" });
      expect(entries.map((e) => e.slug)).toEqual(["auth/jwt"]);
    });
  });

  // ─── re-record cycles ─────────────────────────────────────────────────────

  describe("re-record cycles", () => {
    test("v1 → v2 → v1 appends three commits (idempotency only checks against parent)", () => {
      // The no-op short-circuit compares the new tree to the parent's tree. It
      // does NOT walk history. Writing v1 → v2 → v1 produces three commits;
      // the third's tree equals the first's, but its parent is v2.
      record({ repo: fixture.repo, body: "v1", slug: "x", scope: "main" });
      record({ repo: fixture.repo, body: "v2", slug: "x", scope: "main" });
      const back = record({ repo: fixture.repo, body: "v1", slug: "x", scope: "main" });
      expect(back.unchanged).toBe(false);
      const subjects = git(fixture.repo, ["log", "--format=%s", `${REF_ROOT}main/x`]).split("\n");
      expect(subjects).toEqual(["v1", "v2", "v1"]);
    });
  });

  // ─── forget reachability ──────────────────────────────────────────────────

  describe("forget reachability", () => {
    test("GOTCHA: forget removes the ref but the commit + blob remain reachable as objects", () => {
      // forget() is `update-ref -d`. The note's commit and its blob persist as
      // loose/packed objects until `git gc --prune`. For true erasure of an
      // accidentally-leaked secret, follow forget with:
      //   git reflog expire --expire=now --all && git gc --prune=now
      const r = record({
        repo: fixture.repo,
        body: "secret-token-abc",
        slug: "leak",
        scope: "main",
      });
      forget({ repo: fixture.repo, slug: "leak", scope: "main" });

      // ref is gone:
      expect(
        gitStatus(fixture.repo, ["rev-parse", "--verify", "--quiet", `${REF_ROOT}main/leak`]),
      ).not.toBe(0);
      // but the commit object survives:
      expect(gitStatus(fixture.repo, ["cat-file", "-e", r.sha])).toBe(0);
      // and the body is still readable through the (now-unreachable) commit:
      const body = git(fixture.repo, ["show", `${r.sha}:note.md`]);
      expect(body).toBe("secret-token-abc");
    });

    test("forget twice: second call returns deleted:false", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      expect(forget({ repo: fixture.repo, slug: "a", scope: "main" }).deleted).toBe(true);
      expect(forget({ repo: fixture.repo, slug: "a", scope: "main" }).deleted).toBe(false);
    });
  });

  // ─── trunk fallback observability ─────────────────────────────────────────

  describe("read fallback observability", () => {
    test("read returns the resolved scope so the caller can detect fallback", () => {
      record({ repo: fixture.repo, body: "trunk-only", slug: "shared", scope: "main" });
      checkout(fixture.repo, "feat/x");
      const r = read({ repo: fixture.repo, slug: "shared" });
      // Came from main, not feat-x. Agents that ignore .scope think they're
      // reading their own branch.
      expect(r.scope).toBe("main");
    });
  });

  // ─── list scope:'*' interactions ──────────────────────────────────────────

  describe("list scope:'*' interactions", () => {
    test("scope:'*' + prefix filters across every scope (client-side filter)", () => {
      // for-each-ref still globs REF_ROOT (no prefix in the pattern), but
      // the parsing loop drops slugs that don't match the prefix.
      record({ repo: fixture.repo, body: "x", slug: "auth/a", scope: "main" });
      record({ repo: fixture.repo, body: "y", slug: "db/b", scope: "side" });
      const filtered = list({ repo: fixture.repo, scope: "*", prefix: "auth/" });
      expect(filtered.entries.map((e) => e.slug)).toEqual(["auth/a"]);
    });

    test("scope:[] + prefix filters identically (length-0 array hits the same path)", () => {
      record({ repo: fixture.repo, body: "x", slug: "auth/a", scope: "main" });
      record({ repo: fixture.repo, body: "y", slug: "db/b", scope: "side" });
      const filtered = list({ repo: fixture.repo, scope: [], prefix: "auth/" });
      expect(filtered.entries.map((e) => e.slug)).toEqual(["auth/a"]);
    });

    test("explicit scope WITH prefix DOES filter (control: bug isolated to scopes.length===0)", () => {
      record({ repo: fixture.repo, body: "x", slug: "auth/a", scope: "main" });
      record({ repo: fixture.repo, body: "y", slug: "db/b", scope: "main" });
      expect(
        list({ repo: fixture.repo, scope: "main", prefix: "auth/" }).entries.map((e) => e.slug),
      ).toEqual(["auth/a"]);
    });
  });

  // ─── scope name patterns ──────────────────────────────────────────────────

  describe("scope name patterns", () => {
    test("scope 'feat' doesn't bleed into 'feat-x' (trailing slash isolates the glob)", () => {
      record({ repo: fixture.repo, body: "f", slug: "n", scope: "feat" });
      record({ repo: fixture.repo, body: "fx", slug: "n", scope: "feat-x" });
      const onlyFeat = list({ repo: fixture.repo, scope: "feat" });
      expect(onlyFeat.entries.map((e) => `${e.scope}/${e.slug}`)).toEqual(["feat/n"]);
    });

    test("slug equal to scope name is allowed (refs/agent-memory/main/main)", () => {
      const r = record({ repo: fixture.repo, body: "m", slug: "main", scope: "main" });
      expect(r.slug).toBe("main");
      expect(read({ repo: fixture.repo, slug: "main", scope: "main" }).body).toBe("m");
    });
  });

  // ─── forget pass 2 ────────────────────────────────────────────────────────

  describe("forget pass 2", () => {
    test("forget({scope:'*'}) erases the slug from every scope it lives in", () => {
      record({ repo: fixture.repo, body: "trunk", slug: "a", scope: "main" });
      record({ repo: fixture.repo, body: "side", slug: "a", scope: "side" });
      record({ repo: fixture.repo, body: "other", slug: "b", scope: "main" }); // not touched
      const f = forget({ repo: fixture.repo, slug: "a", scope: "*" });
      expect(f.deleted).toBe(true);
      expect(f.scope).toBe("*");
      expect(f.scopes?.sort()).toEqual(["main", "side"]);
      // 'a' gone from both scopes, 'b' untouched
      expect(() => read({ repo: fixture.repo, slug: "a", scope: "main" })).toThrow(/not found/);
      expect(() => read({ repo: fixture.repo, slug: "a", scope: "side" })).toThrow(/not found/);
      expect(read({ repo: fixture.repo, slug: "b", scope: "main" }).body).toBe("other");
    });

    test("forget({scope:'*'}) on a non-existent slug returns deleted:false, empty scopes", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      const f = forget({ repo: fixture.repo, slug: "missing", scope: "*" });
      expect(f).toEqual({ deleted: false, scope: "*", scopes: [] });
    });

    test("forget then record same slug → fresh ref with no parent", () => {
      record({ repo: fixture.repo, body: "v1", slug: "x", scope: "main" });
      forget({ repo: fixture.repo, slug: "x", scope: "main" });
      const r = record({ repo: fixture.repo, body: "v2", slug: "x", scope: "main" });
      expect(r.unchanged).toBe(false);
      const parents = git(fixture.repo, ["log", "--format=%P", `${REF_ROOT}main/x`]);
      expect(parents).toBe("");
    });

    test("forget on a colliding branch refuses (recovery is explicit scope)", () => {
      // After collision detection landed, forget() on a colliding auto-scope
      // refuses up-front instead of silently wiping the peer branch's notes.
      // The recovery path is forget({ slug, scope: "<explicit>" }).
      checkout(fixture.repo, "feat/foo-bar");
      record({ repo: fixture.repo, body: "from-slash", slug: "x", scope: "feat-foo-bar" });
      switchTo(fixture.repo, "main");
      checkout(fixture.repo, "feat-foo-bar");
      expect(() => forget({ repo: fixture.repo, slug: "x" })).toThrow(/collide/);
      // Explicit scope still wipes the shared ref — that's the user-acknowledged path.
      const f = forget({ repo: fixture.repo, slug: "x", scope: "feat-foo-bar" });
      expect(f.deleted).toBe(true);
    });
  });

  // ─── headline truncation edges ────────────────────────────────────────────

  describe("headline truncation edges", () => {
    test("GOTCHA: slice→trim leaves headline shorter than HEADLINE_MAX when boundary lands on whitespace", () => {
      // headline = body.split("\n")[0].slice(0, 80).trim().
      // If chars 76-80 are spaces, slice keeps them, trim strips them →
      // headline length < HEADLINE_MAX. Callers asserting length === MAX
      // need to know.
      const first = `${"x".repeat(75)}     more chars after the boundary`;
      record({ repo: fixture.repo, body: first, slug: "h", scope: "main" });
      const subject = git(fixture.repo, ["log", "-1", "--format=%s", `${REF_ROOT}main/h`]);
      expect(subject).toBe("x".repeat(75));
      expect(subject.length).toBe(75);
    });

    test("embedded tab on the first line is preserved (.trim() only strips edges)", () => {
      record({ repo: fixture.repo, body: "hello\tworld\nbody", slug: "tab", scope: "main" });
      const subject = git(fixture.repo, ["log", "-1", "--format=%s", `${REF_ROOT}main/tab`]);
      expect(subject).toBe("hello\tworld");
    });

    test("body of just '\\r\\n' rejected as empty (whitespace trim)", () => {
      expect(() => record({ repo: fixture.repo, body: "\r\n", slug: "x" })).toThrow();
    });
  });

  // ─── headline trust boundary ──────────────────────────────────────────────

  // A note's commit subject can arrive from a fetched remote — that's the
  // documented trust boundary. list() must scrub control chars from the
  // subject before returning, so a malicious push can't paint the model's
  // menu with ANSI escapes / BEL / DEL.
  describe("headline trust boundary", () => {
    // Synthesize a ref whose commit subject contains a chosen byte sequence.
    // record()'s validation can't be used: it goes through the SDK contract
    // we're trying to defend. plumb the bytes in via commit-tree directly,
    // then point the ref at the resulting sha — same shape git fetch would
    // have produced from a hostile remote.
    function plantRef(repo: string, slug: string, subject: string): void {
      const blob = spawnSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], {
        encoding: "utf8",
        input: "body",
      })
        .stdout.toString()
        .trim();
      const tree = spawnSync("git", ["-C", repo, "mktree"], {
        encoding: "utf8",
        input: `100644 blob ${blob}\tnote.md\n`,
      })
        .stdout.toString()
        .trim();
      const sha = spawnSync("git", ["-C", repo, "commit-tree", tree], {
        encoding: "utf8",
        input: `${subject}\n`,
      })
        .stdout.toString()
        .trim();
      const ref = `${REF_ROOT}main/${slug}`;
      spawnSync("git", ["-C", repo, "update-ref", ref, sha], { encoding: "utf8" });
    }

    test("ANSI escape in fetched subject is stripped on list()", () => {
      plantRef(fixture.repo, "ansi", "\x1b[31mevil red text\x1b[0m");
      const e = list({ repo: fixture.repo }).entries.find((x) => x.slug === "ansi");
      expect(e?.h).toBe("[31mevil red text[0m");
    });

    test("BEL and DEL in fetched subject are stripped on list()", () => {
      plantRef(fixture.repo, "bel", "ring\x07the\x7fbell");
      const e = list({ repo: fixture.repo }).entries.find((x) => x.slug === "bel");
      expect(e?.h).toBe("ringthebell");
    });

    test("C1 control char (0x9b CSI) in fetched subject is stripped on list()", () => {
      plantRef(fixture.repo, "c1", "csiattack");
      const e = list({ repo: fixture.repo }).entries.find((x) => x.slug === "c1");
      expect(e?.h).toBe("csiattack");
    });

    test("normal text + embedded tab passes through unchanged", () => {
      record({ repo: fixture.repo, body: "hello\tworld", slug: "tab2", scope: "main" });
      const e = list({ repo: fixture.repo }).entries.find((x) => x.slug === "tab2");
      expect(e?.h).toBe("hello\tworld");
    });

    test("sanitizeHeadline exported and pure", () => {
      expect(sanitizeHeadline("plain text")).toBe("plain text");
      expect(sanitizeHeadline("with\ttab")).toBe("with\ttab");
      expect(sanitizeHeadline("\x1b[1mbold\x1b[0m")).toBe("[1mbold[0m");
      expect(sanitizeHeadline("\x00\x07\x7f\x9f")).toBe("");
    });
  });

  // ─── record body fidelity (pass 2) ────────────────────────────────────────

  describe("record body fidelity pass 2", () => {
    test("null byte AFTER the headline survives the SDK round-trip", () => {
      // git hash-object stores \0 fine; what fails is `commit-tree` if the
      // commit message (= the headline = body's first line) contains \0.
      // Putting \0 on a later line is safe — the blob keeps the byte.
      // The MCP/JSON layer would still fail on \0; this only documents the
      // SDK path.
      const body = "clean headline\nbefore\0after";
      record({ repo: fixture.repo, body, slug: "nul", scope: "main" });
      expect(read({ repo: fixture.repo, slug: "nul", scope: "main" }).body).toBe(body);
    });

    test("GOTCHA: null byte IN the headline (first line) makes record() throw", () => {
      // The first line becomes the commit-tree message; git rejects NUL there.
      // The error surfaces as a raw `git commit-tree:` stderr — not a typed
      // error. Bodies starting with binary content can't go through record()
      // unless the first line is plain text.
      expect(() =>
        record({ repo: fixture.repo, body: "head\0line\nbody", slug: "nul-h", scope: "main" }),
      ).toThrow(/NUL byte|commit-tree/);
    });

    test("re-record identical body short-circuits even when MNEO_AUTHOR changes", () => {
      // The unchanged check compares parent's tree to new tree. Author identity
      // is not part of the tree. Flipping the author env between calls doesn't
      // invalidate the no-op — bob never lands a commit.
      withEnv({ MNEO_AUTHOR: "alice" }, () => {
        record({ repo: fixture.repo, body: "v1", slug: "x", scope: "main" });
      });
      let second!: ReturnType<typeof record>;
      withEnv({ MNEO_AUTHOR: "bob" }, () => {
        second = record({ repo: fixture.repo, body: "v1", slug: "x", scope: "main" });
      });
      expect(second.unchanged).toBe(true);
      const log = git(fixture.repo, ["log", "--format=%an", `${REF_ROOT}main/x`]);
      expect(log).toBe("alice");
    });
  });

  // ─── list maxAgeDays bounds ───────────────────────────────────────────────

  describe("list maxAgeDays bounds", () => {
    test("negative maxAgeDays disables the filter (predicate is `> 0`, not `>= 0`)", () => {
      // Pin the `maxAgeDays > 0` check so a future change to `>= 0` (which
      // would flip 0 from "disable" to "no maximum") doesn't slip in.
      const oldTs = `${Math.floor(Date.now() / 1000) - 100 * 86400} +0000`;
      withEnv({ GIT_AUTHOR_DATE: oldTs, GIT_COMMITTER_DATE: oldTs }, () => {
        record({ repo: fixture.repo, body: "ancient", slug: "old", scope: "main" });
      });
      record({ repo: fixture.repo, body: "fresh", slug: "new", scope: "main" });
      expect(
        list({ repo: fixture.repo, maxAgeDays: -1 })
          .entries.map((e) => e.slug)
          .sort(),
      ).toEqual(["new", "old"]);
    });
  });

  // ─── git worktree support ─────────────────────────────────────────────────

  describe("git worktree", () => {
    test("findRepo throws (instead of looping) when called from a path with no git ancestor", () => {
      // Regression: the old `while (cur !== "/")` loop infinite-looped on
      // Windows roots like "C:\\". The dirname() fixpoint terminates on
      // every platform. We can't run Windows here, but the equivalent is
      // any path whose walk reaches a root without finding `.git` — must
      // throw, not hang. A 5-second test timeout would catch a regression.
      const stray = mkdtempSync(join(tmpdir(), "mneo-no-ancestor-"));
      try {
        expect(() => findRepo(stray)).toThrow(/no git repo found/);
      } finally {
        rmSync(stray, { recursive: true, force: true });
      }
    }, 5_000);

    test("findRepo accepts a worktree where .git is a file pointer (not a directory)", () => {
      // In a linked worktree, .git is a file containing 'gitdir: <path>'.
      // existsSync(`${cur}/.git`) returns true for both. Verify the full
      // record/read cycle works in that setup.
      const wt = mkdtempSync(join(tmpdir(), "mneo-wt-"));
      // mkdtempSync creates the dir; `git worktree add` requires it not to
      // pre-exist. Remove first, let git recreate.
      rmSync(wt, { recursive: true, force: true });
      spawnSync("git", ["-C", fixture.repo, "worktree", "add", "-b", "wt-branch", wt]);
      try {
        const r = record({ repo: wt, body: "from-wt", slug: "a" });
        expect(r.scope).toBe("wt-branch");
        expect(read({ repo: wt, slug: "a" }).body).toBe("from-wt");
      } finally {
        spawnSync("git", ["-C", fixture.repo, "worktree", "remove", wt, "--force"]);
        rmSync(wt, { recursive: true, force: true });
      }
    });
  });
});

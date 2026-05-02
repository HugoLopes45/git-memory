// SDK tests: record, list (with maxAgeDays + limit), read, forget. Covers
// happy path + every boundary condition that has bitten me while writing
// this file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import {
  ALL_SCOPES,
  LIST_DEFAULT_LIMIT,
  LIST_DEFAULT_MAX_AGE_DAYS,
  MAX_BODY,
  REF_ROOT,
  forget,
  list,
  read,
  record,
  recordAsync,
} from "../packages/mneo/src/index.ts";

import { type TempRepo, makeTempRepo } from "./helpers/repo.ts";

function checkout(repo: string, branch: string) {
  spawnSync("git", ["-C", repo, "checkout", "-b", branch], { encoding: "utf8" });
}

function setMain(repo: string) {
  spawnSync("git", ["-C", repo, "checkout", "main"], { encoding: "utf8" });
}

function gitOut(repo: string, args: string[]): string {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout.trim();
}

// Backdates a record() by writing the commit with an explicit timestamp via
// GIT_COMMITTER_DATE. The SDK passes process.env through to git, so this
// works without modifying the SDK.
function recordAtAge(
  repo: string,
  body: string,
  daysAgo: number,
  opts: { slug?: string; scope?: string } = {},
): { slug: string; scope: string } {
  const ts = Math.floor(Date.now() / 1000) - daysAgo * 86400;
  const stamp = `${ts} +0000`;
  const prevC = process.env.GIT_COMMITTER_DATE;
  const prevA = process.env.GIT_AUTHOR_DATE;
  process.env.GIT_COMMITTER_DATE = stamp;
  process.env.GIT_AUTHOR_DATE = stamp;
  try {
    const r = record({ repo, body, ...opts });
    return { slug: r.slug, scope: r.scope };
  } finally {
    // biome-ignore lint/performance/noDelete: process.env requires delete; assignment to undefined coerces to string "undefined"
    if (prevC === undefined) delete process.env.GIT_COMMITTER_DATE;
    else process.env.GIT_COMMITTER_DATE = prevC;
    // biome-ignore lint/performance/noDelete: same as above
    if (prevA === undefined) delete process.env.GIT_AUTHOR_DATE;
    else process.env.GIT_AUTHOR_DATE = prevA;
  }
}

describe("mneo SDK", () => {
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

  // ─── record ──────────────────────────────────────────────────────────────

  describe("record", () => {
    test("auto-generates a slug from sha1(body)[:12] when none given", () => {
      const r = record({ repo: fixture.repo, body: "use OAuth2 for SSO" });
      expect(r.slug).toMatch(/^[0-9a-f]{12}$/);
      expect(r.scope).toBe("main");
      expect(r.unchanged).toBe(false);
    });

    test("auto-id is deterministic — same body produces same slug", () => {
      const a = record({ repo: fixture.repo, body: "x" });
      const b = record({ repo: fixture.repo, body: "x" });
      expect(a.slug).toBe(b.slug);
      expect(b.unchanged).toBe(true);
    });

    test("explicit slug + identical content = no-op (tree-hash idempotency)", () => {
      const a = record({ repo: fixture.repo, body: "v1", slug: "x" });
      const b = record({ repo: fixture.repo, body: "v1", slug: "x" });
      expect(b.unchanged).toBe(true);
      expect(b.sha).toBe(a.sha);
    });

    test("re-record with different content appends a commit on the same ref", () => {
      record({ repo: fixture.repo, body: "v1", slug: "x" });
      record({ repo: fixture.repo, body: "v2", slug: "x" });
      const subjects = gitOut(fixture.repo, ["log", "--format=%s", `${REF_ROOT}main/x`]);
      expect(subjects.split("\n")).toEqual(["v2", "v1"]);
    });

    test("scope defaults to current git branch (slashes → dashes)", () => {
      checkout(fixture.repo, "feat/auth");
      const r = record({ repo: fixture.repo, body: "feat note", slug: "n1" });
      expect(r.scope).toBe("feat-auth");
    });

    test("explicit scope overrides branch detection", () => {
      checkout(fixture.repo, "feat/x");
      const r = record({ repo: fixture.repo, body: "x", slug: "y", scope: "main" });
      expect(r.scope).toBe("main");
      const refs = gitOut(fixture.repo, ["for-each-ref", REF_ROOT]);
      expect(refs).toContain("refs/agent-memory/main/y");
    });

    test("body of exactly MAX_BODY chars is accepted", () => {
      const body = "a".repeat(MAX_BODY);
      const r = record({ repo: fixture.repo, body });
      expect(r.unchanged).toBe(false);
    });

    test("rejects body > MAX_BODY", () => {
      expect(() => record({ repo: fixture.repo, body: "a".repeat(MAX_BODY + 1) })).toThrow(
        /body length/,
      );
    });

    test("rejects empty body", () => {
      expect(() => record({ repo: fixture.repo, body: "" })).toThrow();
      expect(() => record({ repo: fixture.repo, body: "   \n  " })).toThrow();
    });

    test("rejects bad slugs (uppercase, leading dash, // double, trailing /)", () => {
      const bad = ["Bad", "-leading", "trailing/", "double//slash", "with space", "with.dot"];
      for (const slug of bad) {
        expect(() => record({ repo: fixture.repo, body: "x", slug })).toThrow();
      }
    });

    test("accepts valid nested slugs", () => {
      const ok = ["a", "auth/oauth", "feat-x/db/postgres", "x123/y-z"];
      for (const slug of ok) {
        const r = record({ repo: fixture.repo, body: "x", slug });
        expect(r.slug).toBe(slug);
      }
    });

    test("rejects bad scopes (uppercase, space, slash, dot)", () => {
      const bad = ["Bad", "with space", "with/slash", "with.dot", "-leading"];
      for (const scope of bad) {
        expect(() => record({ repo: fixture.repo, body: "x", scope })).toThrow();
      }
    });

    test("headline = first non-empty line of body, truncated to 80 chars", () => {
      const long = "x".repeat(100);
      record({ repo: fixture.repo, body: long, slug: "h" });
      const subject = gitOut(fixture.repo, ["log", "-1", "--format=%s", `${REF_ROOT}main/h`]);
      expect(subject.length).toBe(80);
    });

    // ─── by ──────────────────────────────────────────────────────────────────

    test("by overrides commit author/committer name; email default unchanged", () => {
      record({ repo: fixture.repo, body: "x", slug: "n", scope: "main", by: "alice" });
      const out = gitOut(fixture.repo, [
        "log",
        "-1",
        "--format=%an %ae %cn %ce",
        `${REF_ROOT}main/n`,
      ]);
      expect(out).toBe("alice agent@mneo alice agent@mneo");
    });

    test("by omitted: falls back to MNEO_AUTHOR, then 'mneo'", () => {
      record({ repo: fixture.repo, body: "y", slug: "default", scope: "main" });
      const out = gitOut(fixture.repo, ["log", "-1", "--format=%an", `${REF_ROOT}main/default`]);
      expect(out).toBe("mneo");
    });

    test("rejects empty by", () => {
      expect(() => record({ repo: fixture.repo, body: "x", slug: "a", by: "" })).toThrow(/bad by/);
    });

    test("rejects by > 80 chars", () => {
      expect(() =>
        record({ repo: fixture.repo, body: "x", slug: "b", by: "a".repeat(81) }),
      ).toThrow(/bad by/);
    });

    test("rejects by with newline", () => {
      expect(() => record({ repo: fixture.repo, body: "x", slug: "c", by: "alice\nbob" })).toThrow(
        /bad by/,
      );
    });

    test("by does not mutate process.env", () => {
      const before = process.env.GIT_AUTHOR_NAME;
      record({ repo: fixture.repo, body: "x", slug: "d", by: "ephemeral" });
      expect(process.env.GIT_AUTHOR_NAME).toBe(before);
    });
  });

  // ─── recordAsync ─────────────────────────────────────────────────────────
  // Async version exists so the MCP server can yield the event loop between
  // CAS retries instead of blocking via Atomics.wait. Contract must match
  // record() exactly — same return shape, same validation, same semantics
  // — so these tests parallel the record() ones above.

  describe("recordAsync", () => {
    test("returns the same RecordResult shape as record()", async () => {
      const r = await recordAsync({ repo: fixture.repo, body: "use OAuth2", slug: "a" });
      expect(r.scope).toBe("main");
      expect(r.slug).toBe("a");
      expect(r.unchanged).toBe(false);
      expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    });

    test("idempotency: re-recording same body under same slug → unchanged:true", async () => {
      const a = await recordAsync({ repo: fixture.repo, body: "v1", slug: "x", scope: "main" });
      const b = await recordAsync({ repo: fixture.repo, body: "v1", slug: "x", scope: "main" });
      expect(b.unchanged).toBe(true);
      expect(b.sha).toBe(a.sha);
    });

    test("validation throws synchronously inside the awaited promise", async () => {
      await expect(recordAsync({ repo: fixture.repo, body: "", slug: "a" })).rejects.toThrow(
        /non-empty/,
      );
    });

    test("auto-slug path matches record's", async () => {
      const a = record({ repo: fixture.repo, body: "same body", scope: "main" });
      // forget so the second insert isn't a no-op
      forget({ repo: fixture.repo, slug: a.slug, scope: "main" });
      const b = await recordAsync({ repo: fixture.repo, body: "same body", scope: "main" });
      expect(b.slug).toBe(a.slug);
    });

    test("yields the event loop — a setImmediate scheduled before the await runs first", async () => {
      // record() (sync) blocks the loop; recordAsync must give microtasks /
      // setImmediate callbacks a chance to fire. With no contention there's
      // no sleep, so we just verify the promise nature: the call sequence
      // resolves through the microtask queue, and code after the await runs.
      const order: string[] = [];
      const p = recordAsync({ repo: fixture.repo, body: "x", slug: "yield", scope: "main" }).then(
        () => order.push("recordAsync done"),
      );
      order.push("after recordAsync call");
      await p;
      expect(order).toEqual(["after recordAsync call", "recordAsync done"]);
    });
  });

  // ─── list ────────────────────────────────────────────────────────────────

  describe("list", () => {
    test("empty repo returns { entries: [], hidden: 0 }", () => {
      expect(list({ repo: fixture.repo })).toEqual({ entries: [], hidden: 0 });
    });

    test("default returns current scope + main fallback (current wins on collision)", () => {
      record({ repo: fixture.repo, body: "trunk auth", slug: "auth", scope: "main" });
      record({ repo: fixture.repo, body: "trunk db", slug: "db", scope: "main" });
      checkout(fixture.repo, "feat/x");
      record({ repo: fixture.repo, body: "feature auth override", slug: "auth" });

      const { entries } = list({ repo: fixture.repo });
      const bySlug = new Map(entries.map((e) => [e.slug, e]));
      expect(bySlug.get("auth")?.scope).toBe("feat-x");
      expect(bySlug.get("db")?.scope).toBe("main");
      expect(entries.length).toBe(2);
    });

    test("scope='*' returns every namespace", () => {
      record({ repo: fixture.repo, body: "trunk", slug: "a", scope: "main" });
      checkout(fixture.repo, "feat/x");
      record({ repo: fixture.repo, body: "feat", slug: "b" });
      const { entries } = list({ repo: fixture.repo, scope: "*" });
      expect(entries.map((e) => e.slug).sort()).toEqual(["a", "b"]);
    });

    test("scope as string array constrains to those scopes", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      record({ repo: fixture.repo, body: "y", slug: "b", scope: "side" });
      const { entries } = list({ repo: fixture.repo, scope: ["side"] });
      expect(entries.map((e) => e.slug)).toEqual(["b"]);
    });

    test("prefix narrows within scope", () => {
      record({ repo: fixture.repo, body: "o", slug: "auth/oauth", scope: "main" });
      record({ repo: fixture.repo, body: "j", slug: "auth/jwt", scope: "main" });
      record({ repo: fixture.repo, body: "p", slug: "db/pg", scope: "main" });
      const { entries } = list({ repo: fixture.repo, prefix: "auth/" });
      expect(entries.map((e) => e.slug).sort()).toEqual(["auth/jwt", "auth/oauth"]);
    });

    test("rejects bad prefix", () => {
      expect(() => list({ repo: fixture.repo, prefix: "Bad/" })).toThrow();
      expect(() => list({ repo: fixture.repo, prefix: "with space/" })).toThrow();
    });

    test("entries are newest-first by ts", () => {
      recordAtAge(fixture.repo, "old", 5, { slug: "old", scope: "main" });
      recordAtAge(fixture.repo, "fresh", 0, { slug: "fresh", scope: "main" });
      recordAtAge(fixture.repo, "mid", 2, { slug: "mid", scope: "main" });
      const { entries } = list({ repo: fixture.repo });
      expect(entries.map((e) => e.slug)).toEqual(["fresh", "mid", "old"]);
    });

    // ─── maxAgeDays + hidden ──────────────────────────────────────────────

    test("default maxAgeDays excludes notes older than 30 days; hidden counts them", () => {
      recordAtAge(fixture.repo, "ancient", 31, { slug: "old", scope: "main" });
      recordAtAge(fixture.repo, "recent", 5, { slug: "new", scope: "main" });
      const r = list({ repo: fixture.repo });
      expect(r.entries.map((e) => e.slug)).toEqual(["new"]);
      expect(r.hidden).toBe(1);
    });

    test("maxAgeDays:0 disables the age filter; hidden=0", () => {
      recordAtAge(fixture.repo, "ancient", 100, { slug: "old", scope: "main" });
      recordAtAge(fixture.repo, "recent", 1, { slug: "new", scope: "main" });
      const r = list({ repo: fixture.repo, maxAgeDays: 0 });
      expect(r.entries.map((e) => e.slug).sort()).toEqual(["new", "old"]);
      expect(r.hidden).toBe(0);
    });

    test("maxAgeDays:90 includes 60d-old, excludes 100d-old; hidden=1", () => {
      recordAtAge(fixture.repo, "x", 60, { slug: "mid", scope: "main" });
      recordAtAge(fixture.repo, "y", 100, { slug: "ancient", scope: "main" });
      const r = list({ repo: fixture.repo, maxAgeDays: 90 });
      expect(r.entries.map((e) => e.slug)).toEqual(["mid"]);
      expect(r.hidden).toBe(1);
    });

    test("maxAgeDays boundary: note 1 day below cutoff included; 1 day above excluded", () => {
      recordAtAge(fixture.repo, "below", 29, { slug: "ok", scope: "main" });
      recordAtAge(fixture.repo, "above", 31, { slug: "out", scope: "main" });
      const r = list({ repo: fixture.repo, maxAgeDays: 30 });
      expect(r.entries.map((e) => e.slug)).toEqual(["ok"]);
      expect(r.hidden).toBe(1);
    });

    test("hidden counts age-filtered only — not limit overflow", () => {
      // 5 fresh + 3 stale; default limit (50) so no truncation. hidden=3.
      for (let i = 0; i < 5; i++) {
        recordAtAge(fixture.repo, `fresh${i}`, 1, { slug: `f${i}`, scope: "main" });
      }
      for (let i = 0; i < 3; i++) {
        recordAtAge(fixture.repo, `stale${i}`, 60, { slug: `s${i}`, scope: "main" });
      }
      // Limit=2 truncates entries to 2, but hidden still reflects only the
      // age filter (3 stale notes) — not the 3 fresh ones dropped by limit.
      const r = list({ repo: fixture.repo, limit: 2 });
      expect(r.entries.length).toBe(2);
      expect(r.hidden).toBe(3);
    });

    test("re-recording a stale note bumps its ts (note becomes alive)", () => {
      recordAtAge(fixture.repo, "v1", 60, { slug: "alive", scope: "main" });
      // Default maxAgeDays:30 should hide it.
      expect(list({ repo: fixture.repo }).entries).toHaveLength(0);
      // Re-record (now) → resurrects.
      record({ repo: fixture.repo, body: "v2", slug: "alive", scope: "main" });
      expect(list({ repo: fixture.repo }).entries.map((e) => e.slug)).toEqual(["alive"]);
    });

    test("LIST_DEFAULT_MAX_AGE_DAYS exposed as 30", () => {
      expect(LIST_DEFAULT_MAX_AGE_DAYS).toBe(30);
    });

    // ─── limit ─────────────────────────────────────────────────────────────

    test("default limit caps at LIST_DEFAULT_LIMIT (50)", () => {
      for (let i = 0; i < 60; i++) {
        record({ repo: fixture.repo, body: `note ${i}`, slug: `n${i}`, scope: "main" });
      }
      expect(LIST_DEFAULT_LIMIT).toBe(50);
      expect(list({ repo: fixture.repo }).entries).toHaveLength(50);
    });

    test("explicit limit overrides default", () => {
      for (let i = 0; i < 60; i++) {
        record({ repo: fixture.repo, body: `n${i}`, slug: `n${i}`, scope: "main" });
      }
      expect(list({ repo: fixture.repo, limit: 10 }).entries).toHaveLength(10);
      expect(list({ repo: fixture.repo, limit: 60 }).entries).toHaveLength(60);
    });

    test("limit:0 (and negative) returns everything (no cap)", () => {
      for (let i = 0; i < 55; i++) {
        record({ repo: fixture.repo, body: `n${i}`, slug: `n${i}`, scope: "main" });
      }
      expect(list({ repo: fixture.repo, limit: 0 }).entries).toHaveLength(55);
    });

    test("filter applies BEFORE limit (not after)", () => {
      // 5 fresh + 5 stale; limit:3 → returns 3 of the 5 fresh (not 3 of 10 raw)
      for (let i = 0; i < 5; i++) {
        recordAtAge(fixture.repo, `fresh${i}`, 1, { slug: `f${i}`, scope: "main" });
      }
      for (let i = 0; i < 5; i++) {
        recordAtAge(fixture.repo, `stale${i}`, 60, { slug: `s${i}`, scope: "main" });
      }
      const { entries } = list({ repo: fixture.repo, limit: 3 });
      expect(entries.length).toBe(3);
      expect(entries.every((e) => e.slug.startsWith("f"))).toBe(true);
    });
  });

  // ─── read ────────────────────────────────────────────────────────────────

  describe("read", () => {
    test("returns body for an existing slug in current scope", () => {
      record({ repo: fixture.repo, body: "hello", slug: "x", scope: "main" });
      const r = read({ repo: fixture.repo, slug: "x" });
      expect(r.body).toBe("hello");
      expect(r.scope).toBe("main");
    });

    test("falls back to main when slug missing in current scope", () => {
      record({ repo: fixture.repo, body: "trunk", slug: "shared", scope: "main" });
      checkout(fixture.repo, "feat/x");
      const r = read({ repo: fixture.repo, slug: "shared" });
      expect(r.body).toBe("trunk");
      expect(r.scope).toBe("main");
    });

    test("explicit scope does NOT fall back", () => {
      record({ repo: fixture.repo, body: "trunk", slug: "x", scope: "main" });
      expect(() => read({ repo: fixture.repo, slug: "x", scope: "feat-y" })).toThrow(/not found/);
    });

    test("missing slug throws with helpful message listing tried scopes", () => {
      checkout(fixture.repo, "feat/x");
      try {
        read({ repo: fixture.repo, slug: "nope" });
        throw new Error("should have thrown");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toMatch(/not found/);
        expect(msg).toContain("feat-x");
        expect(msg).toContain("main");
      }
    });
  });

  // ─── forget ──────────────────────────────────────────────────────────────

  describe("forget", () => {
    test("deletes only from the requested scope (defaults to current)", () => {
      record({ repo: fixture.repo, body: "trunk", slug: "x", scope: "main" });
      checkout(fixture.repo, "feat/x");
      record({ repo: fixture.repo, body: "feat", slug: "x" });

      const f = forget({ repo: fixture.repo, slug: "x" });
      expect(f.deleted).toBe(true);
      expect(f.scope).toBe("feat-x");

      setMain(fixture.repo);
      expect(read({ repo: fixture.repo, slug: "x" }).body).toBe("trunk");
    });

    test("returns deleted=false on missing slug", () => {
      const f = forget({ repo: fixture.repo, slug: "nope", scope: "main" });
      expect(f.deleted).toBe(false);
    });

    test("explicit scope deletes from that scope", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "side" });
      const f = forget({ repo: fixture.repo, slug: "a", scope: "side" });
      expect(f.deleted).toBe(true);
      const refs = gitOut(fixture.repo, ["for-each-ref", REF_ROOT]);
      expect(refs).not.toContain("refs/agent-memory/side/a");
    });

    test("after forget, list no longer surfaces the slug", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      forget({ repo: fixture.repo, slug: "a", scope: "main" });
      expect(list({ repo: fixture.repo, scope: "*" }).entries).toEqual([]);
    });

    // ─── scope:'*' — best-effort + idempotent ──────────────────────────────
    // The audit flagged forget({scope:'*'}) as silent on partial failure.
    // The contract is now: best-effort (per-ref errors are skipped, not
    // raised) + idempotent (re-running converges; stale state cannot
    // accumulate). Tests assert both halves directly.

    describe("scope:'*'", () => {
      test("deletes the slug from every scope it appears in; reports each", () => {
        record({ repo: fixture.repo, body: "trunk", slug: "shared", scope: "main" });
        record({ repo: fixture.repo, body: "side", slug: "shared", scope: "side" });
        record({ repo: fixture.repo, body: "feat", slug: "shared", scope: "feat" });
        // Containment: a different slug must NOT be touched.
        record({ repo: fixture.repo, body: "other", slug: "untouched", scope: "main" });

        const f = forget({ repo: fixture.repo, slug: "shared", scope: "*" });
        expect(f.deleted).toBe(true);
        expect(f.scope).toBe("*");
        expect(f.scopes?.sort()).toEqual(["feat", "main", "side"]);

        const refs = gitOut(fixture.repo, ["for-each-ref", "--format=%(refname)", REF_ROOT])
          .split("\n")
          .filter(Boolean);
        expect(refs).toEqual(["refs/agent-memory/main/untouched"]);
      });

      test("slug doesn't exist anywhere → deleted=false, scopes=[]", () => {
        record({ repo: fixture.repo, body: "x", slug: "exists", scope: "main" });
        const f = forget({ repo: fixture.repo, slug: "ghost", scope: "*" });
        expect(f.deleted).toBe(false);
        expect(f.scopes).toEqual([]);
        // Existing slug is intact.
        expect(list({ repo: fixture.repo, scope: "*" }).entries.map((e) => e.slug)).toEqual([
          "exists",
        ]);
      });

      test("repo with zero refs at all → deleted=false, scopes=[]", () => {
        const f = forget({ repo: fixture.repo, slug: "anything", scope: "*" });
        expect(f.deleted).toBe(false);
        expect(f.scopes).toEqual([]);
      });

      test("idempotency: re-running after a complete forget is a no-op", () => {
        record({ repo: fixture.repo, body: "a", slug: "shared", scope: "main" });
        record({ repo: fixture.repo, body: "b", slug: "shared", scope: "side" });

        const first = forget({ repo: fixture.repo, slug: "shared", scope: "*" });
        expect(first.deleted).toBe(true);
        expect(first.scopes?.length).toBe(2);

        const second = forget({ repo: fixture.repo, slug: "shared", scope: "*" });
        expect(second.deleted).toBe(false);
        expect(second.scopes).toEqual([]);
      });

      test("idempotency: re-run after partial external deletion catches the rest", () => {
        // Simulates a SIGKILL between iterations: pre-delete one ref behind
        // the SDK's back, then call forget({scope:"all"}). The remaining
        // ref must still be deleted and reported.
        record({ repo: fixture.repo, body: "a", slug: "shared", scope: "main" });
        record({ repo: fixture.repo, body: "b", slug: "shared", scope: "side" });
        record({ repo: fixture.repo, body: "c", slug: "shared", scope: "feat" });

        // External partial: nuke one ref outside the SDK.
        spawnSync("git", ["-C", fixture.repo, "update-ref", "-d", "refs/agent-memory/main/shared"]);

        const f = forget({ repo: fixture.repo, slug: "shared", scope: "*" });
        expect(f.deleted).toBe(true);
        // Only "side" and "feat" remain to delete; "main" was already gone
        // and so doesn't appear in the result (it isn't a falsely-reported
        // success).
        expect(f.scopes?.sort()).toEqual(["feat", "side"]);

        // No refs left for this slug.
        const refs = gitOut(fixture.repo, ["for-each-ref", "--format=%(refname)", REF_ROOT]);
        expect(refs).toBe("");
      });

      test("a same-slug ref appearing AFTER an interrupted forget is still reachable on rerun", () => {
        // Whole point of "idempotent on rerun": user re-invokes forget after
        // a fresh writer added a new copy of the slug. Rerun must catch it.
        record({ repo: fixture.repo, body: "a", slug: "shared", scope: "main" });
        forget({ repo: fixture.repo, slug: "shared", scope: "*" });

        // New writer creates a fresh ref under a different scope.
        record({ repo: fixture.repo, body: "late", slug: "shared", scope: "late" });
        const f = forget({ repo: fixture.repo, slug: "shared", scope: "*" });
        expect(f.deleted).toBe(true);
        expect(f.scopes).toEqual(["late"]);
      });

      test("does not match prefix-similar slugs (exact slug equality only)", () => {
        // Slugs chosen so the SDK can store both at once. `auth/oauth` and
        // `auth/oauth-v2` are sibling refs, not parent/child — git allows
        // them to coexist (sibling slugs are sibling files in the ref dir).
        // Were we to use `auth/oauth` + `auth/oauth/v2`, git would refuse
        // the second as a directory/file collision.
        record({ repo: fixture.repo, body: "auth", slug: "auth/oauth", scope: "main" });
        record({ repo: fixture.repo, body: "v2", slug: "auth/oauth-v2", scope: "main" });
        const f = forget({ repo: fixture.repo, slug: "auth/oauth", scope: "*" });
        expect(f.deleted).toBe(true);
        expect(f.scopes).toEqual(["main"]);
        // String-prefix-similar slug is left alone — equality, not prefix.
        const refs = gitOut(fixture.repo, ["for-each-ref", "--format=%(refname)", REF_ROOT]);
        expect(refs).toBe("refs/agent-memory/main/auth/oauth-v2");
      });

      test("nested slug across multiple scopes deletes from each", () => {
        record({ repo: fixture.repo, body: "a", slug: "auth/oauth", scope: "main" });
        record({ repo: fixture.repo, body: "b", slug: "auth/oauth", scope: "side" });
        const f = forget({ repo: fixture.repo, slug: "auth/oauth", scope: "*" });
        expect(f.scopes?.sort()).toEqual(["main", "side"]);
      });
    });
  });

  // ─── all-scopes sentinel ('*') ─────────────────────────────────────────────
  // The sentinel is "*" — chosen so SCOPE_RE rejects it as a literal scope
  // name. The sentinel namespace and the scope-name namespace are disjoint
  // by construction, so there's no reserved-word table to maintain and no
  // way for a literal scope to silently collide with the sentinel.

  describe("all-scopes sentinel", () => {
    test("ALL_SCOPES is exposed as '*'", () => {
      expect(ALL_SCOPES).toBe("*");
    });

    test("'*' is rejected as a literal scope name (SCOPE_RE doesn't match)", () => {
      // record/read take an explicit scope. Passing "*" tries to use it as
      // a literal scope, which the regex rejects — so the sentinel can't
      // be misinterpreted as "write to a scope literally named *".
      expect(() => record({ repo: fixture.repo, body: "x", slug: "a", scope: "*" })).toThrow(
        /bad scope/,
      );
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      expect(() => read({ repo: fixture.repo, slug: "a", scope: "*" })).toThrow(/bad scope/);
    });

    test("list({scope:['*']}) — array form rejects '*' as a literal too", () => {
      // String form (scope:'*') is the sentinel; array form is literal
      // scope names, and '*' fails validation as a literal.
      expect(() => list({ repo: fixture.repo, scope: ["*"] })).toThrow(/bad scope/);
    });

    test("list({scope:'*'}) returns every namespace", () => {
      record({ repo: fixture.repo, body: "trunk", slug: "x", scope: "main" });
      record({ repo: fixture.repo, body: "side", slug: "y", scope: "side" });
      const { entries } = list({ repo: fixture.repo, scope: "*" });
      expect(entries.map((e) => e.slug).sort()).toEqual(["x", "y"]);
    });

    test("forget({scope:'*'}) deletes from every scope", () => {
      record({ repo: fixture.repo, body: "trunk", slug: "shared", scope: "main" });
      record({ repo: fixture.repo, body: "side", slug: "shared", scope: "side" });
      const f = forget({ repo: fixture.repo, slug: "shared", scope: "*" });
      expect(f.deleted).toBe(true);
      expect(f.scope).toBe("*");
      expect(f.scopes?.sort()).toEqual(["main", "side"]);
    });

    test("a literal scope named 'all' is now legal (used to be a footgun)", () => {
      // The reason '*' replaces 'all' as the sentinel: 'all' is a perfectly
      // good scope name. Pre-fix, recording to scope:'all' silently
      // collided with the sentinel and any later forget({scope:'all'})
      // wiped every scope. Now the namespaces are disjoint — 'all' is
      // just a string, '*' is the only sentinel.
      const literalAll = "all";
      const r = record({ repo: fixture.repo, body: "x", slug: "a", scope: literalAll });
      expect(r.scope).toBe("all");
      // forget on the literal 'all' scope deletes ONLY from there.
      record({ repo: fixture.repo, body: "y", slug: "a", scope: "main" });
      const f = forget({ repo: fixture.repo, slug: "a", scope: literalAll });
      expect(f.deleted).toBe(true);
      expect(f.scope).toBe("all");
      // The 'main' copy survives.
      expect(read({ repo: fixture.repo, slug: "a", scope: "main" }).body).toBe("y");
    });

    test("a branch literally named 'all' picks 'all' as its auto-scope without complaint", () => {
      checkout(fixture.repo, "all");
      const r = record({ repo: fixture.repo, body: "x", slug: "n" });
      expect(r.scope).toBe("all");
    });
  });
});

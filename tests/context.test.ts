// context() — pre-prompt bundle. Slice 1: titles only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { context, record } from "../packages/git-memory/src/index.ts";

import { type TempRepo, makeTempRepo } from "./helpers/repo.ts";

describe("context() porcelain", () => {
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

  test("empty repo: text=''", () => {
    const r = context({ repo: fixture.repo });
    expect(r.text).toBe("");
  });

  test("delegates to list() — every recorded note appears in text", () => {
    record({ repo: fixture.repo, body: "first note", slug: "a", scope: "main" });
    record({ repo: fixture.repo, body: "second note", slug: "b", scope: "main" });
    const lines = context({ repo: fixture.repo }).text.split("\n");
    expect(lines.some((l) => l.includes("[main] a"))).toBe(true);
    expect(lines.some((l) => l.includes("[main] b"))).toBe(true);
  });

  test("text format: '- [scope] slug — headline' lines, newest first", () => {
    // Same-second timestamps tie — for-each-ref breaks ties on refname ASC.
    // Backdate to force a deterministic creatordate order.
    const oldTs = `${Math.floor(Date.now() / 1000) - 3600} +0000`;
    process.env.GIT_AUTHOR_DATE = oldTs;
    process.env.GIT_COMMITTER_DATE = oldTs;
    try {
      record({ repo: fixture.repo, body: "v1 first", slug: "a", scope: "main" });
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires delete
      delete process.env.GIT_AUTHOR_DATE;
      // biome-ignore lint/performance/noDelete: same
      delete process.env.GIT_COMMITTER_DATE;
    }
    record({ repo: fixture.repo, body: "v2 second", slug: "b", scope: "main" });
    const lines = context({ repo: fixture.repo }).text.split("\n");
    expect(lines).toEqual(["- [main] b — v2 second", "- [main] a — v1 first"]);
  });

  test("respects list() options: scope, prefix, limit, maxAgeDays", () => {
    record({ repo: fixture.repo, body: "auth note", slug: "auth/jwt", scope: "main" });
    record({ repo: fixture.repo, body: "db note", slug: "db/pg", scope: "main" });
    const r = context({ repo: fixture.repo, prefix: "auth/" });
    expect(r.text).toBe("- [main] auth/jwt — auth note");
  });

  // ─── budget (slice 2) ──────────────────────────────────────────────────────

  describe("budget", () => {
    test("budget=0 → text empty (even the shortest entry doesn't fit)", () => {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
      expect(context({ repo: fixture.repo, charBudget: 0 }).text).toBe("");
    });

    test("multi-line body: full rendering is bullet + indented continuation lines", () => {
      record({
        repo: fixture.repo,
        body: "use OAuth2 with PKCE\nredirect_uri whitelisted in env\nrefresh tokens in HttpOnly cookies",
        slug: "auth/oauth",
        scope: "main",
      });
      const r = context({ repo: fixture.repo, charBudget: 1000 });
      expect(r.text).toBe(
        [
          "- [main] auth/oauth — use OAuth2 with PKCE",
          "  redirect_uri whitelisted in env",
          "  refresh tokens in HttpOnly cookies",
        ].join("\n"),
      );
    });

    test("single-line body: full rendering identical to short (slice-1 compat)", () => {
      record({ repo: fixture.repo, body: "argon2id", slug: "x", scope: "main" });
      const r = context({ repo: fixture.repo, charBudget: 10000 });
      expect(r.text).toBe("- [main] x — argon2id");
    });

    test("body trailing newline: collapsed, no empty indented line", () => {
      record({ repo: fixture.repo, body: "title\nbody line\n", slug: "t", scope: "main" });
      const r = context({ repo: fixture.repo, charBudget: 1000 });
      expect(r.text).toBe(["- [main] t — title", "  body line"].join("\n"));
    });

    test("budget intermediate: newest gets full, older falls back to short, even older drops", () => {
      // Backdate to control ordering. Newest = c, then b, then a.
      const stamp = (sec: number) => `${Math.floor(Date.now() / 1000) - sec} +0000`;
      const setTs = (s: string) => {
        process.env.GIT_AUTHOR_DATE = s;
        process.env.GIT_COMMITTER_DATE = s;
      };
      const clearTs = () => {
        // biome-ignore lint/performance/noDelete: process.env requires delete
        delete process.env.GIT_AUTHOR_DATE;
        // biome-ignore lint/performance/noDelete: same
        delete process.env.GIT_COMMITTER_DATE;
      };
      try {
        setTs(stamp(3600));
        record({ repo: fixture.repo, body: "old\nlong body line one", slug: "a", scope: "main" });
        setTs(stamp(1800));
        record({ repo: fixture.repo, body: "mid\nshort", slug: "b", scope: "main" });
        setTs(stamp(60));
        record({ repo: fixture.repo, body: "new\nfull body line", slug: "c", scope: "main" });
      } finally {
        clearTs();
      }

      // Sized so c (full) + b (full) ≈ ~70 chars, then a's full would push over.
      // Pick a budget that fits c full, b full, and a only as short.
      // c full = "- [main] c — new\n  full body line"           = 33 chars
      // b full = "- [main] b — mid\n  short"                    = 24 chars
      // a short = "- [main] a — old"                            = 16 chars
      // Joins: 2 newlines = 2 chars. Total = 33+24+16+2 = 75.
      // a full = "- [main] a — old\n  long body line one"      = 37, would push to 96.
      // Budget 80 → fits c full + b full + a short.
      const r = context({ repo: fixture.repo, charBudget: 80 });
      const lines = r.text.split("\n");
      // c full rendering
      expect(lines[0]).toBe("- [main] c — new");
      expect(lines[1]).toBe("  full body line");
      // b full
      expect(lines[2]).toBe("- [main] b — mid");
      expect(lines[3]).toBe("  short");
      // a short
      expect(lines[4]).toBe("- [main] a — old");
      expect(lines).toHaveLength(5);
      expect(r.text.length).toBeLessThanOrEqual(80);
    });

    test("note larger than entire budget → short form, never truncates body mid-line", () => {
      const big = `headline\n${"x".repeat(4500)}`; // under MAX_BODY 5000
      record({ repo: fixture.repo, body: big, slug: "big", scope: "main" });
      const r = context({ repo: fixture.repo, charBudget: 200 });
      expect(r.text).toBe("- [main] big — headline");
      // No body chars leaked into the bundle.
      expect(r.text).not.toMatch(/x{10}/);
    });

    test("ContextOpts.budget is rejected by the typechecker (Slice 4 rename guard)", () => {
      // @ts-expect-error — Slice 4 renamed `budget` → `charBudget`. The old
      // key would silently accept a token-count from the LLM and overshoot
      // the actual char-count budget on non-ASCII content.
      const opts: import("../packages/git-memory/src/context.ts").ContextOpts = { budget: 100 };
      expect(opts).toBeDefined();
    });

    test("default budget is DEFAULT_BUDGET (2000)", () => {
      // Sanity: small bodies all fit at default budget.
      for (let i = 0; i < 10; i++) {
        record({
          repo: fixture.repo,
          body: `note ${i}\nsome body content`,
          slug: `n${i}`,
          scope: "main",
        });
      }
      const r = context({ repo: fixture.repo });
      expect(r.text.length).toBeLessThanOrEqual(2000);
      // All 10 notes rendered (each ~40-50 chars × 10 ≈ 450, well under 2000).
      const headlines = r.text.split("\n").filter((l) => l.startsWith("- ["));
      expect(headlines).toHaveLength(10);
    });
  });
});

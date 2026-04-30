// Concurrency: parallel record() calls on the same slug must not silently
// drop writes. With N writers and one shared ref, contention on the
// update-ref CAS is essentially guaranteed; the bounded retry loop in
// record() must recover and land every commit.
//
// Edge cases covered:
//   - N writers, all distinct bodies, same slug → N commits in chain
//   - N writers, all identical body, same slug → 1 commit, others unchanged
//   - N writers, mixed (duplicates + uniques), same slug → unique commits only
//   - N writers, different slugs, same scope → no contention, N independent refs
//   - N writers, same slug, different scopes → no contention, N independent refs
//   - Sequential record after contended → normal chain extension, correct parent
//   - read() after contended write → body matches one of the racers, chain intact
//   - Non-retryable git error → bubbles up, no spurious retry

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RECORD_MAX_RETRIES, REF_ROOT, read, record } from "../packages/git-memory/src/index.ts";

import { type TempRepo, makeTempRepo } from "./helpers/repo.ts";

const SDK_PATH = fileURLToPath(new URL("../packages/git-memory/src/index.ts", import.meta.url));

function gitOut(repo: string, args: string[]): string {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).stdout.trim();
}

interface ChildResult {
  exit: number;
  stdout: string;
  stderr: string;
}

// Spawn a child `bun -e` running an inline SDK script. The script's stdout is
// captured (typically a JSON line written by the script) so the parent can
// inspect each writer's RecordResult independently.
async function spawnRecord(
  repo: string,
  body: string,
  opts: { slug?: string; scope?: string } = {},
): Promise<ChildResult> {
  const script = `
    import { record } from ${JSON.stringify(SDK_PATH)};
    const r = record({ repo: ${JSON.stringify(repo)}, body: ${JSON.stringify(body)}${
      opts.slug ? `, slug: ${JSON.stringify(opts.slug)}` : ""
    }${opts.scope ? `, scope: ${JSON.stringify(opts.scope)}` : ""} });
    process.stdout.write(JSON.stringify(r));
  `;
  const proc = Bun.spawn({
    cmd: ["bun", "-e", script],
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  const stdout = await new Response(proc.stdout as ReadableStream).text();
  const stderr = await new Response(proc.stderr as ReadableStream).text();
  return { exit, stdout, stderr };
}

async function runParallel<T>(items: T[], fn: (item: T, i: number) => Promise<ChildResult>) {
  const results = await Promise.all(items.map((it, i) => fn(it, i)));
  for (let i = 0; i < results.length; i++) {
    if (results[i]?.exit !== 0) {
      throw new Error(`process ${i} exited ${results[i]?.exit}: ${results[i]?.stderr}`);
    }
  }
  return results;
}

describe("git-memory concurrency", () => {
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

  // ─── distinct bodies, same slug — every write must land ────────────────────

  test("N parallel writers, all distinct bodies, same slug → N commits in chain", async () => {
    const N = 10;
    const repo = fixture.repo;
    const results = await runParallel(
      Array.from({ length: N }, (_, i) => i),
      (i) => spawnRecord(repo, `v${i}`, { slug: "race", scope: "main" }),
    );
    // Every child got a non-error result.
    expect(results.length).toBe(N);
    // Every distinct body appears in the ref's commit chain.
    const headlines = gitOut(repo, ["log", "--format=%s", `${REF_ROOT}main/race`])
      .split("\n")
      .filter(Boolean);
    expect(headlines).toHaveLength(N);
    for (let i = 0; i < N; i++) expect(headlines).toContain(`v${i}`);
  }, 30_000);

  // ─── identical bodies — idempotency-during-retry ───────────────────────────

  test("N parallel writers, identical body, same slug → 1 commit; others unchanged", async () => {
    const N = 10;
    const repo = fixture.repo;
    const results = await runParallel(Array.from({ length: N }), () =>
      spawnRecord(repo, "same-body", { slug: "dup", scope: "main" }),
    );
    const parsed = results.map((r) => JSON.parse(r.stdout) as { sha: string; unchanged: boolean });

    // All children must converge on the SAME final sha (only one real commit).
    const shas = new Set(parsed.map((p) => p.sha));
    expect(shas.size).toBe(1);

    // Exactly one commit on the ref; only one writer can have unchanged=false.
    const headlines = gitOut(repo, ["log", "--format=%s", `${REF_ROOT}main/dup`])
      .split("\n")
      .filter(Boolean);
    expect(headlines).toHaveLength(1);
    const winners = parsed.filter((p) => !p.unchanged).length;
    expect(winners).toBe(1);
    expect(parsed.filter((p) => p.unchanged).length).toBe(N - 1);
  }, 30_000);

  // ─── mixed identical + distinct ────────────────────────────────────────────

  test("N parallel writers, mixed dup+unique bodies → headlines limited to the input set", async () => {
    const repo = fixture.repo;
    const bodies = ["A", "A", "A", "A", "A", "B", "B", "B", "B", "B"];
    const results = await runParallel(bodies, (body) =>
      spawnRecord(repo, body, { slug: "mix", scope: "main" }),
    );
    expect(results.length).toBe(bodies.length);

    const headlines = gitOut(repo, ["log", "--format=%s", `${REF_ROOT}main/mix`])
      .split("\n")
      .filter(Boolean);
    // Chain length is NOT 2 in general: if A and B alternate winning, the
    // tree-hash idempotency check fails for stale writers and they have to
    // write a new commit (tree "A" on top of "B" or vice-versa). The
    // invariants that DO hold:
    //   - Every headline is one of the input bodies.
    //   - Both bodies appear at least once.
    //   - The chain is bounded above by the writer count.
    expect(new Set(headlines)).toEqual(new Set(["A", "B"]));
    for (const h of headlines) expect(["A", "B"]).toContain(h);
    expect(headlines.length).toBeLessThanOrEqual(bodies.length);
  }, 30_000);

  // ─── disjoint slugs in the same scope — must not contend ───────────────────

  test("N parallel writers, different slugs, same scope → N independent refs", async () => {
    const N = 8;
    const repo = fixture.repo;
    await runParallel(
      Array.from({ length: N }, (_, i) => i),
      (i) => spawnRecord(repo, `body-${i}`, { slug: `slug${i}`, scope: "main" }),
    );
    const refs = gitOut(repo, ["for-each-ref", "--format=%(refname)", REF_ROOT])
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(refs).toHaveLength(N);
    for (let i = 0; i < N; i++) expect(refs).toContain(`${REF_ROOT}main/slug${i}`);
  }, 30_000);

  // ─── same slug, different scopes — also disjoint ───────────────────────────

  test("N parallel writers, same slug, different scopes → N independent refs", async () => {
    const N = 8;
    const repo = fixture.repo;
    await runParallel(
      Array.from({ length: N }, (_, i) => i),
      (i) => spawnRecord(repo, `body-${i}`, { slug: "shared", scope: `scope${i}` }),
    );
    const refs = gitOut(repo, ["for-each-ref", "--format=%(refname)", REF_ROOT])
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(refs).toHaveLength(N);
    for (let i = 0; i < N; i++) expect(refs).toContain(`${REF_ROOT}scope${i}/shared`);
  }, 30_000);

  // ─── post-contention sanity ────────────────────────────────────────────────

  test("sequential record after contended slug extends the chain normally", async () => {
    const N = 5;
    const repo = fixture.repo;
    await runParallel(
      Array.from({ length: N }, (_, i) => i),
      (i) => spawnRecord(repo, `parallel${i}`, { slug: "post", scope: "main" }),
    );
    // After the storm, an in-process record() should land cleanly on top.
    const r = record({ repo, body: "after-storm", slug: "post", scope: "main" });
    expect(r.unchanged).toBe(false);

    const headlines = gitOut(repo, ["log", "--format=%s", `${REF_ROOT}main/post`])
      .split("\n")
      .filter(Boolean);
    expect(headlines).toHaveLength(N + 1);
    // Newest first — the sequential write is at the top of the chain.
    expect(headlines[0]).toBe("after-storm");
  }, 30_000);

  test("read() after contended write returns one of the racers' bodies", async () => {
    const N = 6;
    const repo = fixture.repo;
    const bodies = Array.from({ length: N }, (_, i) => `payload-${i}`);
    await runParallel(bodies, (body) =>
      spawnRecord(repo, body, { slug: "snapshot", scope: "main" }),
    );
    const r = read({ repo, slug: "snapshot", scope: "main" });
    expect(bodies).toContain(r.body);
    // Chain integrity: the ref's commit log should have N entries (one per write).
    const chain = gitOut(repo, ["log", "--format=%H", `${REF_ROOT}main/snapshot`])
      .split("\n")
      .filter(Boolean);
    expect(chain.length).toBe(N);
  }, 30_000);

  // ─── non-retryable error must NOT loop ─────────────────────────────────────

  test("structural slug collision (parent ref blocks child) fails fast — not retried", () => {
    // git refs are filesystem-like: an existing slug `a/b` blocks creation
    // of `a/b/c`. The error wording is "cannot lock ref ... <existing>
    // exists" — superficially close to the CAS error ("cannot lock ref ...
    // but expected ...") that the retry loop targets. The retry guard MUST
    // be tight enough to let the structural error bubble up immediately;
    // retrying it 20 times only delays a non-transient failure.
    const repo = fixture.repo;
    record({ repo, body: "parent", slug: "auth/oauth", scope: "main" });
    let captured: Error | null = null;
    const t0 = Date.now();
    try {
      record({ repo, body: "child", slug: "auth/oauth/v2", scope: "main" });
    } catch (e) {
      captured = e as Error;
    }
    const elapsed = Date.now() - t0;
    expect(captured).not.toBeNull();
    // The error must NOT be the retry-budget message — that would mean we
    // wasted 20 attempts on a permanent error.
    expect(captured?.message).not.toMatch(/contention exceeded/);
    // And it should be fast (no jittered sleep multiplied 20×). With max
    // jitter 10ms × 20 retries the upper bound is ~200ms; a fast-fail is
    // well under that.
    expect(elapsed).toBeLessThan(150);
  });

  test("non-retryable git error bubbles up immediately, not as 'contention exceeded'", () => {
    // Force a non-CAS git failure: hand record() a path that is NOT inside
    // any git tree. The first sh() call (hash-object) fails with "not a git
    // repository" — a message that does NOT match /cannot lock ref/. The
    // retry loop must bail on first throw rather than masking the real
    // error behind "contention exceeded".
    const notARepo = mkdtempSync(join(tmpdir(), "git-memory-not-a-repo-"));
    try {
      let captured: Error | null = null;
      try {
        record({ repo: notARepo, body: "x", slug: "bad", scope: "main" });
      } catch (e) {
        captured = e as Error;
      }
      expect(captured).not.toBeNull();
      expect(captured?.message).toMatch(/not a git repository/);
      expect(captured?.message).not.toMatch(/contention exceeded/);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  // ─── exposed constant ──────────────────────────────────────────────────────

  test("RECORD_MAX_RETRIES exposed as 20", () => {
    expect(RECORD_MAX_RETRIES).toBe(20);
  });
});

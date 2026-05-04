// CLI subcommands record/list/read/forget — black-box e2e via spawned bun.
// Slice 1 covers `record` + the shared --json/error-mapping contract that
// slices 2+ will reuse. Assertions are on stdout/exit only; SDK-level
// assertions on git internals belong in tests/sdk.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { type TempRepo, makeTempRepo } from "./helpers/repo.ts";

const CLI = join(import.meta.dir, "../packages/mneo/src/cli.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  opts: { cwd: string; stdin?: string; env?: Record<string, string> },
): RunResult {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") merged[k] = v;
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) merged[k] = v;
  const r = spawnSync("bun", [CLI, ...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    input: opts.stdin,
    env: merged,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("mneo CLI — record", () => {
  let fixture: TempRepo;
  let branch: string;

  beforeEach(() => {
    fixture = makeTempRepo();
    spawnSync("git", ["-C", fixture.repo, "commit", "--allow-empty", "-m", "init"], {
      encoding: "utf8",
    });
    // Read the actual branch instead of hardcoding — fixture sets `main`,
    // but a future helper change shouldn't silently break assertions.
    const head = spawnSync("git", ["-C", fixture.repo, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    });
    branch = (head.stdout ?? "").trim();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("stdin body + --json → exit 0, JSON with sha + unchanged:false", () => {
    const { code, stdout, stderr } = runCli(["record", "--slug", "t1", "--json"], {
      cwd: fixture.repo,
      stdin: "test body\n",
    });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as {
      slug: string;
      scope: string;
      sha: string;
      unchanged: boolean;
    };
    expect(parsed.slug).toBe("t1");
    expect(parsed.scope).toBe(branch);
    expect(parsed.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.unchanged).toBe(false);
  });

  test("--body + --json → exit 0, same shape", () => {
    const { code, stdout } = runCli(["record", "--slug", "t2", "--body", "inline body", "--json"], {
      cwd: fixture.repo,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { slug: string; unchanged: boolean };
    expect(parsed.slug).toBe("t2");
    expect(parsed.unchanged).toBe(false);
  });

  test("re-record same slug+body → unchanged:true (idempotent)", () => {
    runCli(["record", "--slug", "t1", "--json"], {
      cwd: fixture.repo,
      stdin: "test body\n",
    });
    const { code, stdout } = runCli(["record", "--slug", "t1", "--json"], {
      cwd: fixture.repo,
      stdin: "test body\n",
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { unchanged: boolean };
    expect(parsed.unchanged).toBe(true);
  });

  test("invalid slug → exit 1, INVALID_INPUT JSON on stdout, code on stderr", () => {
    const { code, stdout, stderr } = runCli(
      ["record", "--slug", "BAD SLUG", "--body", "x", "--json"],
      { cwd: fixture.repo },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as { error: string; message: string };
    expect(parsed.error).toBe("INVALID_INPUT");
    expect(parsed.message.length).toBeGreaterThan(0);
    expect(stderr).toMatch(/^INVALID_INPUT:/);
  });

  test("no --json → human one-liner on stdout, no JSON", () => {
    const { code, stdout, stderr } = runCli(["record", "--slug", "t3"], {
      cwd: fixture.repo,
      stdin: "test body\n",
    });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toMatch(new RegExp(`^recorded t3 @ [0-9a-f]{7,40} \\(scope=${branch}\\)\\n$`));
  });
});

describe("mneo CLI — list / read / forget", () => {
  let fixture: TempRepo;
  let branch: string;

  beforeEach(() => {
    fixture = makeTempRepo();
    spawnSync("git", ["-C", fixture.repo, "commit", "--allow-empty", "-m", "init"], {
      encoding: "utf8",
    });
    const head = spawnSync("git", ["-C", fixture.repo, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    });
    branch = (head.stdout ?? "").trim();
    // Seed: t1 then t2 with explicit, distinct, RECENT commit dates.
    // - Distinct: back-to-back spawns can land in the same Unix second; the
    //   SDK's tie-break is refname ASC, which reverses "newest first".
    // - Recent: list() defaults maxAgeDays=30, so stale dates get filtered
    //   into `hidden` and disappear from `entries`.
    const t1Iso = new Date(Date.now() - 2000).toISOString();
    const t2Iso = new Date(Date.now() - 1000).toISOString();
    runCli(["record", "--slug", "t1", "--body", "first body", "--json"], {
      cwd: fixture.repo,
      env: { GIT_AUTHOR_DATE: t1Iso, GIT_COMMITTER_DATE: t1Iso },
    });
    runCli(["record", "--slug", "t2", "--body", "second body", "--json"], {
      cwd: fixture.repo,
      env: { GIT_AUTHOR_DATE: t2Iso, GIT_COMMITTER_DATE: t2Iso },
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("list --json → notes newest-first, counts present and zero", () => {
    const { code, stdout } = runCli(["list", "--json"], { cwd: fixture.repo });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      notes: Array<{ slug: string; scope: string }>;
      hidden: number;
      more: number;
      untrusted: number;
    };
    expect(parsed.notes.map((n) => n.slug)).toEqual(["t2", "t1"]);
    expect(parsed.notes.every((n) => n.scope === branch)).toBe(true);
    expect(parsed.hidden).toBe(0);
    expect(parsed.more).toBe(0);
    expect(parsed.untrusted).toBe(0);
  });

  test("list --prefix <slash-bounded> --limit 1 → one note + more:1", () => {
    // SDK's for-each-ref pattern is literal up to a slash boundary, so the
    // prefix MUST end in `/` to match multiple slugs. (`--prefix t` against
    // slugs `t1`, `t2` returns nothing — that's SDK contract, not a CLI bug.)
    const aIso = new Date(Date.now() - 500).toISOString();
    const bIso = new Date(Date.now() - 250).toISOString();
    runCli(["record", "--slug", "auth/login", "--body", "x", "--json"], {
      cwd: fixture.repo,
      env: { GIT_AUTHOR_DATE: aIso, GIT_COMMITTER_DATE: aIso },
    });
    runCli(["record", "--slug", "auth/logout", "--body", "y", "--json"], {
      cwd: fixture.repo,
      env: { GIT_AUTHOR_DATE: bIso, GIT_COMMITTER_DATE: bIso },
    });
    const { code, stdout } = runCli(["list", "--prefix", "auth/", "--limit", "1", "--json"], {
      cwd: fixture.repo,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { notes: unknown[]; more: number };
    expect(parsed.notes.length).toBe(1);
    expect(parsed.more).toBe(1);
  });

  test("read --json → slug/scope/body", () => {
    const { code, stdout } = runCli(["read", "--slug", "t1", "--json"], { cwd: fixture.repo });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { slug: string; scope: string; body: string };
    expect(parsed.slug).toBe("t1");
    expect(parsed.scope).toBe(branch);
    expect(parsed.body).toBe("first body");
  });

  test("read missing slug → exit 1, NOT_FOUND on stdout JSON + stderr", () => {
    const { code, stdout, stderr } = runCli(["read", "--slug", "nonexistent", "--json"], {
      cwd: fixture.repo,
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as { error: string };
    expect(parsed.error).toBe("NOT_FOUND");
    expect(stderr).toMatch(/^NOT_FOUND:/);
  });

  test("forget existing slug → deleted:true; re-run → deleted:false (idempotent)", () => {
    const first = runCli(["forget", "--slug", "t1", "--json"], { cwd: fixture.repo });
    expect(first.code).toBe(0);
    const p1 = JSON.parse(first.stdout) as { deleted: boolean; scope: string };
    expect(p1.deleted).toBe(true);
    expect(p1.scope).toBe(branch);

    const second = runCli(["forget", "--slug", "t1", "--json"], { cwd: fixture.repo });
    expect(second.code).toBe(0);
    const p2 = JSON.parse(second.stdout) as { deleted: boolean };
    expect(p2.deleted).toBe(false);
  });

  test("list after forget → tombstoned slug filtered out", () => {
    runCli(["forget", "--slug", "t1", "--json"], { cwd: fixture.repo });
    const { code, stdout } = runCli(["list", "--json"], { cwd: fixture.repo });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { notes: Array<{ slug: string }> };
    expect(parsed.notes.map((n) => n.slug)).toEqual(["t2"]);
  });

  test("no --json → human format: list summary line + slug rows, read raw body, forget single line", () => {
    const ls = runCli(["list"], { cwd: fixture.repo });
    expect(ls.code).toBe(0);
    expect(ls.stdout).toMatch(/^2 notes \(hidden=0 more=0 untrusted=0\)\n/);
    expect(ls.stdout).toMatch(new RegExp(`\nt2\t${branch}\t`));
    expect(ls.stdout).toMatch(new RegExp(`\nt1\t${branch}\t`));

    const rd = runCli(["read", "--slug", "t2"], { cwd: fixture.repo });
    expect(rd.code).toBe(0);
    expect(rd.stdout).toBe("second body");

    const fg = runCli(["forget", "--slug", "t2"], { cwd: fixture.repo });
    expect(fg.code).toBe(0);
    expect(fg.stdout).toBe(`forgot t2 (scope=${branch})\n`);
  });
});

describe("mneo CLI — copy", () => {
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

  test("--from --to --slug --json → exit 0, copied[1] with sha + unchanged:false", () => {
    runCli(["record", "--slug", "n", "--body", "x", "--scope", "feat-x", "--json"], {
      cwd: fixture.repo,
    });
    const { code, stdout, stderr } = runCli(
      ["copy", "--from", "feat-x", "--to", "main", "--slug", "n", "--json"],
      { cwd: fixture.repo },
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as {
      from: string;
      to: string;
      copied: Array<{ slug: string; sha: string; unchanged: boolean }>;
      skipped: unknown[];
    };
    expect(parsed.from).toBe("feat-x");
    expect(parsed.to).toBe("main");
    expect(parsed.copied.length).toBe(1);
    expect(parsed.copied[0]?.slug).toBe("n");
    expect(parsed.copied[0]?.unchanged).toBe(false);
    expect(parsed.copied[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.skipped).toEqual([]);
  });

  test("re-copying same content → unchanged:true", () => {
    runCli(["record", "--slug", "n", "--body", "x", "--scope", "feat-x", "--json"], {
      cwd: fixture.repo,
    });
    runCli(["copy", "--from", "feat-x", "--to", "main", "--slug", "n", "--json"], {
      cwd: fixture.repo,
    });
    const { code, stdout } = runCli(
      ["copy", "--from", "feat-x", "--to", "main", "--slug", "n", "--json"],
      { cwd: fixture.repo },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { copied: Array<{ unchanged: boolean }> };
    expect(parsed.copied[0]?.unchanged).toBe(true);
  });

  test("single-slug collision → exit 1, CONFLICT on stdout JSON + stderr", () => {
    runCli(["record", "--slug", "n", "--body", "feat", "--scope", "feat-x", "--json"], {
      cwd: fixture.repo,
    });
    runCli(["record", "--slug", "n", "--body", "main", "--scope", "main", "--json"], {
      cwd: fixture.repo,
    });
    const { code, stdout, stderr } = runCli(
      ["copy", "--from", "feat-x", "--to", "main", "--slug", "n", "--json"],
      { cwd: fixture.repo },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as { error: string };
    expect(parsed.error).toBe("CONFLICT");
    expect(stderr).toMatch(/^CONFLICT:/);
  });

  test("bulk with --prefix → multiple copied, others untouched", () => {
    runCli(["record", "--slug", "auth/oauth", "--body", "o", "--scope", "feat-x", "--json"], {
      cwd: fixture.repo,
    });
    runCli(["record", "--slug", "auth/jwt", "--body", "j", "--scope", "feat-x", "--json"], {
      cwd: fixture.repo,
    });
    runCli(["record", "--slug", "db/pg", "--body", "p", "--scope", "feat-x", "--json"], {
      cwd: fixture.repo,
    });
    const { code, stdout } = runCli(
      ["copy", "--from", "feat-x", "--to", "main", "--prefix", "auth/", "--json"],
      { cwd: fixture.repo },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { copied: Array<{ slug: string }> };
    expect(parsed.copied.map((c) => c.slug).sort()).toEqual(["auth/jwt", "auth/oauth"]);
  });

  test("missing --from → exit 2, usage error on stderr", () => {
    const { code, stderr } = runCli(["copy", "--to", "main", "--slug", "x"], {
      cwd: fixture.repo,
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/--from required/);
  });

  test("no --json → human summary line + per-slug rows", () => {
    runCli(["record", "--slug", "n", "--body", "x", "--scope", "feat-x", "--json"], {
      cwd: fixture.repo,
    });
    const { code, stdout, stderr } = runCli(
      ["copy", "--from", "feat-x", "--to", "main", "--slug", "n"],
      { cwd: fixture.repo },
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toMatch(/^copied 1 skipped 0 \(feat-x -> main\)\n/);
    expect(stdout).toMatch(/\n {2}\+ n @ [0-9a-f]{7}\n$/);
  });
});

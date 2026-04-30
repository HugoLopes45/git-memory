// CLI failure isolation. Black-box tests spawning `bun cli.ts ...` in
// adversarial conditions. The hook MUST never block a Claude Code prompt:
// any error path → exit 0 + valid JSON envelope + empty additionalContext.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type TempRepo, makeTempRepo } from "./helpers/repo.ts";

const CLI = join(import.meta.dir, "../packages/git-memory/src/cli.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined> } = { cwd: tmpdir() },
): RunResult {
  // Build env: start from current, layer overrides, drop entries explicitly
  // unset (passed as undefined). spawnSync only accepts string values.
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") merged[k] = v;
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const r = spawnSync("bun", [CLI, ...args], {
    cwd: opts.cwd,
    env: merged,
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

interface Envelope {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

function parseEnvelope(stdout: string): Envelope {
  return JSON.parse(stdout.trim()) as Envelope;
}

describe("git-memory CLI — failure isolation", () => {
  test("cwd outside any git repo → exit 0, valid envelope, empty additionalContext", () => {
    const { code, stdout } = runCli(["context"], {
      cwd: tmpdir(),
      env: { GIT_MEMORY_REPO: undefined },
    });
    expect(code).toBe(0);
    const env = parseEnvelope(stdout);
    expect(env.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(env.hookSpecificOutput.additionalContext).toBe("");
  });

  test("GIT_MEMORY_REPO=/nonexistent → exit 0, empty additionalContext", () => {
    const { code, stdout } = runCli(["context"], {
      cwd: tmpdir(),
      env: { GIT_MEMORY_REPO: "/this/path/does/not/exist/anywhere" },
    });
    expect(code).toBe(0);
    expect(parseEnvelope(stdout).hookSpecificOutput.additionalContext).toBe("");
  });

  describe("with a fixture repo", () => {
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

    test("repo with no notes → exit 0, empty additionalContext", () => {
      const { code, stdout } = runCli(["context"], {
        cwd: fixture.repo,
        env: { GIT_MEMORY_REPO: undefined },
      });
      expect(code).toBe(0);
      expect(parseEnvelope(stdout).hookSpecificOutput.additionalContext).toBe("");
    });

    test("corrupted ref (non-SHA contents) → exit 0, valid envelope", () => {
      // Plant a ref file with garbage. for-each-ref errors out → list()
      // throws → CLI try/catch swallows → empty bundle.
      const refDir = join(fixture.repo, ".git", "refs", "agent-memory", "main");
      mkdirSync(refDir, { recursive: true });
      writeFileSync(join(refDir, "corrupted"), "not-a-valid-sha-at-all\n");
      const { code, stdout } = runCli(["context"], {
        cwd: fixture.repo,
        env: { GIT_MEMORY_REPO: undefined },
      });
      expect(code).toBe(0);
      const env = parseEnvelope(stdout);
      expect(env.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(typeof env.hookSpecificOutput.additionalContext).toBe("string");
    });
  });

  // ─── arg-error paths exit 2 (these AREN'T hook calls; user typo'd a flag) ──

  test("--budget with non-numeric value → exit 2, stderr explains", () => {
    const { code, stderr } = runCli(["context", "--budget", "abc"], { cwd: tmpdir() });
    expect(code).toBe(2);
    expect(stderr).toMatch(/budget/);
  });

  test("unknown subcommand → exit 2, stderr explains", () => {
    const { code, stderr } = runCli(["wat"], { cwd: tmpdir() });
    expect(code).toBe(2);
    expect(stderr).toMatch(/unknown command|usage/);
  });

  // ─── init-hook end-to-end ────────────────────────────────────────────────

  describe("init-hook", () => {
    let proj: string;

    beforeEach(() => {
      proj = mkdtempSync(join(tmpdir(), "init-hook-cli-"));
    });

    afterEach(() => {
      rmSync(proj, { recursive: true, force: true });
    });

    test("creates .claude/settings.json with SessionStart entry + matcher", () => {
      const { code, stdout } = runCli(["init-hook"], { cwd: proj });
      expect(code).toBe(0);
      expect(stdout).toMatch(/Wrote.*settings\.json/);
      const settingsPath = join(proj, ".claude", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const entry = settings.hooks.SessionStart[0];
      expect(entry.matcher).toBe("startup|resume|clear|compact");
      expect(entry.hooks[0].command).toBe("npx -y git-memory context --budget 2000");
      // No UserPromptSubmit key written.
      expect(settings.hooks.UserPromptSubmit).toBeUndefined();
    });

    test("idempotent end-to-end: second invocation reports already-configured", () => {
      runCli(["init-hook"], { cwd: proj });
      const { code, stdout } = runCli(["init-hook"], { cwd: proj });
      expect(code).toBe(0);
      expect(stdout).toMatch(/Already configured/);
    });
  });
});

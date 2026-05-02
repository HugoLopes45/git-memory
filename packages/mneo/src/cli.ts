#!/usr/bin/env node
// CLI entry: context [--budget N] | init-hook | install
// context MUST exit 0 even on failure — a crashing hook blocks the Claude Code session.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { context } from "./context.js";
import { findProjectDir, installHook, installMcp, installSkill } from "./init-hook.js";

function emit(text: string) {
  // SessionStart fires on startup/resume/clear/compact and re-injects the
  // bundle once per event — not once per turn. additionalContext is the
  // documented field; Claude Code wraps it in a system reminder.
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: text,
    },
  });
  process.stdout.write(`${payload}\n`);
}

const sub = process.argv[2];
const args = process.argv.slice(3);

if (sub === "context") {
  // Optional `--budget N`. Default lives in context().
  const bIdx = args.indexOf("--budget");
  let budget: number | undefined;
  if (bIdx >= 0) {
    budget = Number(args[bIdx + 1]);
    if (Number.isNaN(budget)) {
      process.stderr.write("--budget requires a number\n");
      process.exit(2);
    }
  }
  try {
    emit(context({ charBudget: budget }).text);
  } catch {
    // Never block the prompt, regardless of why context() failed (no repo,
    // no notes, git missing, ref corruption, ...). Coverage in tests/cli.test.ts.
    emit("");
  }
  process.exit(0);
}

if (sub === "init-hook") {
  // npx resolves the published binary at exec time, so the hook command is
  // path-free and survives package updates without a rewrite.
  const command = "npx -y mneo context --budget 2000";
  // Walk up from cwd to find the project's .git — handles `init-hook` run
  // from a subdirectory.
  const projectDir = findProjectDir(process.cwd());
  const r = installHook({ projectDir, hookCommand: command });
  if (r.written && r.replaced) {
    process.stdout.write(`Replaced legacy hook in ${r.path}\n`);
  } else if (r.written) {
    process.stdout.write(`Wrote ${r.path}\n`);
  } else {
    process.stdout.write(`Already configured: ${r.path}\n`);
  }
  process.exit(0);
}

// Resolve the bundled SKILL.md content. The published package ships SKILL.md
// at the package root (see packages/mneo/package.json `files`). When running
// from source via `bun packages/mneo/src/cli.ts`, the same path resolves to
// the canonical SKILL.md at the repo root via the second candidate.
function readSkillContent(): string {
  const candidates = [
    new URL("../SKILL.md", import.meta.url), // dist/cli.js → packages/mneo/SKILL.md
    new URL("../../../SKILL.md", import.meta.url), // src/cli.ts → repo root SKILL.md
  ];
  for (const url of candidates) {
    const p = fileURLToPath(url);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(
    "SKILL.md not found alongside the mneo package; reinstall mneo or report this as a bug",
  );
}

if (sub === "install") {
  const projectDir = findProjectDir(process.cwd());
  const hookCommand = "npx -y mneo context --budget 2000";

  const hook = installHook({ projectDir, hookCommand });
  const mcp = installMcp({
    projectDir,
    serverName: "mneo",
    command: "npx",
    args: ["-y", "mneo-mcp"],
  });
  const skill = installSkill({ projectDir, content: readSkillContent() });

  const tag = (r: { written: boolean; replaced?: boolean }) =>
    !r.written ? "unchanged" : r.replaced ? "replaced" : "wrote";
  process.stdout.write(`hook:  ${tag(hook).padEnd(9)} ${hook.path}\n`);
  process.stdout.write(`mcp:   ${tag(mcp).padEnd(9)} ${mcp.path}\n`);
  process.stdout.write(`skill: ${tag(skill).padEnd(9)} ${skill.path}\n`);
  process.exit(0);
}

process.stderr.write(`unknown command: ${sub ?? "(none)"}\n`);
process.stderr.write("usage: mneo context [--budget N] | init-hook | install\n");
process.exit(2);

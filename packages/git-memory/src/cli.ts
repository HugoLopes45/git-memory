#!/usr/bin/env node
// CLI entry. Sub-commands:
//   context [--budget N]  — emit hook payload (SessionStart)
//   init-hook             — write/merge the hook entry into .claude/settings.json
//
// `context` is invoked by Claude Code's SessionStart hook on startup, resume,
// clear, and compact. It MUST exit 0 even on failure: a crashing hook blocks
// the session.

import { context } from "./context.js";
import { findProjectDir, installHook } from "./init-hook.js";

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
    emit(context({ budget }).text);
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
  const command = "npx -y git-memory context --budget 2000";
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

process.stderr.write(`unknown command: ${sub ?? "(none)"}\n`);
process.stderr.write("usage: git-memory context [--budget N] | init-hook\n");
process.exit(2);

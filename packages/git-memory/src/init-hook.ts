// init-hook — write or merge a SessionStart entry into a project's
// .claude/settings.json. Idempotent: same hookCommand twice = one entry.
//
// SessionStart re-injects the bundle on startup/resume/clear/compact — once
// per event, not per turn — so the matcher defaults to those four sources.
//
// Atomic write via tmp + rename so a kill mid-flight can't corrupt the file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface InitHookOpts {
  projectDir: string;
  hookCommand: string;
  matcher?: string;
}

export interface InitHookResult {
  written: boolean;
  // True when a legacy `bun "<path>" context...` entry was replaced because
  // the referenced cli.ts no longer exists (typical after migrating from a
  // bun-based install to an npm-based install).
  replaced?: boolean;
  path: string;
}

// Walk up from `start` looking for a directory containing .git (file or dir).
// Falls back to `start` if no parent contains a git tree — caller's choice
// to install hooks in a non-repo directory.
//
// Uses the dirname() fixpoint to detect the filesystem root so it works on
// Windows (root "C:\\") as well as Unix.
export function findProjectDir(start: string): string {
  let cur = resolve(start);
  while (true) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return start;
    cur = parent;
  }
}

// Match the legacy `bun "<path>" context...` entry shape. Used for one-shot
// migration: if the absolute path no longer exists on disk, re-running
// init-hook replaces the entry with the new npx-based command.
const BUN_CTX_RE = /^bun\s+"([^"]+)"\s+context\b/;

interface HookEntry {
  type: string;
  command?: string;
}

interface MatcherEntry {
  matcher: string;
  hooks: HookEntry[];
}

interface SettingsShape {
  hooks?: { [event: string]: MatcherEntry[] | undefined };
  [key: string]: unknown;
}

// SessionStart matcher: the four sources Claude Code re-fires the event on.
// Anchored alternation — each source matches as a whole word.
const DEFAULT_MATCHER = "startup|resume|clear|compact";

export function installHook(opts: InitHookOpts): InitHookResult {
  const claudeDir = join(opts.projectDir, ".claude");
  const path = join(claudeDir, "settings.json");
  const matcher = opts.matcher ?? DEFAULT_MATCHER;

  let settings: SettingsShape = {};
  if (existsSync(path)) {
    settings = JSON.parse(readFileSync(path, "utf8")) as SettingsShape;
  }
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  const ups = settings.hooks.SessionStart;

  // Idempotent check: any existing entry with the exact command → no-op.
  const already = ups.some(
    (entry) =>
      Array.isArray(entry.hooks) && entry.hooks.some((h) => h.command === opts.hookCommand),
  );
  if (already) return { written: false, path };

  // Migration: an existing legacy `bun "<path>" context...` entry whose
  // <path> no longer exists on disk is a leftover from a bun-based install.
  // Replace it in place rather than appending a duplicate.
  let staleIdx = -1;
  ups.forEach((entry, i) => {
    if (staleIdx >= 0 || !Array.isArray(entry.hooks)) return;
    for (const h of entry.hooks) {
      if (!h.command) continue;
      const m = h.command.match(BUN_CTX_RE);
      if (m?.[1] && !existsSync(m[1])) {
        staleIdx = i;
        return;
      }
    }
  });

  if (staleIdx >= 0) {
    ups[staleIdx] = { matcher, hooks: [{ type: "command", command: opts.hookCommand }] };
  } else {
    ups.push({ matcher, hooks: [{ type: "command", command: opts.hookCommand }] });
  }

  mkdirSync(claudeDir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, path);
  return { written: true, replaced: staleIdx >= 0, path };
}

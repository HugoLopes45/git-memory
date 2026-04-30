/**
 * Install or merge a SessionStart hook entry into `.claude/settings.json`.
 * Atomic: tmp + rename prevents corruption on crash. Idempotent: same command twice = one entry.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { InvalidInputError } from "./errors.js";

export interface InitHookOpts {
  projectDir: string;
  hookCommand: string;
  /** Regex matched against SessionStart trigger source. Defaults to "startup|resume|clear|compact". */
  matcher?: string;
}

export interface InitHookResult {
  written: boolean;
  /** True when a stale bun-based hook entry was replaced (post-migration to npm). */
  replaced?: boolean;
  path: string;
}

/** Walk up from start to find the .git directory. Falls back to start if no repo found. */
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

/** Write or merge a SessionStart hook into .claude/settings.json. Idempotent: same command twice = one entry. */
export function installHook(opts: InitHookOpts): InitHookResult {
  const claudeDir = join(opts.projectDir, ".claude");
  const path = join(claudeDir, "settings.json");
  const matcher = opts.matcher ?? DEFAULT_MATCHER;

  let settings: SettingsShape = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    try {
      settings = JSON.parse(raw) as SettingsShape;
    } catch (e) {
      // Pre-existing settings.json is malformed (interrupted write, manual
      // edit, merge marker). Refuse to clobber it — surface the path so the
      // user can back up + recreate. Plain JSON.parse error tells the LLM
      // nothing actionable.
      throw new InvalidInputError(
        `${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}; back up and re-create or fix manually`,
      );
    }
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

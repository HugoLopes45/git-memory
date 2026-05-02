/**
 * Install pieces into a Claude Code project: SessionStart hook, MCP server
 * entry, and the mneo skill file. All writes are atomic (tmp + rename) and
 * idempotent (re-running a configured install is a no-op).
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

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: { [k: string]: string };
}

interface SettingsShape {
  hooks?: { [event: string]: MatcherEntry[] | undefined };
  mcpServers?: { [name: string]: McpServerEntry | undefined };
  [key: string]: unknown;
}

// Read+parse a Claude Code settings.json. Returns {} when the file doesn't
// exist; throws InvalidInputError on malformed JSON so the user gets a
// recovery prompt instead of a clobber.
function readSettings(path: string): SettingsShape {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as SettingsShape;
  } catch (e) {
    throw new InvalidInputError(
      `${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}; back up and re-create or fix manually`,
    );
  }
}

// Atomic tmp+rename write of settings.json. Caller mkdir's the parent dir.
function writeSettings(path: string, settings: SettingsShape): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, path);
}

// SessionStart matcher: the four sources Claude Code re-fires the event on.
// Anchored alternation — each source matches as a whole word.
const DEFAULT_MATCHER = "startup|resume|clear|compact";

/** Write or merge a SessionStart hook into .claude/settings.json. Idempotent: same command twice = one entry. */
export function installHook(opts: InitHookOpts): InitHookResult {
  const claudeDir = join(opts.projectDir, ".claude");
  const path = join(claudeDir, "settings.json");
  const matcher = opts.matcher ?? DEFAULT_MATCHER;

  const settings = readSettings(path);
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
  writeSettings(path, settings);
  return { written: true, replaced: staleIdx >= 0, path };
}

export interface InstallMcpOpts {
  projectDir: string;
  /** Server name used as the key under `mcpServers` in settings.json. */
  serverName: string;
  command: string;
  args?: string[];
  env?: { [k: string]: string };
}

export interface InstallMcpResult {
  written: boolean;
  /** True when an existing entry under the same name had different command/args. */
  replaced?: boolean;
  path: string;
}

/** Merge an MCP server entry into .claude/settings.json under mcpServers.<name>. Idempotent on identical config. */
export function installMcp(opts: InstallMcpOpts): InstallMcpResult {
  const claudeDir = join(opts.projectDir, ".claude");
  const path = join(claudeDir, "settings.json");

  const settings = readSettings(path);
  settings.mcpServers ??= {};
  const existing = settings.mcpServers[opts.serverName];

  const next: McpServerEntry = { command: opts.command };
  if (opts.args && opts.args.length > 0) next.args = opts.args;
  if (opts.env && Object.keys(opts.env).length > 0) next.env = opts.env;

  if (existing && JSON.stringify(existing) === JSON.stringify(next)) {
    return { written: false, path };
  }
  const replaced = existing !== undefined;
  settings.mcpServers[opts.serverName] = next;

  mkdirSync(claudeDir, { recursive: true });
  writeSettings(path, settings);
  return { written: true, replaced, path };
}

export interface InstallSkillOpts {
  projectDir: string;
  /** Markdown body of the skill — caller provides verbatim so the SDK doesn't bind to a specific source layout. */
  content: string;
  /** Skill folder name under .claude/skills/. Defaults to "mneo". */
  name?: string;
}

export interface InstallSkillResult {
  written: boolean;
  path: string;
}

/** Write SKILL.md to .claude/skills/<name>/SKILL.md. Idempotent on identical content. */
export function installSkill(opts: InstallSkillOpts): InstallSkillResult {
  const name = opts.name ?? "mneo";
  const skillDir = join(opts.projectDir, ".claude", "skills", name);
  const path = join(skillDir, "SKILL.md");

  if (existsSync(path) && readFileSync(path, "utf8") === opts.content) {
    return { written: false, path };
  }

  mkdirSync(skillDir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, opts.content);
  renameSync(tmp, path);
  return { written: true, path };
}

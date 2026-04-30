/**
 * Build a character-budget-bounded bundle of recent notes for pre-prompt injection.
 * Renders full bodies where they fit, falls back to headlines only when space is tight.
 */

import { type ListEntry, type ListOpts, RepoBrokenError, findRepo, list, read } from "./index.js";

/** Default character budget for the context bundle. */
export const DEFAULT_BUDGET = 2000;

export interface ContextOpts {
  repo?: string | undefined;
  scope?: ListOpts["scope"];
  limit?: number | undefined;
  maxAgeDays?: number | undefined;
  /**
   * Approximate character budget for the rendered bundle. Token count varies
   * for non-ASCII content (CJK, emoji) — the LLM consumer should size with
   * headroom. Defaults to DEFAULT_BUDGET.
   */
  charBudget?: number | undefined;
}

export interface ContextResult {
  text: string;
}

function renderShort(e: ListEntry): string {
  return `- [${e.scope}] ${e.slug} — ${e.h}`;
}

function renderFull(e: ListEntry, body: string): string {
  // Drop trailing whitespace so a body ending with "\n" doesn't render an
  // empty indented line.
  const trimmed = body.replace(/\s+$/, "");
  const lines = trimmed.split("\n");
  if (lines.length <= 1) return renderShort(e);
  const tail = lines
    .slice(1)
    .map((line) => (line ? `  ${line}` : ""))
    .join("\n");
  return `${renderShort(e)}\n${tail}`;
}

/** Build a token-bounded context bundle for pre-prompt injection. Returns empty string if no notes found or the repo is unusable. */
export function context(opts: ContextOpts = {}): ContextResult {
  let repo: string;
  let entries: ListEntry[];
  try {
    repo = opts.repo ?? findRepo();
    entries = list({ ...opts, repo }).entries;
  } catch (e) {
    // Graceful degradation: no repo / corrupted refs / git missing → no
    // bundle. Never block the prompt over a broken memory store. The CLI
    // catches anything that escapes; SDK consumers calling context()
    // directly get the same contract.
    if (e instanceof RepoBrokenError) return { text: "" };
    throw e;
  }
  const budget = opts.charBudget ?? DEFAULT_BUDGET;

  const parts: string[] = [];
  let used = 0;
  for (const e of entries) {
    const sep = parts.length > 0 ? 1 : 0; // joining "\n"
    let body = "";
    try {
      body = read({ repo, slug: e.slug, scope: e.scope }).body;
    } catch {
      // list just returned this ref; if read can't find it now, the ref was
      // deleted between calls. Treat as no body and fall through to short.
    }
    const full = renderFull(e, body);
    if (used + sep + full.length <= budget) {
      parts.push(full);
      used += sep + full.length;
      continue;
    }
    const short = renderShort(e);
    if (used + sep + short.length <= budget) {
      parts.push(short);
      used += sep + short.length;
      continue;
    }
    break;
  }
  return { text: parts.join("\n") };
}

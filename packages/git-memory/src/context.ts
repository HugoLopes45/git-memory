// context() — pre-prompt bundle.
//
// Slice 2: budget-bounded. For each entry (newest first), try the FULL
// rendering (bullet + indented body lines beyond the headline); fall back
// to SHORT (bullet only) if full overflows; stop when even short overflows.
// Single-line bodies render identically to the short form — the headline
// already carries the only line, so there's nothing to indent.

import { type ListEntry, type ListOpts, findRepo, list, read } from "./index.js";

export const DEFAULT_BUDGET = 2000;

export interface ContextOpts {
  repo?: string | undefined;
  scope?: ListOpts["scope"];
  limit?: number | undefined;
  maxAgeDays?: number | undefined;
  budget?: number | undefined;
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

export function context(opts: ContextOpts = {}): ContextResult {
  const repo = opts.repo ?? findRepo();
  const { entries } = list({ ...opts, repo });
  const budget = opts.budget ?? DEFAULT_BUDGET;

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

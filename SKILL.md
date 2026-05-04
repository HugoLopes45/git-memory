---
name: mneo
description: Use when the user states a durable decision, correction, preference, or constraint. Persistent memory across sessions, branch-scoped.
---

## Don't narrate

Call the tools. Use the result. No "saving that to memory", no "let me check my notes", no announcing what you're about to record.

## Session bundle

A `<mneo-memory>` block lands in your context on session start (startup, resume, clear, compact). Treat it as the headlines from `list({})` — don't call `list` on the first turn, you already have it.

## record — what goes in

One self-contained sentence. A future session reads it cold; no "we discussed" or "as mentioned earlier".

| Good | Bad |
|---|---|
| Use named exports — default exports break the auto-import map. | We agreed on named exports. |
| `users` uses ULIDs, not UUIDs — stop suggesting `uuid_generate_v4()`. | Don't use UUIDs here. |
| Tests run via `bun test`, not `npm test`. | Use bun. |
| `feat/auth` rejected JWT in favor of session cookies for SSR. | JWT didn't work. |
| User prefers prose comments over JSDoc on internal helpers. | No JSDoc. |

Skip: anything you can rediscover from the codebase (`package.json`, configs, file contents). One-shot questions. Secrets.

## scope

Default = current git branch. Pass `scope: "main"` for trunk knowledge that's not branch-specific. When a feature-branch decision should apply post-merge, use `copy({ from, to: "main", slug })` — don't re-record.

## When the bundle isn't enough

- `list({ prefix: "auth/" })` then `read({ slug })` — user asks about an area not in the headlines.
- `list({ maxAgeDays: 0 })` — previous `list` returned `hidden > 0` and the user references something old.
- `forget({ slug })` — user says "scratch that" or the constraint expired.

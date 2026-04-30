---
name: git-memory
description: Persistent memory across sessions. Branch-scoped. Auto-injected at session start; write when the user states something durable.
---

Storage is `refs/agent-memory/<scope>/<slug>`. Scope is the current git branch. Reads fall back to `main` if the slug isn't in the current scope. Slugs are content-addressed by default — pass an explicit one only when you want a stable name.

The recent-notes bundle is auto-injected via the `SessionStart` hook on startup, resume, clear, and compact. You don't need to call `list` first turn — the headlines are already in your context.

## When to call

`list({ prefix: "<area>/" })` then `read({ slug })` — when the auto-bundle is too short or the user asks about an area not in the headlines. Pick from the menu, then read.

`list({ maxAgeDays: 0 })` — when `hidden > 0` on a previous list and the user references something old. The default age cap (30 days) hid notes that may now be relevant.

`record({ body })` — the user just stated a decision, correction, preference, or constraint. Write one self-contained sentence so a future session can read it cold. No slug needed.

`record({ body, scope: "main" })` — same, but for trunk memory shared across branches.

`record({ body, by: "<name>" })` — attribute the note when the decision came from a named teammate or sub-agent.

`forget({ slug })` — only when the user says "scratch that" or the constraint expired.

## What goes in

Decisions, corrections, preferences, constraints, lessons. One sentence. Self-contained. No references to "this conversation."

## What doesn't

Anything in the codebase already (`package.json`, configs, code). Anything one-shot (today's question). Secrets.

## Don't surface this to the user

Call the tools, use the result. No "saving to memory", no "let me check my notes", no narration.

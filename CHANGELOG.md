# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- CI workflow (lint + typecheck + test on PR and `main`).
- `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`.
- Issue templates (bug, feature) and PR template.
- npm metadata (`repository`, `homepage`, `bugs`, `keywords`) on published packages.
- Typed error contract: `GitMemoryError` base class with `NotFoundError`, `InvalidInputError`, `RepoBrokenError`, `ConflictError` subclasses (each carries a stable `code`). MCP `fail()` now serializes typed errors as `{code, message}` JSON for LLM consumers.

### Changed
- README rewritten for clarity and SEO surface (persistent memory, MCP server, vector-database counter-positioning).
- `findRepo` now delegates to git itself (`rev-parse --git-dir` for the env path, `--show-toplevel` for walk-up) — non-repo directories with a stray `HEAD` file no longer false-accept.
- `branchToScope` validates the normalized form against the scope alphabet and throws `InvalidInputError` with a recovery prompt when the branch can't auto-map (underscore, dot, `@`, etc.). The recovery message names `GIT_MEMORY_SCOPE` so the LLM has a path forward without renaming the branch.
- `context()` now degrades gracefully on `RepoBrokenError`: returns `{ text: "" }` so SDK consumers get the same contract the CLI relied on, instead of an unguarded throw.
- `forget` (single-scope) is now idempotent under race: if the ref is deleted between `rev-parse` and `update-ref -d`, returns `{ deleted: false }` instead of leaking a `git update-ref` error.

### Breaking
- `ContextOpts.budget` renamed to `charBudget`. The field measures characters (not tokens, despite the previous JSDoc); the rename makes the contract honest. The CLI flag `--budget` is unchanged for existing hook configs; it's translated at the boundary.

## [0.1.0] - 2026-04-30

### Added
- Four-verb SDK: `record`, `list`, `read`, `forget`. Notes stored at `refs/agent-memory/<scope>/<slug>`.
- MCP server (`git-memory-mcp`) over stdio for Claude Code, Cursor, OpenCode.
- Claude Code session-start hook installer (`git-memory init-hook`) that wires `.claude/settings.json`.
- `git-memory context` CLI for the hook payload (bullet headlines + budget-capped bodies).
- Per-call author override via `record({ body, by })`.
- `list({})` returns `{ entries, hidden }`, with a 30-day age filter and 50-entry cap.
- Bulk `read` returns partial results instead of all-or-nothing.
- Validation errors include a recovery suggestion in the message.

### Security
- Trust boundary documented: note bodies become trusted prompt context. Don't sync `refs/agent-memory/*` from a remote you don't control.
- Hardened against race conditions, sentinel collision, and Windows path edge cases.

[Unreleased]: https://github.com/HugoLopes45/git-memory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/HugoLopes45/git-memory/releases/tag/v0.1.0

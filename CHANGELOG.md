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
- Typed error contract: `MneoError` base class with `NotFoundError`, `InvalidInputError`, `RepoBrokenError`, `ConflictError` subclasses (each carries a stable `code`). MCP `fail()` now serializes typed errors as `{code, message}` JSON for LLM consumers.
- `mneo install` subcommand: one-shot wiring of the SessionStart hook, the MCP server entry under `mcpServers.mneo`, and `.claude/skills/mneo/SKILL.md`. Idempotent on identical content; preserves unrelated keys in `settings.json`. Replaces the previous four-step manual flow.
- `recordAsync(opts)` SDK export: async sibling of `record()` that yields the JS event loop between CAS retries via `setTimeout`. `mneo-mcp` switches to it so a contended write no longer freezes the stdio event loop for up to 200ms.
- `MNEO_REQUIRE_SIGNED` env flag (`1` or `true`): opt-in trust gate. When set, `list()` filters notes whose commit fails `git verify-commit` (counted as `untrusted` in the result) and `read()` throws the new `UntrustedError` (`code: "UNTRUSTED"`). Defends against the documented push-injection vector for users fetching `refs/agent-memory/*` from a peer they don't fully control.
- `SKEW_TOLERANCE_SECONDS` constant (60s) and `ListResult.skewed`: `list()` drops commits dated more than 60s ahead of `now` and surfaces the count. Defends against pinning attacks via `GIT_COMMITTER_DATE=2099` that previously bypassed `maxAgeDays` forever.
- `ListResult.more`: count of entries that satisfied every filter (age, trust gate, skew) but did not fit under `limit`. Lets callers detect when the default `LIMIT=50` silently truncated their data.
- CLI subcommands `mneo record | list | read | forget` — thin wrappers over the SDK so non-Node consumers (bash, Python, Rust agents) can shell out without embedding the TS package. `--json` emits a stable JSON shape; absent flag emits a single human line. `MneoError` maps to exit `1` with `{error, message}` on stdout and `code: message` on stderr; usage errors exit `2`. `record` reads the body from `--body` or stdin.

### Changed
- README rewritten for clarity and SEO surface (persistent memory, MCP server, vector-database counter-positioning).
- `findRepo` now delegates to git itself (`rev-parse --git-dir` for the env path, `--show-toplevel` for walk-up) — non-repo directories with a stray `HEAD` file no longer false-accept.
- `branchToScope` validates the normalized form against the scope alphabet and throws `InvalidInputError` with a recovery prompt when the branch can't auto-map (underscore, dot, `@`, etc.). The recovery message names `MNEO_SCOPE` so the LLM has a path forward without renaming the branch.
- `context()` now degrades gracefully on `RepoBrokenError`: returns `{ text: "" }` so SDK consumers get the same contract the CLI relied on, instead of an unguarded throw.
- `forget` (single-scope) is now idempotent under race: if the ref is deleted between `rev-parse` and `update-ref -d`, returns `{ deleted: false }` instead of leaking a `git update-ref` error.
- `record()` refactored to share a `recordSteps()` generator with the new `recordAsync()`; sync semantics unchanged.
- `list()`'s default `LIMIT=50` and `MAX_AGE_DAYS=30` are now explicitly documented as heuristics in `LIST_DEFAULT_LIMIT` and `LIST_DEFAULT_MAX_AGE_DAYS` JSDoc; the new `more` counter exposes when they bite.

### Breaking
- `ContextOpts.budget` renamed to `charBudget`. The field measures characters (not tokens, despite the previous JSDoc); the rename makes the contract honest. The CLI flag `--budget` is unchanged for existing hook configs; it's translated at the boundary.
- `currentScope()` now enumerates `refs/heads/` and throws `InvalidInputError` when another local branch normalizes to the same scope (e.g. `feat/foo-bar` and `feat-foo-bar` both → `feat-foo-bar`). The recovery message names `MNEO_SCOPE`. Replaces the previous silent merge of refs across the colliding branches; callers that relied on the merge must now set `MNEO_SCOPE` or pass an explicit `scope` argument.

## [0.1.0] - 2026-04-30

### Added
- Four-verb SDK: `record`, `list`, `read`, `forget`. Notes stored at `refs/agent-memory/<scope>/<slug>`.
- MCP server (`mneo-mcp`) over stdio for Claude Code, Cursor, OpenCode.
- Claude Code session-start hook installer (`mneo init-hook`) that wires `.claude/settings.json`.
- `mneo context` CLI for the hook payload (bullet headlines + budget-capped bodies).
- Per-call author override via `record({ body, by })`.
- `list({})` returns `{ entries, hidden }`, with a 30-day age filter and 50-entry cap.
- Bulk `read` returns partial results instead of all-or-nothing.
- Validation errors include a recovery suggestion in the message.

### Security
- Trust boundary documented: note bodies become trusted prompt context. Don't sync `refs/agent-memory/*` from a remote you don't control.
- Hardened against race conditions, sentinel collision, and Windows path edge cases.

[Unreleased]: https://github.com/HugoLopes45/mneo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/HugoLopes45/mneo/releases/tag/v0.1.0

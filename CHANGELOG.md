# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `copy` verb — cross-scope memory transport. `copy({ from, to, slug })` creates a target ref pointing at the same source commit (same sha, body, createdAt); source is preserved. Pass `prefix` for bulk, omit both to copy the whole source scope. Idempotent; single-slug collision throws `CONFLICT`, bulk skips with `reason: 'collision'`. Wired into SDK, CLI, and MCP. Use case: promote a feature-branch decision to `main` after merge without re-recording.
- CLI subcommands `mneo record | list | read | forget | copy` — thin SDK wrappers for non-Node consumers (bash, Python, Rust). `--json` for machines, human one-liner by default. Exit `1` on `MneoError` (code on stderr), `2` on usage. `record` reads the body via `--body` or stdin.
- `mneo install` — one-shot wiring of SessionStart hook + `mcpServers.mneo` entry + `.claude/skills/mneo/SKILL.md`. Idempotent on identical content; preserves unrelated keys in `settings.json`. Replaces the previous four-step manual flow.
- `recordAsync(opts)` SDK export — async sibling of `record()` that yields the JS event loop between CAS retries. `mneo-mcp` switches to it so a contended write no longer freezes the stdio event loop.
- Typed error contract — `MneoError` base + `NotFoundError`, `InvalidInputError`, `RepoBrokenError`, `ConflictError`, `UntrustedError`, `SyncConflictError`. Each carries a stable `code`. MCP serializes them as `{code, message}` JSON for LLM consumers.
- `MNEO_REQUIRE_SIGNED=1` opt-in trust gate. `list()` filters notes whose commit fails `git verify-commit` (counted as `untrusted`); `read()` throws `UntrustedError`. Defends the push-injection vector when fetching `refs/agent-memory/*` from peers you don't fully control.
- Skew defense — `list()` drops commits dated more than `SKEW_TOLERANCE_SECONDS` (60s) ahead of `now`, counted in `ListResult.skewed`. Defends against pinning attacks via future `GIT_COMMITTER_DATE` that previously bypassed `maxAgeDays`.
- `ListResult.more` — count of entries that survived every filter but did not fit under `limit`. Surfaces silent truncation by the default `LIMIT=50`.
- Always-on `<mneo-memory>` framing on the SessionStart hook bundle. Notes are wrapped with a directive instructing the model to treat them as data, not instructions. ~95-char overhead; defense-in-depth on top of `MNEO_REQUIRE_SIGNED`.
- Headline sanitization — control chars (ANSI escapes, BEL, DEL, CR) stripped before headlines reach the caller. A crafted commit subject from a fetched ref can't rewrite terminal output or corrupt JSON consumers.
- `MANIFESTO.md` — principles and explicit refusals. The boundary that closes feature requests for embeddings, daemons, and domain ontologies.
- CI workflow (lint + typecheck + test on PR and `main`).
- `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`, issue templates (bug, feature), PR template.
- npm metadata (`repository`, `homepage`, `bugs`, `keywords`) on published packages.

### Changed
- README rewritten for the dev evaluator — pain → punch → proof flow, concrete `git show` example up top, five-verb pitch with `copy` included. Removed the long internal-spec "Safeguards" section; those invariants live in JSDoc and `SECURITY.md`.
- `SKILL.md` tightened for the LLM consumer — human-facing prose removed, the don't-narrate directive sharpened, good/bad `record` examples in a comparison table.
- `findRepo` delegates to git itself (`rev-parse --git-dir` for the env path, `--show-toplevel` for walk-up). Non-repo directories with a stray `HEAD` file no longer false-accept.
- `branchToScope` validates the normalized form against the scope alphabet and throws `InvalidInputError` when the branch can't auto-map (underscore, dot, `@`, etc.). Recovery message names `MNEO_SCOPE`.
- `context()` degrades gracefully on `RepoBrokenError` — returns `{ text: "" }` so SDK consumers get the same contract the CLI relies on, instead of an unguarded throw.
- `forget` (single-scope) is idempotent under race — if the ref is deleted between `rev-parse` and `update-ref -d`, returns `{ deleted: false }` instead of leaking a `git update-ref` error.
- `record()` refactored to share a `recordSteps()` generator with `recordAsync()`; sync semantics unchanged.
- `list()` defaults `LIMIT=50` and `MAX_AGE_DAYS=30` documented as heuristics in `LIST_DEFAULT_LIMIT` / `LIST_DEFAULT_MAX_AGE_DAYS` JSDoc; the new `more` counter exposes when they bite.

### Breaking
- `ContextOpts.budget` renamed to `charBudget`. The field measures characters, not tokens; the rename makes the contract honest. CLI flag `--budget` unchanged — translated at the boundary.
- `currentScope()` enumerates `refs/heads/` and throws `InvalidInputError` when another local branch normalizes to the same scope (`feat/foo-bar` and `feat-foo-bar` both → `feat-foo-bar`). Recovery message names `MNEO_SCOPE`. Replaces the previous silent merge across colliding branches; callers that relied on the merge must set `MNEO_SCOPE` or pass an explicit `scope`.

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

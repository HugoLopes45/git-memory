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

### Changed
- README rewritten for clarity and SEO surface (persistent memory, MCP server, vector-database counter-positioning).

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

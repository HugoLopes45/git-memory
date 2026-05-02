# mneo

**Persistent memory for AI agents — branches are scopes, git refs are storage.**

Your coding agent forgot what it figured out in `feat/auth` yesterday. You're about to install a vector database, a daemon, and an embedding pipeline to fix it.

Don't. `git` already does this. Branches are scopes. Refs are storage. `push` and `fetch` are sync. Four verbs, zero infrastructure. Ships as an [MCP server](https://modelcontextprotocol.io) for Claude Code, or a TypeScript SDK for any agent.

```ts
record({ body })      // save what the agent learned
list({})              // headlines on this branch
read({ slug })        // full body
forget({ slug })      // delete
```

No vector store. No daemon. No SQLite. No embeddings. No init step.

---

## How it's stored

```
refs/agent-memory/feat-auth/oauth-flow
refs/agent-memory/main/architecture
refs/agent-memory/main/db-schema
```

One git ref per note. Slashes in branch names become dashes (`feat/auth` → `feat-auth`). The note's first line becomes the commit subject — that's what `list` returns as headlines.

Sync it like code:

```bash
git push  origin 'refs/agent-memory/*:refs/agent-memory/*'
git fetch origin '+refs/agent-memory/*:refs/agent-memory/*'
```

Inspect it like code:

```bash
git log  refs/agent-memory/feat-auth/oauth-flow
git show refs/agent-memory/feat-auth/oauth-flow:note.md
```

---

## Install

```bash
npm install -g mneo mneo-mcp
# or zero-install:
npx -y mneo <subcommand>
```

Requires Node `>=18` and `git >= 2.31`.

---

## Use from the shell

For consumers that aren't Node — agents written in bash, Python, Rust, or any language that can spawn a process — the four verbs are exposed as CLI subcommands. JSON output with `--json`, human one-liners by default, exit `1` on `MneoError` (code in payload + on stderr), `2` on usage errors.

```bash
echo "decision body" | mneo record --slug oauth/flow --json
mneo list --prefix oauth/ --limit 5 --json
mneo read --slug oauth/flow --json
mneo forget --slug oauth/flow --json
```

`record` accepts the body via `--body "..."` or stdin. `list` supports `--prefix`, `--scope`, `--limit`. All four accept `--scope` to override the auto-detected branch scope.

---

## Wire it into Claude Code (MCP server + skill)

One command:

```bash
cd your-project
npx -y mneo install
```

Wires three pieces into `.claude/`:

1. **Session-start hook** that auto-loads recent memory into the agent's context on `startup | resume | clear | compact`. Errors exit 0 — broken memory never blocks the agent.
2. **MCP server entry** under `mcpServers.mneo` exposing the four verbs to the model.
3. **Skill file** at `.claude/skills/mneo/SKILL.md` telling the model when to call which verb.

All writes are atomic (tmp + rename) and idempotent — re-running `mneo install` on a configured project reports each piece as `unchanged`. Existing settings.json keys (permissions, other MCP servers, other hook entries) are preserved.

The hook injects recent headlines automatically. The skill tells the model when to expand them with `read`, or pull older notes via `list({ maxAgeDays: 0 })`.

<details>
<summary>Manual install (if you don't want the orchestrator)</summary>

```bash
npx -y mneo init-hook       # 1. SessionStart hook only
```

```jsonc
// 2. .claude/settings.json — MCP server entry
{
  "mcpServers": {
    "mneo": {
      "command": "npx",
      "args": ["-y", "mneo-mcp"]
    }
  }
}
```

```bash
# 3. Skill file
mkdir -p .claude/skills/mneo
ln -s "$(pwd)/SKILL.md" .claude/skills/mneo/SKILL.md
```
</details>

---

## Configuration

| Var | Default | Use |
|---|---|---|
| `MNEO_REPO` | walks up from `cwd` | repo path override |
| `MNEO_SCOPE` | current branch | useful in CI / detached HEAD; also disambiguates branch-collision throws |
| `MNEO_AUTHOR` | `mneo <agent@mneo>` | stamp commits with the agent's identity |
| `MNEO_REQUIRE_SIGNED` | unset | `1` or `true` → gate `list` / `read` on `git verify-commit`; unsigned notes are filtered (counted as `untrusted`) and `read` throws `UntrustedError`. You configure git's signing keys (`gpg.format`, `user.signingkey`, `gpg.ssh.allowedSignersFile`); mneo asks the question. |

Per-call author override: pass `by` to `record`.

---

## Trust boundary

Note bodies become trusted prompt context for every agent turn. Don't sync `refs/agent-memory/*` from a remote you don't control — a teammate's note (or a compromised CI agent's) becomes part of your agent's instructions.

**Scope is the trust boundary.** The library does not authenticate writers by default — anyone with write access to `refs/agent-memory/<scope>/*` can plant a note the agent will read on the next session and treat as instructions. Default scope is the auto-normalized current branch; branches with characters outside `[a-z0-9/-]` are rejected at the SDK boundary, and branches that would normalize to the same scope (e.g. `feat/foo-bar` and `feat-foo-bar`) now throw `InvalidInputError` at call time — set `MNEO_SCOPE` explicitly or pass an explicit `scope` to disambiguate.

**Opt-in signature gate.** Set `MNEO_REQUIRE_SIGNED=1` to refuse notes whose commit doesn't pass `git verify-commit`. Unsigned entries are dropped from `list` (counted as `untrusted`); `read` throws `UntrustedError`. You configure git's signing keys; mneo asks the question. Recommended whenever you fetch `refs/agent-memory/*` from a remote you don't fully control.

**Always-on framing at the hook boundary.** The SessionStart hook (`mneo context`) wraps the injected bundle in `<mneo-memory>` tags with a directive instructing the model to treat note contents as data rather than instructions. This is defense-in-depth on top of the signature gate — it costs ~95 chars of budget and helps even when signing is off. Programmatic `context()` callers receive raw bullets and are expected to wrap them in their own prompts.

**Treat memory pushes like code pushes.** `refs/agent-memory/*` is not pushed by the default refspec; explicit sync is opt-in. If you wire it, an attacker with write to that remote owns your agent's prompt — unless you've gated reads via `MNEO_REQUIRE_SIGNED`.

---

## Limits

| | |
|---|---|
| body | 5000 chars |
| slug | `^[a-z0-9][a-z0-9-/]*$`, ≤80 chars |
| scope | `^[a-z0-9][a-z0-9-]*$`, ≤80 chars |
| headline | first 80 chars of body |

`record` is idempotent: same body under the same `(scope, slug)` → no new commit, returns `{ unchanged: true }`. `recordAsync` is the same contract over a Promise — use it from MCP servers and other async hosts so a contended write doesn't block the event loop.

`list({})` returns notes from the last 30 days, capped at 50. The result carries up to four counters so callers can detect silent drops:

| Field | Meaning |
|---|---|
| `hidden` | dropped by `maxAgeDays`. Retry with `maxAgeDays: 0` to reach them. |
| `untrusted` | dropped because their commit failed `git verify-commit` (only present when `MNEO_REQUIRE_SIGNED` is set). |
| `skewed` | dropped because their commit is dated more than 60s in the future (defends against pinning attacks). |
| `more` | survived every filter but didn't fit under `limit`. Raise `limit` to see them. |

The 30-day window and 50-entry cap are heuristics in the absence of a calibrated retrieval benchmark — pass explicit `maxAgeDays` / `limit` when your workload differs.

`forget({ scope: "*" })` removes the slug from every scope.

To purge a leaked secret immediately:

```bash
git reflog expire --expire=now --all && git gc --prune=now
```

---

## Why git refs instead of a vector database?

- The LLM ranks better than any embedding model on prompt-context retrieval. `list → read` is enough.
- Vector databases need a daemon, an index, and an embedding API. Git is already on every developer's machine.
- Branches give you scoping for free. RAG systems re-implement this with metadata filters.
- Facets, tags, importance levels — encode them in the slug if you need them. Convention beats taxonomy.
- No TTL. `git gc` reclaims unreachable objects after `gc.pruneExpire` (default 14 days post-`forget`). The age filter on `list` hides stale notes from the menu — it doesn't delete them.

The API is shaped for an LLM caller: tool descriptions are model instructions, errors are recovery prompts, sentinels (`*`) live in a namespace disjoint from valid inputs so the model can't collide with them. There is no UI to optimize for.

---

## Contributing

```bash
git clone git@github.com:HugoLopes45/mneo.git
cd mneo
bun install
bun test
bun run lint
```

Bun `>=1.3.0`. `bun.lock` is canonical. Branches: `feat/<short-name>` from `main`.

---

## Credits

Inspired by [Mourad Ghafiri's `git-notes-memory`](https://github.com/mourad-ghafiri/git-notes-memory).

---

## License

[MIT](LICENSE).

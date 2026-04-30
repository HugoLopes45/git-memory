# git-memory

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
npm install -g git-memory git-memory-mcp
# or zero-install:
npx -y git-memory <subcommand>
```

Requires Node `>=18` and `git >= 2.31`.

---

## Wire it into Claude Code (MCP server + skill)

Three pieces, one command each.

**1. Session-start hook** — auto-loads recent memory into the agent's context at session start:

```bash
cd your-project
npx -y git-memory init-hook
```

Fires on `startup | resume | clear | compact`. Errors exit 0 — broken memory never blocks the agent.

**2. MCP server** — exposes the four verbs to the model:

```jsonc
{
  "mcpServers": {
    "git-memory": {
      "command": "npx",
      "args": ["-y", "git-memory-mcp"]
    }
  }
}
```

**3. Skill file** — tells the model when to call which verb:

```bash
mkdir -p .claude/skills/git-memory
ln -s "$(pwd)/SKILL.md" .claude/skills/git-memory/SKILL.md
```

The hook injects recent headlines automatically. The skill tells the model when to expand them with `read`, or pull older notes via `list({ maxAgeDays: 0 })`.

---

## Configuration

| Var | Default | Use |
|---|---|---|
| `GIT_MEMORY_REPO` | walks up from `cwd` | repo path override |
| `GIT_MEMORY_SCOPE` | current branch | useful in CI / detached HEAD |
| `GIT_MEMORY_AUTHOR` | `git-memory <agent@git-memory>` | stamp commits with the agent's identity |

Per-call author override: pass `by` to `record`.

---

## Trust boundary

Note bodies become trusted prompt context for every agent turn. Don't sync `refs/agent-memory/*` from a remote you don't control — a teammate's note (or a compromised CI agent's) becomes part of your agent's instructions.

**Scope is the trust boundary.** The library does not authenticate writers — anyone with write access to `refs/agent-memory/<scope>/*` can plant a note the agent will read on the next session and treat as instructions. Default scope is the auto-normalized current branch; branches with characters outside `[a-z0-9/-]` are rejected at the SDK boundary, but in-alphabet branches can still collapse to the same scope (`feat/foo-bar` and `feat-foo-bar` both → `feat-foo-bar`). For shared-repo or untrusted-peer scenarios, set `GIT_MEMORY_SCOPE` explicitly instead of relying on branch detection.

**Treat memory pushes like code pushes.** `refs/agent-memory/*` is not pushed by the default refspec; explicit sync is opt-in. If you wire it, an attacker with write to that remote owns your agent's prompt.

---

## Limits

| | |
|---|---|
| body | 5000 chars |
| slug | `^[a-z0-9][a-z0-9-/]*$`, ≤80 chars |
| scope | `^[a-z0-9][a-z0-9-]*$`, ≤80 chars |
| headline | first 80 chars of body |

`record` is idempotent: same body under the same `(scope, slug)` → no new commit, returns `{ unchanged: true }`.

`list({})` returns notes from the last 30 days, capped at 50, with a `hidden` count for what got dropped. `maxAgeDays: 0` to surface them.

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
git clone git@github.com:HugoLopes45/git-memory.git
cd git-memory
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

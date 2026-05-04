# mneo

**Persistent memory for AI agents. No vector DB. No daemon. Just git.**

> Why mneo exists and what it refuses to be: [MANIFESTO.md](MANIFESTO.md).

Your coding agent forgot what it figured out in `feat/auth` yesterday. The internet's answer is a vector database, an embedding pipeline, a daemon, and a $20/mo SaaS.

git already does this.

```bash
$ git show refs/agent-memory/feat-auth/oauth-flow:note.md
Rejected JWT — session cookies for SSR. Don't re-propose.
```

Branches are scopes. Refs are storage. `push` and `fetch` are sync. Five verbs, zero infrastructure.

```ts
record({ body })                  // save what worked
list({})                          // headlines on this branch
read({ slug })                    // expand a headline
copy({ from, to, slug })          // promote past merge
forget({ slug })                  // outdated
```

Ships as an [MCP server](https://modelcontextprotocol.io) for Claude Code, or a TypeScript SDK for any agent. ~1500 lines of TypeScript. Zero runtime deps in the SDK. The notes survive uninstall.

---

## How it's stored

```
refs/agent-memory/feat-auth/oauth-flow
refs/agent-memory/main/architecture
refs/agent-memory/main/db-schema
```

One git ref per note. Slashes in branch names become dashes (`feat/auth` → `feat-auth`). The note's first line becomes the commit subject — that's what `list` returns as headlines.

Inspect like code:

```bash
git log  refs/agent-memory/feat-auth/oauth-flow
git show refs/agent-memory/feat-auth/oauth-flow:note.md
```

Sync like code:

```bash
git push  origin 'refs/agent-memory/*:refs/agent-memory/*'
git fetch origin '+refs/agent-memory/*:refs/agent-memory/*'
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

## Wire it into Claude Code

One command:

```bash
cd your-project
npx -y mneo install
```

Three pieces land in `.claude/`:

1. A **session-start hook** that auto-injects recent headlines on `startup | resume | clear | compact`. Failures exit 0 — broken memory never blocks the agent.
2. An **MCP server** exposing `record`, `list`, `read`, `forget`, `copy`, `push`, `fetch`.
3. A **skill file** at `.claude/skills/mneo/SKILL.md` telling the model when to call which verb.

Atomic and idempotent. Re-running `mneo install` reports each piece as `unchanged`; unrelated `settings.json` keys are preserved.

<details>
<summary>Manual install (no orchestrator)</summary>

```bash
npx -y mneo init-hook       # 1. SessionStart hook only
```

```jsonc
// 2. .claude/settings.json — MCP server entry
{
  "mcpServers": {
    "mneo": { "command": "npx", "args": ["-y", "mneo-mcp"] }
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

## Use from any language

For agents in bash, Python, Rust — anything that can spawn a process. `--json` for machines, human one-liners by default. Exit `1` on `MneoError` (code on stderr), `2` on usage.

```bash
echo "decision body" | mneo record --slug oauth/flow --json
mneo list   --prefix oauth/ --limit 5 --json
mneo read   --slug oauth/flow --json
mneo copy   --from feat-x --to main --slug oauth/flow --json
mneo forget --slug oauth/flow --json
```

`record` reads the body via `--body` or stdin. All verbs accept `--scope` to override the auto-detected branch. `copy` takes `--from` and `--to`, plus either `--slug` (single) or `--prefix` (bulk); omit both to copy the whole source scope.

---

## Trust boundary

Note bodies become trusted prompt context for every agent turn. **Scope is the trust boundary.** Anyone with write access to `refs/agent-memory/<scope>/*` can plant a note your agent will read on the next session and treat as instructions.

`refs/agent-memory/*` is **not** pushed by the default refspec — sync is opt-in. If you wire it, treat memory pushes like code pushes.

Defenses:

- The session-start hook wraps the bundle in `<mneo-memory>` tags telling the model to treat the contents as data, not instructions. Always on.
- Set `MNEO_REQUIRE_SIGNED=1` to gate `list` and `read` on `git verify-commit`. Recommended whenever you fetch `refs/agent-memory/*` from a remote you don't fully control.

Full threat model: [SECURITY.md](SECURITY.md).

---

## Configuration

| Var | Default | Use |
|---|---|---|
| `MNEO_REPO` | walks up from cwd | repo path override |
| `MNEO_SCOPE` | current branch | CI / detached HEAD / branch-collision disambiguation |
| `MNEO_AUTHOR` | `mneo <agent@mneo>` | stamp commits with the agent's identity |
| `MNEO_REQUIRE_SIGNED` | unset | `1` or `true` → reject unsigned notes (`UntrustedError`) |

Per-call author override: pass `by` to `record`.

---

## Why not a vector database?

- The LLM ranks better than any embedding model on prompt-context retrieval. `list → read` is enough.
- Vector DBs need a daemon, an index, and an embedding API. Git is already on every dev's machine.
- Branches give scoping for free. RAG re-implements this with metadata filters.
- Tags, importance, facets — encode them in the slug. Convention beats taxonomy.
- No TTL. `git gc` reclaims unreachable objects after `gc.pruneExpire` (default 14 days post-`forget`).

The API is shaped for an LLM caller: tool descriptions are model instructions, errors are recovery prompts, sentinels (`*`) live in a namespace disjoint from valid inputs. There is no UI to optimize for.

---

## Limits

| | |
|---|---|
| body | 5000 chars |
| slug | `^[a-z0-9][a-z0-9-/]*$`, ≤80 chars |
| scope | `^[a-z0-9][a-z0-9-]*$`, ≤80 chars |
| headline | first 80 chars of body |

`record` is idempotent: same `(scope, slug, body)` returns `{ unchanged: true }` and creates no new commit.

`list({})` defaults to last 30 days, max 50 entries. The result carries `hidden` / `untrusted` / `skewed` / `more` counters so callers can detect when filters dropped data — bump `maxAgeDays` or `limit` to surface it.

`forget({ scope: "*" })` removes the slug from every scope. To purge a leaked secret immediately:

```bash
git reflog expire --expire=now --all && git gc --prune=now
```

---

## Contributing

```bash
git clone git@github.com:HugoLopes45/mneo.git
cd mneo
bun install
bun test
bun run lint
```

Bun `>=1.3.0`. `bun.lock` is canonical. Branches: `feat/<short-name>` from `main`. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Credits

Inspired by [Mourad Ghafiri's `git-notes-memory`](https://github.com/mourad-ghafiri/git-notes-memory).

## License

[MIT](LICENSE).

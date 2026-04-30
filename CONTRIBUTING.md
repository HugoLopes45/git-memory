# Contributing

Read the README first. The "Why git refs instead of a vector database?" section is the design boundary — PRs that cross it (search, embeddings, schemas, tags) get closed.

## Setup

```bash
git clone https://github.com/HugoLopes45/git-memory.git
cd git-memory
bun install
bun run lint && bun run typecheck && bun test
```

Requires `bun >= 1.3.0`. Don't run `npm install` — `bun.lock` is canonical.

## Discipline

- English only — code, comments, commits.
- Comments only when the *why* is non-obvious.
- No new runtime deps without a clear reason. SDK has zero, MCP has two (`@modelcontextprotocol/sdk`, `zod`).
- Surgical changes. Match existing style.
- Add a test for any new behavior or fixed bug. `bun test`.

## Branches and commits

- Branch from `main`: `feat/<short-name>` or `fix/<short-name>`.
- [Conventional Commits](https://www.conventionalcommits.org/): `feat: ...`, `fix: ...`, `refactor: ...`, `docs: ...`. Breaking: `feat!: ...`.
- One concern per PR. Refactors and behavior changes go in separate commits.

## License

[MIT](LICENSE). Contributions accepted under the same terms.

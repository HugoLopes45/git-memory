# mneo — Manifesto

Coding agents lose the thread between sessions.

Every existing memory solution is too heavy for what they actually need: a few notes, persisted, retrievable. Git is already in every project. Use it.

## What mneo is

- A primitive: five verbs — `record`, `list`, `read`, `forget`, `copy` — plus `push` and `fetch` for sync.
- Storage: `refs/agent-memory/<scope>/<slug>` — git refs, nothing else.
- A library, a CLI, an MCP server. **The library is the primitive.** CLI and MCP are equal-rank artifacts that wrap it.
- The consumer is an LLM. Tool descriptions, errors, JSON shapes are written for the model — not for humans browsing docs.

## What mneo is not

- Not a vector store. Not RAG. Not a knowledge graph.
- Not a domain ontology. `kind`, `tags`, `supersedes` are caller conventions that live in the body. mneo doesn't see them.
- Not a daemon. Not a backend. Not a cloud service.
- Not a database. Notes are commits. Slugs are refs. History is `git log`.

## Principles

1. **Git is the substrate.** Refs are storage. Push, pull, branch, history, `git gc` — all free. If git can't do it, mneo doesn't do it.
2. **Plain text is the contract.** Markdown bodies, content-addressed slugs (`sha1(body)[:12]`). Diffable. Portable. Auditable years after uninstall.
3. **The LLM is the consumer.** Tool descriptions teach the discipline. Errors are recovery prompts in one line. JSON is first-class.
4. **The trust boundary is the scope.** No authentication baked in. Pulled refs from peers are framed as untrusted at session-start. Signed commits are opt-in via `MNEO_REQUIRE_SIGNED`.
5. **Caveman writes, lazy reads.** Notes are short, atomic, addressable. The LLM scans a TOC of headlines first, reads only what it needs.
6. **One verb per concept.** `record`, `list`, `read`, `forget`, `copy`, `push`, `fetch`. No `promote`, no `archive`, no `bookmark` — `copy` is the agnostic transport that callers compose into those.

## Refusals

We will not:

- Add embedding-based search. Text + git is the contract.
- Bake in domain semantics. Your `kind` lives in the body.
- Run a daemon. CLI and MCP server are both stateless.
- Silently merge conflicting writes. CAS exhaustion raises a loud error.
- Add features the LLM can compose from existing verbs.
- Optimize for human ergonomics. The consumer is a model.

## The outcome we serve

A coding agent opens a session on a 100k-line codebase. It already knows:

- What was decided yesterday on this branch
- The conventions in the module it's editing
- The approaches that have already failed
- The thread of work it left mid-stream

It doesn't re-ask. It doesn't re-propose rejected options. It doesn't redo failed attempts. The thread is preserved across sessions, branches, and machines.

That is what mneo is for. Everything else is incidental.

## Proof

- One install command: `npx mneo install`
- Zero daemons, zero cloud, zero embedding service
- ~1500 lines of TypeScript, two runtime dependencies in the MCP package (`@modelcontextprotocol/sdk`, `zod`); the SDK has none
- Notes survive uninstall: `git log refs/agent-memory/<scope>/<slug>`
- Untrusted by default: every fetched note is wrapped in `<mneo-memory>` framing telling the model not to execute its content
- Idempotent writes: same body → same slug → same SHA, every time

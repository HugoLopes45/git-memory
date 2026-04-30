# Security Policy

## Reporting a Vulnerability

Open a private [security advisory](https://github.com/HugoLopes45/git-memory/security/advisories/new), or email `hlopescau@gmail.com` if that's not available.

**Do not file a public issue for vulnerabilities.** Expect a first response within 72h.

## Supported Versions

The latest minor on the current major. Older versions receive no fixes.

## Threat Model

git-memory stores agent notes as git refs. Note bodies become trusted prompt context for every agent turn. The trust boundary — including the scope auto-detection rules and when to set `GIT_MEMORY_SCOPE` explicitly — is documented in the README.

### In scope

- Sentinel collision or scope escape (a slug or scope value that bypasses the regex and writes outside the intended namespace).
- Path traversal in slug, scope, or ref name handling.
- Prompt injection via crafted note bodies that escape the intended rendering or instruction context.
- Race conditions on concurrent `record` / `forget` calls that corrupt refs.
- The session-start hook leaking note content outside the agent process.
- Vulnerabilities in the MCP server's stdio transport.

### Out of scope

- An attacker who already has write access to your local repo or to a remote you've fetched from. `Treat memory pushes like code pushes` — a teammate's compromised note is your problem to detect, not ours to prevent at the protocol level.
- DoS by recording very large numbers of notes (caps documented in the README).
- Vulnerabilities in `git` itself, or in Node, Bun, or `@modelcontextprotocol/sdk`.

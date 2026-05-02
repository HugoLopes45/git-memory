# Security Policy

## Reporting a Vulnerability

Open a private [security advisory](https://github.com/HugoLopes45/mneo/security/advisories/new), or email `hlopescau@gmail.com` if that's not available.

**Do not file a public issue for vulnerabilities.** Expect a first response within 72h.

## Supported Versions

The latest minor on the current major. Older versions receive no fixes.

## Threat Model

mneo stores agent notes as git refs. Note bodies become trusted prompt context for every agent turn. The trust boundary — including the scope auto-detection rules and when to set `MNEO_SCOPE` explicitly — is documented in the README.

For workflows that fetch `refs/agent-memory/*` from a remote you don't fully control, set `MNEO_REQUIRE_SIGNED=1` to gate `list` / `read` on `git verify-commit`. Unsigned notes are filtered out of `list` (counted as `untrusted`) and `read` throws `UntrustedError`. You configure git's signing keys (`gpg.format`, `user.signingkey`, `gpg.ssh.allowedSignersFile`); mneo asks the question.

### In scope

- Sentinel collision or scope escape (a slug or scope value that bypasses the regex and writes outside the intended namespace).
- Path traversal in slug, scope, or ref name handling.
- Prompt injection via crafted note bodies that escape the intended rendering or instruction context.
- Race conditions on concurrent `record` / `forget` calls that corrupt refs.
- The session-start hook leaking note content outside the agent process.
- Vulnerabilities in the MCP server's stdio transport.
- Pinning attacks via future-dated commit timestamps that bypass `maxAgeDays` — mitigated by the 60s skew tolerance (`SKEW_TOLERANCE_SECONDS`); a regression in that filter is in scope.
- Bypass of the `MNEO_REQUIRE_SIGNED` gate (e.g. an unsigned note surfacing in `list` or readable via `read` while the env flag is set).

### Out of scope

- An attacker who already has write access to your local repo or to a remote you've fetched from, with `MNEO_REQUIRE_SIGNED` unset. `Treat memory pushes like code pushes` — a teammate's compromised note is your problem to detect at that point. The signed-commit gate is the recommended defense.
- DoS by recording very large numbers of notes (caps documented in the README).
- Vulnerabilities in `git` itself, or in Node, Bun, or `@modelcontextprotocol/sdk`.

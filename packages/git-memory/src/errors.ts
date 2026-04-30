/**
 * Typed errors for git-memory.
 *
 * The consumer of this API is an LLM. Errors must be recovery prompts: the
 * `code` is machine-routable (used by the MCP layer to surface a structured
 * payload), `message` reads as one line of human guidance.
 *
 * - NOT_FOUND       — slug doesn't exist in any tried scope
 * - INVALID_INPUT   — caller passed something the SDK rejects (bad scope/slug/body)
 * - REPO_BROKEN     — git itself failed (no repo, missing binary, ref corruption)
 * - CONFLICT        — CAS contention exhausted retries
 */

export type GitMemoryErrorCode = "NOT_FOUND" | "INVALID_INPUT" | "REPO_BROKEN" | "CONFLICT";

export class GitMemoryError extends Error {
  readonly code: GitMemoryErrorCode;
  constructor(code: GitMemoryErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "GitMemoryError";
  }
}

export class NotFoundError extends GitMemoryError {
  constructor(message: string) {
    super("NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class InvalidInputError extends GitMemoryError {
  constructor(message: string) {
    super("INVALID_INPUT", message);
    this.name = "InvalidInputError";
  }
}

export class RepoBrokenError extends GitMemoryError {
  constructor(message: string) {
    super("REPO_BROKEN", message);
    this.name = "RepoBrokenError";
  }
}

export class ConflictError extends GitMemoryError {
  constructor(message: string) {
    super("CONFLICT", message);
    this.name = "ConflictError";
  }
}

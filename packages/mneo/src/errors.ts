/**
 * Typed errors for mneo.
 *
 * The consumer of this API is an LLM. Errors must be recovery prompts: the
 * `code` is machine-routable (used by the MCP layer to surface a structured
 * payload), `message` reads as one line of human guidance.
 *
 * - NOT_FOUND       — slug doesn't exist in any tried scope
 * - INVALID_INPUT   — caller passed something the SDK rejects (bad scope/slug/body)
 * - REPO_BROKEN     — git itself failed (no repo, missing binary, ref corruption)
 * - CONFLICT        — CAS contention exhausted retries
 * - UNTRUSTED       — ref exists but its commit signature failed verification
 *                     (only emitted when MNEO_REQUIRE_SIGNED is set)
 * - SYNC_CONFLICT   — push rejected due to non-fast-forward (remote advanced)
 */

export type MneoErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "REPO_BROKEN"
  | "CONFLICT"
  | "UNTRUSTED"
  | "SYNC_CONFLICT";

export class MneoError extends Error {
  readonly code: MneoErrorCode;
  constructor(code: MneoErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "MneoError";
  }
}

export class NotFoundError extends MneoError {
  constructor(message: string) {
    super("NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class InvalidInputError extends MneoError {
  constructor(message: string) {
    super("INVALID_INPUT", message);
    this.name = "InvalidInputError";
  }
}

export class RepoBrokenError extends MneoError {
  constructor(message: string) {
    super("REPO_BROKEN", message);
    this.name = "RepoBrokenError";
  }
}

export class ConflictError extends MneoError {
  constructor(message: string) {
    super("CONFLICT", message);
    this.name = "ConflictError";
  }
}

export class UntrustedError extends MneoError {
  constructor(message: string) {
    super("UNTRUSTED", message);
    this.name = "UntrustedError";
  }
}

export class SyncConflictError extends MneoError {
  constructor(message: string) {
    super("SYNC_CONFLICT", message);
    this.name = "SyncConflictError";
  }
}

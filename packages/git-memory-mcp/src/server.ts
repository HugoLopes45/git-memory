// MCP server: 4 tools mirroring the SDK. record, list, read, forget.
// Tool descriptions are written for an LLM consumer — they explain the
// scope/slug model so the model can scope by branch or feature without
// us shipping a facet system.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { forget, list, read, record } from "git-memory";
import { z } from "zod";

export const SERVER_NAME = "git-memory";
export const SERVER_VERSION = "0.1.0";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}

const SCOPE_DESC =
  "scope = namespace; default is the current git branch. Pass 'main' to write trunk memory shared across branches.";

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "record",
    {
      description:
        "Save a memory note. By default the slug is auto-generated from the body hash — pass an explicit slug only when you want a stable name (e.g. 'auth/oauth-flow'). Re-recording identical content is a no-op; different content under the same slug appends a commit (history preserved). Body ≤5000 chars; first line becomes the headline. Pass `by` to attribute the note to a named teammate or sub-agent.",
      inputSchema: {
        body: z.string().min(1).max(5000).describe("markdown; first line = headline"),
        slug: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe("optional stable name; defaults to sha1(body)[:12]"),
        scope: z.string().min(1).max(80).optional().describe(SCOPE_DESC),
        by: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe(
            "override commit author name (single line, ≤80 chars); defaults to GIT_MEMORY_AUTHOR or 'git-memory'",
          ),
        repo: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return ok(record(args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list",
    {
      description:
        "List memory notes, newest first. Returns { entries, hidden }: entries are headlines (call `read` for body); hidden is the count of notes filtered out by maxAgeDays. If hidden > 0 and the user references something old, retry with `maxAgeDays: 0`. Defaults: current scope + 'main' fallback, last 30 days, max 50 entries.",
      inputSchema: {
        scope: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            "scope filter: '*' for every namespace, a single literal name, or an array of names. Default: current + main.",
          ),
        prefix: z.string().optional().describe("slug prefix filter, e.g. 'auth/' or 'feat-X/'"),
        limit: z.number().int().positive().optional().describe("default 50"),
        maxAgeDays: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("hide notes older than this many days; default 30; 0 = no age filter"),
        repo: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return ok(list(args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "read",
    {
      description:
        "Read a note's full body. Looks in the current scope first, then falls back to 'main'. Pass scope to read from a specific namespace.",
      inputSchema: {
        slug: z.string().min(1).max(80),
        scope: z.string().min(1).max(80).optional().describe(SCOPE_DESC),
        repo: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return ok(read(args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "forget",
    {
      description:
        "Delete a note from a scope (defaults to current scope). Returns { deleted: false } if the note didn't exist there. Won't touch other scopes. Pass scope:'*' to remove the slug from every scope at once — best-effort + idempotent: a per-ref failure (concurrent writer) is skipped, not raised, and re-running forget after a partial deletion is safe and converges. The `scopes` field on the result lists every scope the slug was actually deleted from.",
      inputSchema: {
        slug: z.string().min(1).max(80),
        scope: z.string().min(1).max(80).optional().describe(SCOPE_DESC),
        repo: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return ok(forget(args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

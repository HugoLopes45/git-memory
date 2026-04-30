// End-to-end MCP smoke. Spawns the real bin via the SDK's stdio transport
// so the wire format is exercised, not mocked.
//
// Coverage:
//   - tools/list reports the 4 tools (record, list, read, forget)
//   - record → list → read happy path
//   - read on a missing slug surfaces { isError: true }
//   - forget then read returns isError
//   - list accepts maxAgeDays and the age filter survives the wire

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { type TempRepo, makeTempRepo } from "../../../tests/helpers/repo.ts";

const BIN_PATH = join(import.meta.dir, "../src/bin.ts");

interface CallToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [BIN_PATH],
    env: process.env as Record<string, string>,
  });
  const client = new Client({ name: "git-memory-mcp-smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function unwrap<T = unknown>(res: CallToolResult): T {
  if (res.isError) throw new Error(res.content[0]?.text ?? "tool returned isError");
  const text = res.content[0]?.text ?? "";
  return JSON.parse(text) as T;
}

describe("git-memory-mcp", () => {
  let fixture: TempRepo;

  beforeEach(() => {
    fixture = makeTempRepo();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("exposes 4 tools: record, list, read, forget", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["forget", "list", "read", "record"]);
    });
  });

  test("record → list → read happy path", async () => {
    await withClient(async (client) => {
      const recorded = unwrap<{ slug: string; unchanged: boolean }>(
        (await client.callTool({
          name: "record",
          arguments: { repo: fixture.repo, slug: "auth/oauth", body: "use OAuth2 for SSO" },
        })) as CallToolResult,
      );
      expect(recorded.unchanged).toBe(false);

      const listed = unwrap<{ entries: Array<{ slug: string; h: string }>; hidden: number }>(
        (await client.callTool({
          name: "list",
          arguments: { repo: fixture.repo, prefix: "auth/" },
        })) as CallToolResult,
      );
      expect(listed.entries.map((e) => e.slug)).toEqual(["auth/oauth"]);
      expect(listed.entries[0]?.h).toBe("use OAuth2 for SSO");
      expect(listed.hidden).toBe(0);

      const got = unwrap<{ slug: string; body: string }>(
        (await client.callTool({
          name: "read",
          arguments: { repo: fixture.repo, slug: "auth/oauth" },
        })) as CallToolResult,
      );
      expect(got.body).toBe("use OAuth2 for SSO");
    });
  });

  test("read on a missing slug returns isError", async () => {
    await withClient(async (client) => {
      const res = (await client.callTool({
        name: "read",
        arguments: { repo: fixture.repo, slug: "does-not-exist" },
      })) as CallToolResult;
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/not found/);
    });
  });

  test("forget then read returns isError", async () => {
    await withClient(async (client) => {
      await client.callTool({
        name: "record",
        arguments: { repo: fixture.repo, slug: "x", body: "y", scope: "main" },
      });
      const f = unwrap<{ deleted: boolean }>(
        (await client.callTool({
          name: "forget",
          arguments: { repo: fixture.repo, slug: "x", scope: "main" },
        })) as CallToolResult,
      );
      expect(f.deleted).toBe(true);

      const res = (await client.callTool({
        name: "read",
        arguments: { repo: fixture.repo, slug: "x", scope: "main" },
      })) as CallToolResult;
      expect(res.isError).toBe(true);
    });
  });

  test("list accepts maxAgeDays through the wire (forwarded to SDK)", async () => {
    // Wire-format check: does the MCP tool accept `maxAgeDays` and forward it?
    // Filtering semantics (boundary, re-record bumping ts, etc.) are covered
    // at the SDK layer.
    await withClient(async (client) => {
      await client.callTool({
        name: "record",
        arguments: { repo: fixture.repo, slug: "fresh", body: "x", scope: "main" },
      });
      const res = unwrap<{ entries: Array<{ slug: string }>; hidden: number }>(
        (await client.callTool({
          name: "list",
          arguments: { repo: fixture.repo, maxAgeDays: 0 },
        })) as CallToolResult,
      );
      expect(res.entries.map((e) => e.slug)).toEqual(["fresh"]);
    });
  });

  test("list with default age filter hides notes older than 30 days", async () => {
    // Backdate a note's commit, then list with default maxAgeDays.
    // The note is still in the ref store but absent from the list output —
    // re-call with maxAgeDays:0 to surface it.
    const { spawnSync } = await import("node:child_process");
    await withClient(async (client) => {
      await client.callTool({
        name: "record",
        arguments: { repo: fixture.repo, slug: "old", body: "ancient note", scope: "main" },
      });
    });
    const oldTs = `${Math.floor(Date.now() / 1000) - 60 * 86400} +0000`;
    const env = {
      ...process.env,
      GIT_COMMITTER_DATE: oldTs,
      GIT_AUTHOR_DATE: oldTs,
    } as Record<string, string>;
    const tree = spawnSync(
      "git",
      ["-C", fixture.repo, "rev-parse", "refs/agent-memory/main/old^{tree}"],
      { encoding: "utf8" },
    ).stdout.trim();
    const newSha = spawnSync(
      "git",
      ["-C", fixture.repo, "commit-tree", tree, "-m", "ancient note"],
      { encoding: "utf8", env },
    ).stdout.trim();
    spawnSync("git", ["-C", fixture.repo, "update-ref", "refs/agent-memory/main/old", newSha], {
      encoding: "utf8",
    });

    await withClient(async (client) => {
      const filtered = unwrap<{ entries: unknown[]; hidden: number }>(
        (await client.callTool({
          name: "list",
          arguments: { repo: fixture.repo },
        })) as CallToolResult,
      );
      expect(filtered.entries).toEqual([]);
      // The backdated note shows up in `hidden` so the model knows to retry.
      expect(filtered.hidden).toBe(1);

      const open = unwrap<{ entries: Array<{ slug: string }>; hidden: number }>(
        (await client.callTool({
          name: "list",
          arguments: { repo: fixture.repo, maxAgeDays: 0 },
        })) as CallToolResult,
      );
      expect(open.entries.map((e) => e.slug)).toEqual(["old"]);
      expect(open.hidden).toBe(0);
    });
  });
});

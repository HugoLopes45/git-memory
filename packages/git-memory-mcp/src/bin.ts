#!/usr/bin/env node
// stdio entrypoint. Spawned by the agent runtime (Claude Code, Cursor,
// OpenCode); communicates via JSON-RPC over stdin/stdout.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);

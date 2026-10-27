#!/usr/bin/env bun
/** The shells container's canopy launcher supports only the MCP server. */
import { mcpCommand } from "../src/cli/mcp";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const [word, ...rest] = process.argv.slice(2);
if (word !== "mcp") fail("canopy's CLI is not in the shells container; only canopy mcp runs here. Use the page or the API for the rest.");
await mcpCommand(rest, { fail }).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));

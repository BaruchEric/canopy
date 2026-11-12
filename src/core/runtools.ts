/** The rules a run's canopy tools live under (FR-038): how many children, how
 *  deep, who counts as kin, and what the run's `mcp.json` holds. Pure and
 *  browser-safe; the file itself is `server/runtools.ts`. */

import type { KitMcpEntry, Run, RunAction } from "./types";

/** the live children one run may have */
export const RUN_CHILDREN = 3;
/** how deep a chain goes: a run at depth 0 may start a child at depth 1, and
 *  a child may not start one at depth 2 */
export const RUN_DEPTH = 2;
/** Claude's permission rule that lets one MCP server's tools run with no ask */
export const mcpRule = (server: string): string => `mcp__${server}__*`;
/** the rule for canopy's own tools (probe P2) */
export const CANOPY_TOOL_RULE = mcpRule("canopy");
/** A child is a job on a branch. A chat would hold its slot idle until
 *  someone stopped it. */
export const RUN_CHILD_ACTIONS: readonly RunAction[] = ["ask", "propose"];

/** Why `parent` may not start a child with `live` children going, or null. */
export function childRefusal(parent: (Pick<Run, "id" | "status"> & Partial<Pick<Run, "depth" | "unattended">>) | undefined, live: number): string | null {
  if (!parent) return "that run is gone, so it cannot start a child";
  if (parent.status !== "working" && parent.status !== "waiting" && parent.status !== "idle") return `run ${parent.id} has ended, so it cannot start a child`;
  // an unattended run reads outside text, and outside text never starts work
  if (parent.unattended) return `run ${parent.id} is unattended, and an unattended run does not start children`;
  if ((parent.depth ?? 0) + 1 >= RUN_DEPTH) return `run ${parent.id} is itself a child, and a child does not start children`;
  if (live >= RUN_CHILDREN) return `run ${parent.id} has ${live} children going; wait for one to end`;
  return null;
}

/** How a harness that names the server on its own command line starts it.
 *  `args` ends in `--run-config <file>`, so no token rides on argv. */
export interface McpLaunch {
  command: string;
  args: readonly string[];
}

/** Whether one run is the other's parent. */
export const areKin = (a: Pick<Run, "id" | "parent">, b: Pick<Run, "id" | "parent">): boolean => a.parent === b.id || b.parent === a.id;

export interface McpEntry {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
}

/** What a run's `mcp.json` holds: every server it is given, canopy's among them. */
export const mcpConfigJson = (servers: Readonly<Record<string, McpEntry | KitMcpEntry>>): string => `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;

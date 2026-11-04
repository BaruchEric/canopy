/** A run's `mcp.json` (FR-038): `<config dir>/run-tools/<id>.mcp.json`, a 0600
 *  file in a 0700 folder, holding the run's token for the `canopy` MCP server.
 *  It sits apart from `runs/<id>/`, which the transcript owns and removes whole
 *  when a credential collides with its metadata. Bun-only. */
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../core/store";
import { mcpConfigJson, type McpEntry } from "../core/runtools";

const SUFFIX = ".mcp.json";

export const toolsDir = (): string => join(configDir(), "run-tools");
export const mcpConfigPath = (id: string, dir = toolsDir()): string => join(dir, `${id}${SUFFIX}`);

/** The server a run starts: this canopy's own MCP entry under this bun, so it
 *  needs no `canopy` on a PATH launchd or a container may not have. */
export const canopyMcpCommand = (): Pick<McpEntry, "command" | "args"> => ({
  command: process.execPath,
  args: [join(import.meta.dir, "../../bin/canopy-mcp.ts"), "mcp"],
});

/** Writes the file and answers its path. `wx`, so it never follows a link or
 *  takes over a file that is already there. */
export async function writeMcpConfig(id: string, entry: McpEntry, dir = toolsDir()): Promise<string> {
  const file = mcpConfigPath(id, dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(file, mcpConfigJson(entry), { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
  return file;
}

export async function removeMcpConfig(id: string, dir = toolsDir()): Promise<void> {
  await rm(mcpConfigPath(id, dir), { force: true });
}

/** At start: no run outlives a restart, so no file should be here. */
export async function sweepMcpConfigs(dir = toolsDir()): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) if (name.endsWith(SUFFIX)) await rm(join(dir, name), { force: true }).catch(() => {});
}

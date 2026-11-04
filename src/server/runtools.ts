/** A run's `mcp.json` (FR-038): `<config dir>/runs/<id>/mcp.json`, a 0600 file
 *  in the run's 0700 transcript folder, holding the run's token for the
 *  `canopy` MCP server. It goes when the run ends and the folder stays, since
 *  the folder is the transcript. Bun-only. */
import { chmod, mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runsDir } from "../core/runlog";
import { mcpConfigJson, type McpEntry } from "../core/runtools";

const FILE = "mcp.json";

export const mcpConfigPath = (id: string, dir = runsDir()): string => join(dir, id, FILE);

/** The server a run starts: this canopy's own MCP entry under this bun, so it
 *  needs no `canopy` on a PATH launchd or a container may not have. */
export const canopyMcpCommand = (): Pick<McpEntry, "command" | "args"> => ({
  command: process.execPath,
  args: [join(import.meta.dir, "../../bin/canopy-mcp.ts"), "mcp"],
});

/** Writes the file and answers its path. `wx`, so it never follows a link or
 *  takes over a file that is already there. */
export async function writeMcpConfig(id: string, entry: McpEntry, dir = runsDir()): Promise<string> {
  const file = mcpConfigPath(id, dir);
  const folder = join(dir, id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  await writeFile(file, mcpConfigJson(entry), { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
  return file;
}

/** Removes the file, and the folder too when it held nothing else. */
export async function removeMcpConfig(id: string, dir = runsDir()): Promise<void> {
  await rm(mcpConfigPath(id, dir), { force: true });
  await rmdir(join(dir, id)).catch(() => {});
}

/** At start: no run outlives a restart, so no file should be here. */
export async function sweepMcpConfigs(dir = runsDir()): Promise<void> {
  const ids = await readdir(dir).catch(() => [] as string[]);
  for (const id of ids) await removeMcpConfig(id, dir).catch(() => {});
}

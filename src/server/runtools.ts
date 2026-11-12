/** A run's `mcp.json` (FR-038): `<config dir>/run-tools/<id>.mcp.json`, a 0600
 *  file in a 0700 folder, holding the run's token for the `canopy` MCP server.
 *  It sits apart from `runs/<id>/`, which the transcript owns and removes whole
 *  when a credential collides with its metadata. Bun-only. */
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../core/store";
import { mcpConfigJson, type McpEntry, type McpLaunch } from "../core/runtools";
import type { KitMcpEntry } from "../core/types";

const SUFFIX = ".mcp.json";
const SETTINGS_SUFFIX = ".settings.json";

export const toolsDir = (): string => join(configDir(), "run-tools");
export const mcpConfigPath = (id: string, dir = toolsDir()): string => join(dir, `${id}${SUFFIX}`);
export const settingsPath = (id: string, dir = toolsDir()): string => join(dir, `${id}${SETTINGS_SUFFIX}`);

/** The server a run starts: this canopy's own MCP entry under this bun, so it
 *  needs no `canopy` on a PATH launchd or a container may not have. */
export const canopyMcpCommand = (): Pick<McpEntry, "command" | "args"> => ({
  command: process.execPath,
  args: [join(import.meta.dir, "../../bin/canopy-mcp.ts"), "mcp"],
});

/** The same server for a harness that names it on its command line: the path
 *  goes on argv and `canopy mcp` reads the token from the file. */
export const runConfigLaunch = (file: string): McpLaunch => {
  const { command, args } = canopyMcpCommand();
  return { command, args: [...args, "--run-config", file] };
};

/** the brief bundled with canopy; `<config dir>/canopy-tools.md` replaces it */
export const BUNDLED_TOOLS_BRIEF = join(import.meta.dir, "../../lib/canopy-tools.md");

/** What a run holding the tools is told about them. */
export async function toolsBrief(dir = configDir()): Promise<string> {
  for (const file of [join(dir, "canopy-tools.md"), BUNDLED_TOOLS_BRIEF]) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.trim()) return text.trim();
  }
  return "You hold canopy's tools, an MCP server named canopy. You have no right to land or push, so say so rather than try.";
}

/** Writes the file and answers its path. `wx`, so it never follows a link or
 *  takes over a file that is already there. */
export async function writeMcpConfig(id: string, servers: Readonly<Record<string, McpEntry | KitMcpEntry>>, dir = toolsDir()): Promise<string> {
  return writePrivate(mcpConfigPath(id, dir), mcpConfigJson(servers), dir);
}

/** A run's own settings file, the one `--settings` its claude gets. Same
 *  guarantees as `writeMcpConfig`. */
export async function writeRunSettings(id: string, settings: Record<string, unknown>, dir = toolsDir()): Promise<string> {
  return writePrivate(settingsPath(id, dir), `${JSON.stringify(settings, null, 2)}\n`, dir);
}

async function writePrivate(file: string, text: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(file, text, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
  return file;
}

export async function removeMcpConfig(id: string, dir = toolsDir()): Promise<void> {
  await rm(mcpConfigPath(id, dir), { force: true });
}

export async function removeRunSettings(id: string, dir = toolsDir()): Promise<void> {
  await rm(settingsPath(id, dir), { force: true });
}

/** At start: no run outlives a restart, so no file should be here. */
export async function sweepMcpConfigs(dir = toolsDir()): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) if (name.endsWith(SUFFIX) || name.endsWith(SETTINGS_SUFFIX)) await rm(join(dir, name), { force: true }).catch(() => {});
}

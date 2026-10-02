/**
 * Codex writes `[projects."<dir>"] trust_level = "trusted"` into its config
 * once it trusts a folder, and a trusted folder's own `.codex/` config is
 * read. A seed is written by agents, so no seed stays trusted: canopy drops
 * any seed's table at start and before every stage Codex run.
 * `dropSeedProjects` is pure; `sweepCodexTrust` is Bun.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HEADER = /^\s*\[projects\."([^"]+)"\]\s*$/;
const ANY_HEADER = /^\s*\[/;

/** the config without any `[projects."<seeds>/…"]` table */
export function dropSeedProjects(toml: string, seeds: string): string {
  const prefix = seeds.endsWith("/") ? seeds : `${seeds}/`;
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    const head = HEADER.exec(line);
    if (head) skipping = (head[1] ?? "").startsWith(prefix);
    else if (ANY_HEADER.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

/** true when the file changed. Written aside and renamed into place, so a
 *  write codex makes at the same moment is never half overwritten. */
export async function sweepCodexTrust(codexHome: string, seeds: string): Promise<boolean> {
  const file = join(codexHome, "config.toml");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return false;
  const next = dropSeedProjects(text, seeds);
  if (next === text) return false;
  const tmp = `${file}.canopy-${process.pid}.tmp`;
  await writeFile(tmp, next);
  await rename(tmp, file);
  return true;
}

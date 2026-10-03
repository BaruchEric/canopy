/**
 * Codex writes `[projects."<dir>"] trust_level = "trusted"` into its config
 * once it trusts a folder, and a trusted folder's own `.codex/` config is
 * read. A seed is written by agents, so no seed stays trusted: canopy drops
 * any seed's table at start and before every stage Codex run.
 * `dropSeedProjects` is pure; `sweepCodexTrust` is Bun.
 */
import { chmod, chown, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

/** who the sweep runs as, and how it hands a file to another owner; tests
 *  stand in for root */
export interface SweepOwner {
  self?: { uid: number; gid: number };
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
}

/** true when the file changed. Written aside and renamed into place, so a
 *  write codex makes at the same moment is never half overwritten. The new
 *  file keeps the old one's mode, and its owner too when the sweep runs as
 *  someone else (the stage runner, as root, sweeping the stage user's
 *  config), so codex can still write it. */
export async function sweepCodexTrust(codexHome: string, seeds: string, as: SweepOwner = {}): Promise<boolean> {
  const file = join(codexHome, "config.toml");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return false;
  const next = dropSeedProjects(text, seeds);
  if (next === text) return false;
  const st = await stat(file);
  const self = as.self ?? { uid: process.getuid?.() ?? st.uid, gid: process.getgid?.() ?? st.gid };
  const tmp = `${file}.canopy-${process.pid}.tmp`;
  try {
    await writeFile(tmp, next, { mode: st.mode & 0o777 });
    await chmod(tmp, st.mode & 0o777);
    if (st.uid !== self.uid || st.gid !== self.gid) await (as.chown ?? chown)(tmp, st.uid, st.gid);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return true;
}

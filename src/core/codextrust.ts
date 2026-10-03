/**
 * Codex writes `[projects."<dir>"] trust_level = "trusted"` into its config
 * once it trusts a folder, and a trusted folder's own `.codex/` config is
 * read. A seed is written by agents, so no seed stays trusted: canopy drops
 * any seed's table at start and before every stage Codex run.
 * `dropSeedProjects` is pure; `sweepCodexTrust` is Bun.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, rename, rm } from "node:fs/promises";
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

/** the file's text, or null when it is not a plain file of its own: a
 *  link is never followed, so a link the stage planted at config.toml
 *  cannot point the sweep at a file the stage could not write itself */
async function readPlain(file: string): Promise<{ text: string; mode: number } | null> {
  const st = await lstat(file).catch(() => null);
  if (!st?.isFile()) return null;
  let fh: FileHandle;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const now = await fh.stat();
    if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) return null;
    return { text: await fh.readFile("utf8"), mode: now.mode & 0o777 };
  } finally {
    await fh.close();
  }
}

/** true when the file changed. Written aside and renamed into place, so a
 *  write codex makes at the same moment is never half overwritten. The new
 *  file keeps the old one's mode. The temp file has a random name and is
 *  made exclusive (`wx`), so a link planted at a guessed name is never
 *  written through. The stage runner runs this as the stage user, never as
 *  root (runner.ts, stageChores). */
export async function sweepCodexTrust(codexHome: string, seeds: string): Promise<boolean> {
  const file = join(codexHome, "config.toml");
  const was = await readPlain(file);
  if (was === null) return false;
  const next = dropSeedProjects(was.text, seeds);
  if (next === was.text) return false;
  const tmp = `${file}.canopy-${randomBytes(8).toString("hex")}.tmp`;
  let made = false;
  try {
    const fh = await open(tmp, "wx", was.mode);
    made = true;
    try {
      await fh.writeFile(next);
      await fh.chmod(was.mode);
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (err) {
    if (made) await rm(tmp, { force: true });
    throw err;
  }
  return true;
}

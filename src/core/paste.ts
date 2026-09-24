/**
 * An image pasted or dropped into a browser shell. The browser cannot hand
 * an image to a program on the backend through the terminal, and the
 * backend has no clipboard of its own, so the browser uploads the bytes,
 * the server files them under `pastes/` in the config dir (the volume the
 * shells container shares) and the browser types the saved path in, which
 * Claude Code takes as an attached image.
 *
 * The name, type and quoting rules are pure and tested; `savePaste` is fs.
 */
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./store";

/** the image types Claude Code reads, by the extension each is saved under */
export const PASTE_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** the largest image the server takes */
export const PASTE_MAX = 20 * 1024 * 1024;

/** how long a pasted image is kept before the next paste clears it */
export const PASTE_DAYS = 7;

/** the file a paste of `type` into shell `term` at `now` is saved as, or
 *  null for a type that is not an image Claude Code reads */
export function pasteName(term: string, type: string, now: number): string | null {
  const ext = PASTE_TYPES[(type.split(";")[0] ?? "").trim().toLowerCase()];
  return ext ? `${term.slice(0, 8)}-${now}.${ext}` : null;
}

/** the path as it is typed into the shell: bare when every character is
 *  safe, else with a backslash ahead of each unsafe one, the way a Mac
 *  terminal writes a dropped file */
export function pasteText(path: string): string {
  return path.replace(/[^A-Za-z0-9_\-./~]/g, (c) => `\\${c}`);
}

/** the names among `files` older than `PASTE_DAYS` at `now` */
export function expiredPastes(files: { name: string; mtime: number }[], now: number): string[] {
  const cut = now - PASTE_DAYS * 24 * 60 * 60 * 1000;
  return files.filter((f) => f.mtime < cut).map((f) => f.name);
}

export const pasteDir = (): string => join(configDir(), "pastes");

/** writes the image and answers its path, clearing out expired ones first */
export async function savePaste(name: string, bytes: ArrayBuffer): Promise<string> {
  const dir = pasteDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const files = await Promise.all(
    (await readdir(dir)).map(async (n) => ({ name: n, mtime: (await stat(join(dir, n)).catch(() => null))?.mtimeMs ?? now })),
  );
  await Promise.all(expiredPastes(files, now).map((n) => rm(join(dir, n), { force: true })));
  const path = join(dir, name);
  await writeFile(path, new Uint8Array(bytes), { mode: 0o600 });
  return path;
}

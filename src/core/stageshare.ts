/**
 * What a stage may read beyond its own seed, copied by canopy under the seeds
 * dir's `.shared/`, which the stages container mounts read-only: a sprout's
 * inputs, and a per-sprout snapshot of the workspace (devhub's two indexes and
 * each listed project's README). The stage never sees the launch root, its
 * .env, or canopy's config volume. Regular files only; a symlink is skipped.
 * Every build happens in a tmp folder of its own, so two stages at once never
 * share one or swap a snapshot out from under each other.
 */
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, normalize, relative, sep } from "node:path";
import { urlWithoutSecret } from "./sprout";

export const SHARED_DIR = ".shared";
const CAP = { files: 400, bytes: 4_000_000 };
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** a url anywhere in a string: up to whitespace, a quote or an angle bracket */
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** a JSON value with every url in every string, whole or inside free text,
 *  passed through `urlWithoutSecret` */
export function withoutSecrets(v: unknown): unknown {
  if (typeof v === "string") return v.replace(URL_IN_TEXT, (u) => urlWithoutSecret(u));
  if (Array.isArray(v)) return v.map(withoutSecrets);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutSecrets(x)]));
  }
  return v;
}

async function regular(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  return st !== null && st.isFile();
}

function checkId(id: string): void {
  if (!ID_RE.test(id)) throw new Error("not a sprout id");
}

/** a fresh scratch folder beside the shared ones, named by pid and a random suffix */
async function scratch(seeds: string): Promise<string> {
  const tmp = join(seeds, SHARED_DIR, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  await mkdir(tmp, { recursive: true });
  return tmp;
}

async function swapIn(tmp: string, dest: string): Promise<void> {
  await mkdir(join(dest, ".."), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await rename(tmp, dest);
}

export async function shareInputs(seeds: string, sproutId: string, from: string): Promise<string> {
  checkId(sproutId);
  const dest = join(seeds, SHARED_DIR, "inputs", sproutId);
  const tmp = await scratch(seeds);
  try {
    for (const name of await readdir(from).catch(() => [] as string[])) {
      if (await regular(join(from, name))) await copyFile(join(from, name), join(tmp, name));
    }
    await swapIn(tmp, dest);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return dest;
}

export async function shareWorkspace(seeds: string, root: string, sproutId: string, cap = CAP): Promise<string> {
  checkId(sproutId);
  const dest = join(seeds, SHARED_DIR, "workspace", sproutId);
  const tmp = await scratch(seeds);
  try {
    await mkdir(join(tmp, "READMEs"), { recursive: true });
    const hub = join(root, "_devhub");
    // the indexes carry each project's remote, which may hold a password or
    // token: every url in them goes in without its userinfo, and an index that
    // does not parse stays out rather than go in as it is
    for (const f of ["manifest.json", "references.json"]) {
      if (!(await regular(join(hub, f)))) continue;
      const parsed: unknown = await readFile(join(hub, f), "utf8")
        .then(JSON.parse)
        .catch(() => undefined);
      if (parsed !== undefined) await writeFile(join(tmp, f), JSON.stringify(withoutSecrets(parsed), null, 1));
    }
    const manifest: unknown = await readFile(join(hub, "manifest.json"), "utf8").then(JSON.parse).catch(() => null);
    const cats = typeof manifest === "object" && manifest !== null ? (manifest as { categories?: unknown }).categories : null;
    const projects: unknown[] =
      typeof cats === "object" && cats !== null
        ? Object.values(cats).flatMap((c) =>
            typeof c === "object" && c !== null && Array.isArray((c as { projects?: unknown }).projects) ? (c as { projects: unknown[] }).projects : [],
          )
        : [];
    const realRoot = await realpath(root).catch(() => null);
    let files = 0;
    let bytes = 0;
    for (const p of projects) {
      const rel = typeof p === "object" && p !== null && typeof (p as { path?: unknown }).path === "string" ? (p as { path: string }).path : null;
      if (!rel || realRoot === null) continue;
      const abs = normalize(join(root, rel, "README.md"));
      if (relative(root, abs).startsWith("..")) continue;
      if (!(await regular(abs))) continue;
      // a project folder that is itself a symlink out of the root lands outside it
      const real = await realpath(abs).catch(() => null);
      if (real === null || !real.startsWith(realRoot + sep)) continue;
      const text = await readFile(abs);
      if (files >= cap.files || bytes + text.length > cap.bytes) break;
      await writeFile(join(tmp, "READMEs", `${rel.replaceAll("/", "__")}.md`), text);
      files++;
      bytes += text.length;
    }
    await swapIn(tmp, dest);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return dest;
}

/** a dismissed sprout's copies go with it */
export async function unshare(seeds: string, sproutId: string): Promise<void> {
  checkId(sproutId);
  await rm(join(seeds, SHARED_DIR, "inputs", sproutId), { recursive: true, force: true });
  await rm(join(seeds, SHARED_DIR, "workspace", sproutId), { recursive: true, force: true });
}

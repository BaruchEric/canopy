/** The launcher's pure half: the settings, which release asset fits this
 *  machine, what a download turns into, and what a launch runs. Browser-safe,
 *  so the panel and the menu can read the settings and describe them; the
 *  downloads, checkouts and processes live in launcher.ts. */

import { DEFAULT_LAUNCH, type LaunchSettings, type Pull, type Release, type ReleaseAsset } from "./types";

/* ---------- settings ---------- */

const line = (v: unknown): string =>
  typeof v === "string" ? v.replace(/[\r\n]+/g, " ").trim() : "";

/** Settings from a request body or a hand-edited config, field by field. A
 *  line break cannot reach a shell line: every field is one line. */
export function normalizeLaunch(v: unknown): LaunchSettings {
  if (!v || typeof v !== "object") return { ...DEFAULT_LAUNCH };
  const o = v as Record<string, unknown>;
  return {
    asset: line(o["asset"]),
    build: line(o["build"]),
    run: line(o["run"]),
    launch: line(o["launch"]),
  };
}

export const isDefaultLaunch = (l: LaunchSettings): boolean =>
  l.asset === "" && l.build === "" && l.run === "" && l.launch === "";

/** One short line for the menu: which of the four lines are set. */
export function describeLaunch(l: LaunchSettings): string {
  const set = [
    ...(l.build ? ["build"] : []),
    ...(l.run ? ["run"] : []),
    ...(l.asset ? ["asset"] : []),
    ...(l.launch ? ["launch"] : []),
  ];
  return set.length ? set.join(" · ") : "defaults";
}

/** `{file}` in a launch line, quoted for the shell it will run in. */
export function fillLaunch(template: string, file: string): string {
  const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
  return template.replace(/\{file\}/g, quoted);
}

/* ---------- builds: keys ---------- */

export type BuildRef = { kind: "release"; tag: string } | { kind: "pr"; number: number } | { kind: "local" };

export function buildKey(ref: BuildRef): string {
  switch (ref.kind) {
    case "release":
      return `release:${ref.tag}`;
    case "pr":
      return `pr:${ref.number}`;
    case "local":
      return "local";
  }
}

/** The ref a key names, or null for one nothing here would have made. */
export function parseBuildKey(key: string): BuildRef | null {
  if (key === "local") return { kind: "local" };
  const pr = /^pr:(\d+)$/.exec(key);
  if (pr) return { kind: "pr", number: Number(pr[1]) };
  const rel = /^release:(.+)$/.exec(key);
  if (rel && rel[1] && isSafeTag(rel[1])) return { kind: "release", tag: rel[1] };
  return null;
}

/** A tag that can be a folder name: no separators, no traversal, nothing a
 *  shell would read. Tags are the forge's; canopy only refuses odd ones. */
export const isSafeTag = (tag: string): boolean =>
  /^[\w][\w.+-]{0,127}$/.test(tag) && tag !== ".." && !tag.startsWith(".");

/** An asset name that can be a file name under the release's folder. */
export const isSafeAssetName = (name: string): boolean =>
  /^[^/\\\0]{1,255}$/.test(name) && name !== "." && name !== "..";

/* ---------- releases and pulls, as GitHub's API lists them ---------- */

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const ms = (v: unknown): number => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : 0;
};

/** `GET /repos/{owner}/{repo}/releases`: tag, name, when, and the assets.
 *  Drafts are dropped (there is nothing to download), odd entries too. */
export function parseReleases(body: unknown): Omit<Release, "pick">[] {
  if (!Array.isArray(body)) throw new Error("the forge did not answer with a list of releases");
  const out: Omit<Release, "pick">[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const tag = str(r["tag_name"]);
    if (!tag || r["draft"] === true) continue;
    const assets: ReleaseAsset[] = [];
    for (const a of Array.isArray(r["assets"]) ? r["assets"] : []) {
      if (!a || typeof a !== "object") continue;
      const o = a as Record<string, unknown>;
      const name = str(o["name"]);
      const url = str(o["browser_download_url"]);
      if (!name || !url) continue;
      assets.push({ name, size: num(o["size"]), url, apiUrl: str(o["url"]) });
    }
    out.push({
      tag,
      name: str(r["name"]) || tag,
      prerelease: r["prerelease"] === true,
      publishedAt: ms(r["published_at"]),
      url: str(r["html_url"]),
      assets,
    });
  }
  return out;
}

/** `GET /repos/{owner}/{repo}/pulls?state=open`. */
export function parsePulls(body: unknown): Pull[] {
  if (!Array.isArray(body)) throw new Error("the forge did not answer with a list of pull requests");
  const out: Pull[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const number = num(p["number"]);
    if (!Number.isInteger(number) || number <= 0) continue;
    const user = p["user"] && typeof p["user"] === "object" ? (p["user"] as Record<string, unknown>) : {};
    const head = p["head"] && typeof p["head"] === "object" ? (p["head"] as Record<string, unknown>) : {};
    out.push({
      number,
      title: str(p["title"]),
      author: str(user["login"]),
      branch: str(head["ref"]),
      draft: p["draft"] === true,
      updatedAt: ms(p["updated_at"]),
      url: str(p["html_url"]),
    });
  }
  return out;
}

/* ---------- which asset is for this machine ---------- */

export interface Platform {
  os: "darwin" | "linux" | "win32" | "other";
  arch: "arm64" | "x64" | "other";
}

/** A shell-style glob as a regexp over the whole name, case-insensitive:
 *  `*` is anything, `?` one character, the rest literal. */
export function globToRegExp(glob: string): RegExp {
  const src = glob
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${src}$`, "i");
}

/** Files a release ships beside its builds: checksums, signatures, notes. */
const META = /\.(sha\d*|sha\d+sum|md5|sig|asc|sigstore|txt|json|ya?ml|blockmap|pem|spdx|sbom)$/i;

/** The words that say which machine an asset is for. */
const OS_WORDS: Record<Platform["os"], RegExp> = {
  darwin: /\b(mac|macos|darwin|osx|apple)\b|\.(dmg|pkg|app)(\.|$)/i,
  linux: /\b(linux|appimage)\b|\.(appimage|deb|rpm|flatpak)(\.|$)/i,
  win32: /\b(win|win32|win64|windows)\b|\.(exe|msi)(\.|$)/i,
  other: /$^/,
};
const OTHER_OS: Record<Platform["os"], RegExp> = {
  darwin: /\b(linux|win|win32|win64|windows|appimage|android)\b|\.(exe|msi|deb|rpm|appimage)(\.|$)/i,
  linux: /\b(mac|macos|darwin|osx|apple|win|win32|win64|windows|android)\b|\.(dmg|pkg|exe|msi)(\.|$)/i,
  win32: /\b(mac|macos|darwin|osx|apple|linux|appimage|android)\b|\.(dmg|pkg|deb|rpm|appimage)(\.|$)/i,
  other: /$^/,
};
const ARCH_WORDS: Record<Platform["arch"], RegExp> = {
  arm64: /\b(arm64|aarch64|apple[-_ ]?silicon|universal|arm)\b/i,
  x64: /\b(x64|x86[-_]64|amd64|intel|universal)\b/i,
  other: /$^/,
};
const OTHER_ARCH: Record<Platform["arch"], RegExp> = {
  arm64: /\b(x64|x86[-_]64|amd64|intel|i386|i686|x86)\b/i,
  x64: /\b(arm64|aarch64|armv\d+|arm)\b/i,
  other: /$^/,
};

/** The kinds a download can be unpacked from, best first for each OS. */
const EXT_ORDER: Record<Platform["os"], string[]> = {
  darwin: [".dmg", ".zip", ".pkg", ".tar.gz", ".tgz", ".tar.xz", ".tar.bz2", ".tar"],
  linux: [".appimage", ".tar.gz", ".tgz", ".tar.xz", ".tar.bz2", ".tar", ".zip", ".deb", ".rpm"],
  win32: [".exe", ".msi", ".zip"],
  other: [".tar.gz", ".tgz", ".zip"],
};

/** Words that name something other than the app: sources, symbols, docs. */
const NOT_APP = /\b(source|src|symbols|dsym|debug|docs?|sdk|headers)\b/i;

const ext = (name: string): string => {
  const lower = name.toLowerCase();
  for (const e of [".tar.gz", ".tar.xz", ".tar.bz2"]) if (lower.endsWith(e)) return e;
  const dot = lower.lastIndexOf(".");
  return dot === -1 ? "" : lower.slice(dot);
};

/** Words split out of a file name, so `FreeCAD_1.0-macOS-arm64.dmg` reads as
 *  freecad, 1, 0, macos, arm64, dmg. The regexps above look at this. */
const words = (name: string): string => name.replace(/[_.\-+]/g, " ");

/**
 * The asset for this machine: the first name the glob matches when one is
 * set, else the best guess from the names. A guess needs the OS named (or
 * an extension that names it) unless there is only one candidate; another
 * OS's name or arch rules a file out; the arch and the preferred extension
 * break ties. Null when nothing fits, which the UI says out loud rather
 * than downloading the wrong thing.
 */
export function pickAsset(names: string[], platform: Platform, glob = ""): string | null {
  const candidates = names.filter((n) => !META.test(n));
  if (glob.trim()) {
    const re = globToRegExp(glob.trim());
    return candidates.find((n) => re.test(n)) ?? names.find((n) => re.test(n)) ?? null;
  }
  const pool = candidates.filter((n) => !NOT_APP.test(words(n)));
  if (pool.length === 1 && pool[0] !== undefined) {
    const only = pool[0];
    return OTHER_OS[platform.os].test(words(only)) || OTHER_ARCH[platform.arch].test(words(only)) ? null : only;
  }
  let best: { name: string; score: number } | null = null;
  for (const name of pool) {
    const w = words(name);
    if (OTHER_OS[platform.os].test(w) || OTHER_OS[platform.os].test(name)) continue;
    if (OTHER_ARCH[platform.arch].test(w)) continue;
    const osHit = OS_WORDS[platform.os].test(w) || OS_WORDS[platform.os].test(name);
    if (!osHit) continue;
    let score = 10;
    if (ARCH_WORDS[platform.arch].test(w)) score += 5;
    const order = EXT_ORDER[platform.os].indexOf(ext(name));
    if (order !== -1) score += EXT_ORDER[platform.os].length - order;
    if (best === null || score > best.score) best = { name, score };
  }
  return best?.name ?? null;
}

/* ---------- what a download turns into, and what a launch runs ---------- */

/** How an asset is opened up after the download, by its name. */
export type Unpack = "dmg" | "zip" | "tar" | "exec" | "keep";

export function unpackKind(name: string): Unpack {
  const e = ext(name);
  if (e === ".dmg") return "dmg";
  if (e === ".zip") return "zip";
  if ([".tar.gz", ".tgz", ".tar.xz", ".tar.bz2", ".tar"].includes(e)) return "tar";
  if (e === ".appimage" || e === "" || e === ".bin" || e === ".run") return "exec";
  return "keep";
}

/** What to run out of an unpacked release folder: an app bundle first, then
 *  something that looks like a binary, then the asset itself for `open` to
 *  deal with. `entries` are the folder's names after unpacking. */
export type LaunchTarget = { kind: "app" | "bin" | "open"; name: string };

export function launchTarget(entries: string[], asset: string): LaunchTarget | null {
  const app = entries.find((n) => n.toLowerCase().endsWith(".app"));
  if (app) return { kind: "app", name: app };
  const binLike = (n: string) => {
    const e = ext(n);
    return (e === "" || e === ".appimage" || e === ".bin" || e === ".run" || e === ".exe") && !n.startsWith(".");
  };
  const bins = entries.filter(binLike);
  // the asset itself when it is a binary, else the one binary the unpack left
  const own = bins.find((n) => n === asset);
  if (own) return { kind: "bin", name: own };
  if (bins.length === 1 && bins[0] !== undefined) return { kind: "bin", name: bins[0] };
  if (bins.length > 1) {
    // several: prefer one named after the asset's stem
    const stem = asset.toLowerCase().split(/[-_.]/)[0] ?? "";
    const named = bins.find((n) => stem && n.toLowerCase().startsWith(stem));
    return { kind: "bin", name: named ?? bins[0] ?? "" };
  }
  const kept = entries.find((n) => n === asset);
  return kept ? { kind: "open", name: kept } : null;
}

/** A byte count the way a download dialog says it. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

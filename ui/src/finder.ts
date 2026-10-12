/**
 * The files section's pure parts: the folders and files under one folder of
 * a repo's flat file list, the crumbs to it, a name search, what the viewer
 * steps through, and the per-browser memory of where each repo was left.
 * Tested in finder.test.ts.
 */

/** where each repo's files section was left, by repo id (localStorage) */
export const FINDER_KEY = "canopy.finder";
/** the most a text preview reads; past it the viewer says so and stops */
export const TEXT_MAX = 2 * 1024 * 1024;
/** the most an image, a player or a PDF reads */
export const MEDIA_MAX = 100 * 1024 * 1024;
/** the lines a text preview draws; a longer file says how many it left out */
export const LINE_CAP = 5000;
/** how many names a search lists */
export const FIND_CAP = 300;

export interface Entry {
  name: string;
  /** from the repo's root; a folder's has no trailing slash */
  path: string;
  dir: boolean;
  /** a folder's files, however deep; null for an ignored folder, which
   *  the listing does not reach into */
  count: number | null;
  /** git ignores it, so only the "show ignored" view lists it */
  ignored?: true;
}

/** A dotfile or dotfolder, which the section hides until asked. */
export const isHidden = (name: string): boolean => name.startsWith(".");

/** the last part of a path */
export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** the folder a path sits in, "" for the root */
export const dirOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

const byName = (a: Entry, b: Entry): number =>
  a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** The folders and files right under `dir` ("" is the root), folders first,
 *  each folder with its count of files. A hidden name stays out unless
 *  `hidden`, and so does every file under a hidden folder. */
export function entriesAt(files: readonly string[], dir: string, hidden = false): Entry[] {
  const prefix = dir === "" ? "" : `${dir}/`;
  const folders = new Map<string, Entry>();
  const out: Entry[] = [];
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    if (!hidden && isHidden(name)) continue;
    if (slash < 0) {
      out.push({ name, path: f, dir: false, count: 0 });
      continue;
    }
    const at = folders.get(name);
    if (at) at.count = (at.count ?? 0) + 1;
    else folders.set(name, { name, path: prefix + name, dir: true, count: 1 });
  }
  return [...folders.values(), ...out].sort(byName);
}

/** `entries` with what the disk holds in `dir` that git ignores, marked as
 *  such. A name the listing already has is the listing's; a hidden one
 *  stays out unless `hidden`. */
export function withIgnored(entries: readonly Entry[], disk: readonly { name: string; dir: boolean }[], dir: string, hidden = false): Entry[] {
  const known = new Set(entries.map((e) => e.name));
  const prefix = dir === "" ? "" : `${dir}/`;
  const extra: Entry[] = disk
    .filter((d) => !known.has(d.name) && (hidden || !isHidden(d.name)))
    .map((d) => ({ name: d.name, path: prefix + d.name, dir: d.dir, count: null, ignored: true }));
  return [...entries, ...extra].sort(byName);
}

/** an address in the repo, not one with a scheme, a host or only a
 *  fragment; on this page it would point at canopy */
export const isRelative = (href: string): boolean => !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href);

/** Where a link or image in a markdown file at `from` points in the repo:
 *  relative to its folder, or to the root for a leading slash, with `.` and
 *  `..` worked out and any query or fragment dropped. Null for an address
 *  off the page (a scheme, `//host`, a bare fragment) or one above the root. */
export function resolveRel(from: string, href: string): string | null {
  if (!isRelative(href)) return null;
  let raw = href.replace(/[?#].*$/, "");
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // a stray % reads as itself
  }
  if (raw === "") return null;
  const parts = raw.startsWith("/") ? [] : dirOf(from).split("/").filter(Boolean);
  for (const p of raw.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(p);
  }
  return parts.length ? parts.join("/") : null;
}

/** markdown, which the viewer draws as a page with a switch to its source */
export const isMarkdown = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path);
/** HTML, which the viewer can draw in a sandbox with nothing allowed */
export const isHtml = (path: string): boolean => /\.(html?|xhtml)$/i.test(path);

/** The page a sandboxed frame shows for a repo's HTML: a policy first that
 *  lets it fetch nothing (the frame's own sandbox already stops scripts,
 *  forms and popups), so opening it never calls out to anywhere. A meta
 *  ahead of any content lands in the implied head, where it applies. */
export const HTML_POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;
export const sandboxedPage = (html: string): string => HTML_POLICY + html;

/** Whether `dir` still holds anything: a folder can empty out between two
 *  listings, and the section goes back to the root then. */
export const dirExists = (files: readonly string[], dir: string): boolean =>
  dir === "" || files.some((f) => f.startsWith(`${dir}/`));

/** The crumbs from the root to `dir`, each with the folder it opens. */
export function crumbs(dir: string, root: string): { name: string; path: string }[] {
  const out = [{ name: root, path: "" }];
  if (dir === "") return out;
  const parts = dir.split("/");
  parts.forEach((name, i) => out.push({ name, path: parts.slice(0, i + 1).join("/") }));
  return out;
}

/** Files whose path holds every word of `q`, any case, with the ones whose
 *  name holds the whole query first; at most `cap`. */
export function findFiles(files: readonly string[], q: string, hidden = false, cap = FIND_CAP): { hits: string[]; more: boolean } {
  const query = q.trim().toLowerCase();
  if (!query) return { hits: [], more: false };
  const words = query.split(/\s+/);
  const named: string[] = [];
  const pathed: string[] = [];
  for (const f of files) {
    if (!hidden && f.split("/").some(isHidden)) continue;
    const low = f.toLowerCase();
    if (!words.every((w) => low.includes(w))) continue;
    (baseName(low).includes(query) ? named : pathed).push(f);
  }
  const all = [...named, ...pathed];
  return { hits: all.slice(0, cap), more: all.length > cap };
}

/** The viewer's neighbours of `path` in `list`: one back and one on, with
 *  no wrap, and where it stands. */
export function stepOf(list: readonly string[], path: string): { prev: string | null; next: string | null; at: number } {
  const at = list.indexOf(path);
  if (at < 0) return { prev: null, next: null, at };
  return { prev: list[at - 1] ?? null, next: list[at + 1] ?? null, at };
}

/** Bytes that hold a NUL near the start are not text. */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Text cut to `cap` lines, with how many it had. */
export function linesOf(text: string, cap = LINE_CAP): { lines: string[]; total: number } {
  const all = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return { lines: all.slice(0, cap), total: all.length };
}

export function sizeWord(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** where a repo's section was left: the folder, the file picked in it, and
 *  whether dotfiles and what git ignores were showing */
export interface FinderPlace {
  dir: string;
  file: string | null;
  hidden: boolean;
  ignored: boolean;
}

export function placeOf(v: unknown): FinderPlace {
  if (!v || typeof v !== "object") return { dir: "", file: null, hidden: false, ignored: false };
  const dir = "dir" in v && typeof v.dir === "string" ? v.dir : "";
  const file = "file" in v && typeof v.file === "string" ? v.file : null;
  const hidden = "hidden" in v && v.hidden === true;
  const ignored = "ignored" in v && v.ignored === true;
  return { dir, file, hidden, ignored };
}

function readAll(): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FINDER_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {};
  } catch {
    return {};
  }
}

export const loadPlace = (id: string): FinderPlace => placeOf(readAll()[id]);

export function savePlace(id: string, place: FinderPlace): void {
  try {
    localStorage.setItem(FINDER_KEY, JSON.stringify({ ...readAll(), [id]: place }));
  } catch {
    // a full or blocked store only costs the memory of where it was
  }
}

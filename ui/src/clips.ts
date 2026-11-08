/**
 * The clipboard's view (FR-054): every backend's clips and tailchan's
 * #clipboard as one list, the source words with their counts, the filter,
 * and the pieces the viewer draws a clip's kind from (a link's host and
 * path, a path's folder and name, pretty JSON, a code well's lines). Pure
 * and tested (clips.test.ts); the records are `src/core/clips.ts`.
 */
import { clipKey, fileName, looksSecret, looksSecretFile, mediaType, CLIP_SOURCES, CLIP_SOURCE_WHAT, type Clip, type ClipDevice, type ClipFile, type ClipSource } from "../../src/core/clips";
import type { ChanMessage } from "../../src/core/types";

/** what a shown clip came from: canopy's own sources, and tailchan's
 *  #clipboard, which canopy shows but does not keep */
export type ShownSource = ClipSource | "tailnet";
export const SHOWN_SOURCES: readonly ShownSource[] = [...CLIP_SOURCES, "tailnet"];

export const SOURCE_WHAT: Readonly<Record<ShownSource, string>> = {
  ...CLIP_SOURCE_WHAT,
  tailnet: "Sent to tailchan's #clipboard by a device on the tailnet",
};

/** a file tailchan holds, as the list shows it: its name, type and size, and
 *  the blob id its link reads; canopy never keeps its bytes */
export interface ChanFile {
  name: string;
  type: string;
  size: number;
  blob: string;
}

interface ShownBase {
  /** the clip's id by the page's ids, or `chan:` and tailchan's message id */
  key: string;
  text: string;
  from?: string;
  device?: ClipDevice;
  at: number;
  count: number;
  pinned: boolean;
  cut: boolean;
}

/** a clip as the list shows it: one canopy keeps, under its id by the
 *  page's ids, maybe a file; or one of tailchan's, text or a file it holds,
 *  with no id to pin or drop by */
export type ShownClip =
  | (ShownBase & { source: ClipSource; id: string; file?: ClipFile; chanFile?: undefined })
  | (ShownBase & { source: "tailnet"; id?: undefined; file?: undefined; chanFile?: ChanFile });

const shown = (c: Clip): ShownClip => ({
  key: c.id,
  id: c.id,
  text: c.text,
  source: c.source,
  ...(c.from ? { from: c.from } : {}),
  ...(c.device ? { device: c.device } : {}),
  ...(c.file ? { file: c.file } : {}),
  at: c.at,
  count: c.count,
  pinned: c.pinned === true,
  cut: c.cut === true,
});

/** a tailchan message's file, when it is one with a blob to read */
function chanFileOf(m: ChanMessage): ChanFile | null {
  const blob = m.meta["blob"];
  if (m.kind !== "object" || typeof blob !== "string" || !/^[0-9a-f]{32}$/.test(blob)) return null;
  const size = m.meta["size"];
  return { name: fileName(m.meta["name"]), type: mediaType(m.meta["mime"]), size: typeof size === "number" && size >= 0 ? size : 0, blob };
}

/**
 * One list, newest first: every backend's clips, the same text (or the same
 * file) once at its newest copy, then tailchan's text clips whose text
 * canopy does not already hold (a kept clip is the one to show, since it
 * can be pinned and dropped) and the files sent there. Tailchan's text
 * shaped like a secret, and its files named like a key, are left out here
 * too.
 */
export function shownClips(byBackend: Readonly<Record<string, readonly Clip[]>>, chan: readonly ChanMessage[] = []): ShownClip[] {
  const kept = Object.values(byBackend)
    .flat()
    .sort((a, b) => b.at - a.at || b.createdAt - a.createdAt);
  const seen = new Set<string>();
  const out: ShownClip[] = [];
  for (const c of kept) {
    if (seen.has(clipKey(c))) continue;
    seen.add(clipKey(c));
    out.push(shown(c));
  }
  for (const m of chan) {
    const from = `${m.handle}@${m.node}`;
    const file = chanFileOf(m);
    if (file) {
      if (seen.has(`chan:${file.blob}`) || looksSecretFile(file.name)) continue;
      seen.add(`chan:${file.blob}`);
      out.push({ key: `chan:${m.id}`, text: file.name, source: "tailnet", from, chanFile: file, at: m.ts, count: 1, pinned: false, cut: false });
      continue;
    }
    if (m.kind !== "clip" || !m.body.trim() || seen.has(m.body) || looksSecret(m.body)) continue;
    seen.add(m.body);
    out.push({ key: `chan:${m.id}`, text: m.body, source: "tailnet", from, at: m.ts, count: 1, pinned: false, cut: false });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** a shown clip's file, kept or tailchan's, as one shape: its name, type and size */
export const shownFile = (c: ShownClip): { name: string; type: string; size: number } | null => c.file ?? c.chanFile ?? null;

/** how many clips each source has, the sources with none left out, in the list's order */
export function sourceCounts(list: readonly ShownClip[]): { source: ShownSource; n: number }[] {
  return SHOWN_SOURCES.map((source) => ({ source, n: list.filter((c) => c.source === source).length })).filter((s) => s.n > 0);
}

/** the clips from `source` (every one for null) whose text or place holds `query`, any case */
export function filterClips(list: readonly ShownClip[], source: ShownSource | null, query: string): ShownClip[] {
  const q = query.trim().toLowerCase();
  return list.filter((c) => (source === null || c.source === source) && (!q || c.text.toLowerCase().includes(q) || (c.from ?? "").toLowerCase().includes(q)));
}

/** the pinned clips first, each group newest first as it came */
export const pinnedFirst = (list: readonly ShownClip[]): ShownClip[] => [...list.filter((c) => c.pinned), ...list.filter((c) => !c.pinned)];

/** a link's host and the rest, for http and https only; null for anything else */
export function linkParts(text: string): { href: string; host: string; rest: string } | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const rest = `${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
  return { href: url.href, host: url.host, rest };
}

/** a path's folder (with its last slash) and its name */
export function pathParts(text: string): { dir: string; base: string } {
  const t = text.trim();
  const cut = t.replace(/[/\\]+$/, "");
  const at = Math.max(cut.lastIndexOf("/"), cut.lastIndexOf("\\"));
  return at < 0 ? { dir: "", base: t } : { dir: cut.slice(0, at + 1), base: t.slice(at + 1) };
}

/** JSON laid out two spaces deep, or null past `max` characters or when it does not parse */
export function prettyJson(text: string, max = 20_000): string | null {
  if (text.length > max) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** the first `max` lines of a text, and how many more there are */
export function headLines(text: string, max: number): { lines: string[]; more: number } {
  const all = text.replace(/\n+$/, "").split("\n");
  return { lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** a command's text without the `$ ` someone copied it with */
export const commandText = (text: string): string => text.trim().replace(/^\$\s+/, "");

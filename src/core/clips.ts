/**
 * The clipboard (FR-054): every copy canopy sees, whatever made it, kept on
 * a backend so another window or another device can take it again. A clip
 * is a piece of text or a file with where it came from: a program in a
 * shell (OSC 52) or a shell's selection, one of canopy's own copy buttons
 * and keys, text selected on the page, `canopy clip` from a shell, an agent
 * or a script, or a device: its clipboard taken in, or a picture, a PDF or
 * any file pasted, dropped or picked into the clipboard. The same text, or
 * the same bytes, copied again is the same clip, moved to the top. Text and
 * files shaped like a key or a password are never kept (`looksSecret`,
 * `looksSecretFile`), and neither is a paste anywhere but the clipboard.
 *
 * Browser-safe and pure: the page imports the record, the kinds and the
 * words; the server half is `server/clips.ts`. Tested in clips.test.ts.
 */

import { mintNoteId } from "./notes";

export const CLIP_SOURCES = ["shell", "canopy", "page", "cli", "device"] as const;
export type ClipSource = (typeof CLIP_SOURCES)[number];

export const isClipSource = (v: unknown): v is ClipSource => typeof v === "string" && (CLIP_SOURCES as readonly string[]).includes(v);

/** a source as sent or kept: "clipboard" was the device's name before files
 *  came, and a page loaded before then still sends it */
export const sourceOf = (v: unknown): ClipSource | null => (v === "clipboard" ? "device" : isClipSource(v) ? v : null);

/** what each source is, for a title */
export const CLIP_SOURCE_WHAT: Readonly<Record<ClipSource, string>> = {
  shell: "Copied in a shell: a program's copy (Claude Code's, tmux's) or a selection",
  canopy: "Copied by one of canopy's copy buttons, copy keys or gears",
  page: "Text selected on the page and copied",
  cli: "Sent with canopy clip, from a shell, an agent or a script",
  device: "From a device: its clipboard taken in, or a file pasted, dropped or picked into canopy's clipboard",
};

/** the most characters a clip keeps; past it the text is cut and the clip says so */
export const CLIP_CHARS = 16_000;
/** how many unpinned clips a backend keeps, newest first */
export const CLIP_KEEP = 200;
/** how long an unpinned clip is kept after it was last copied */
export const CLIP_DAYS = 14;
/** the most characters a clip's `from` and a device's name keep */
export const CLIP_FROM_CHARS = 80;
/** the largest file a clip keeps */
export const CLIP_FILE_MAX = 25 * 1024 * 1024;
/** how many bytes of unpinned files a backend keeps; past it the oldest go */
export const CLIP_FILES_BUDGET = 512 * 1024 * 1024;
/** the most characters a file's name keeps */
export const CLIP_NAME_CHARS = 160;

/** the browser that made a clip */
export interface ClipDevice {
  /** the browser's own id (client.ts) */
  id: string;
  /** what the user calls it, or the browser's guess ("Mac, Chrome") */
  name: string;
  /** mac, android, windows, linux, ios, other */
  platform: string;
}

/** a file kept on the clipboard; its bytes sit beside the list, under the clip's id */
export interface ClipFile {
  /** the name it came with, no folders */
  name: string;
  /** its media type as the browser or the CLI said it */
  type: string;
  /** bytes */
  size: number;
  /** the bytes' sha-256, hex: the same file kept again is the same clip */
  sha: string;
}

export interface Clip {
  /** `c-` and eight base32 characters */
  id: string;
  /** the text copied; for a file, its name */
  text: string;
  /** set when the clip is a file and not text */
  file?: ClipFile;
  source: ClipSource;
  /** where in its source: a shell's repo, a gear's surface, a view, the CLI's host */
  from?: string;
  /** the browser that copied it; absent for the CLI */
  device?: ClipDevice;
  /** when it was first kept, unix ms */
  createdAt: number;
  /** when it was last copied, unix ms; the list's order */
  at: number;
  /** how many times it has been copied */
  count: number;
  /** kept past the cap and the age */
  pinned?: true;
  /** the text was longer than CLIP_CHARS and was cut there */
  cut?: true;
}

/** `GET /api/clips`: every clip the backend keeps, newest first */
export interface ClipsInfo {
  clips: Clip[];
}

/** what a page, a shell or the CLI sends to keep a clip; a file's text is its name */
export interface ClipIn {
  text: string;
  source: ClipSource;
  from?: string;
  device?: ClipDevice;
  file?: ClipFile;
}

const CLIP_ID = /^c-[a-z2-7]{8}$/;

export const isClipId = (v: unknown): v is string => typeof v === "string" && CLIP_ID.test(v);

/** `c-` and 8 base32 characters, minted as a note's id is */
export const mintClipId = (random?: (n: number) => Uint8Array): string => `c-${mintNoteId(random).slice(2)}`;

/**
 * Shapes that are a credential whatever surrounds them: an age identity, a
 * PEM private key, a JWT, the token formats of GitHub, Anthropic, OpenAI,
 * AWS, Slack, GitLab, Google, npm and Stripe, a Bearer header, and an env
 * line that assigns a password, secret, token or key. Known shapes only: a
 * rule on how random a string looks would also take a commit hash or a UUID.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /AGE-SECRET-KEY-1[0-9A-Z]{20,}/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  // the header is capped: every dash in a long run starts a new try, and
  // each one read to the end of the run before the cap
  /\beyJ[A-Za-z0-9_-]{8,1024}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\b[rs]k_live_[A-Za-z0-9]{20,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  // Blanks here never cross a line and a name is at most 80 characters each
  // side of its word: with \s and no cap, a run of blank lines or one long
  // line of capitals is tried again from every place in it, which took a
  // minute on a 256 KB file of newlines. The word may be the whole name:
  // TOKEN=, PASSWORD= and API_KEY= are env lines too.
  /^[^\S\n]*(?:export[^\S\n]+)?[A-Z0-9_]{0,80}(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY)[A-Z0-9_]{0,80}[^\S\n]*=[^\S\n]*["']?[^\s"']{8,}/m,
];

/** whether text carries something shaped like a key or a password, which is never kept */
export const looksSecret = (text: string): boolean => SECRET_SHAPES.some((re) => re.test(text));

/** the names a key, a keystore or an env file goes by: an ssh identity (not
 *  its .pub), a PEM or key file, a PKCS#12 bundle, a KeePass database, .env */
const SECRET_NAMES: readonly RegExp[] = [/^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?!.*\.pub$)/i, /\.(?:pem|key|p12|pfx|kdbx|keystore|jks)$/i, /^\.env(?:\..*)?$/i];

/** whether a file's name says it holds a key or a password, which is never kept */
export const looksSecretFile = (name: string): boolean => SECRET_NAMES.some((re) => re.test(name));

/** the first 256 KB of a file as text, for the secret check and the viewer;
 *  null when it is not text (a NUL byte, or more than a few bytes that are
 *  not UTF-8) */
export function textHead(bytes: Uint8Array, max = 256 * 1024): string | null {
  const head = bytes.subarray(0, max);
  if (head.includes(0)) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  // a cut multi-byte character at the end makes one replacement; more is not text
  const bad = text.length - text.replaceAll("\uFFFD", "").length;
  return bad > 4 ? null : text;
}

/** a file's name as kept: no folders, no control characters, capped; "file" when nothing is left */
export function fileName(v: unknown): string {
  const raw = typeof v === "string" ? v : "";
  const base = raw.split(/[/\\]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cut = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, CLIP_NAME_CHARS);
  // the cap can land inside a character made of two code units (an emoji);
  // half of one is no character, and a header cannot carry it
  const clean = cut.replace(/[\uD800-\uDBFF]$/, "");
  return clean && clean !== "." && clean !== ".." ? clean : "file";
}

/** a media type as kept: lower case, its parameters dropped; octet-stream when it is not one */
export function mediaType(v: unknown): string {
  const t = typeof v === "string" ? (v.split(";")[0] ?? "").trim().toLowerCase() : "";
  return /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(t) && t.length <= 100 ? t : "application/octet-stream";
}

/** the type a few bytes say a file is, for a pipe with no name: an image, a
 *  PDF, a zip, gzip; null when they say nothing */
export function sniffType(bytes: Uint8Array): { type: string; ext: string } | null {
  const at = (i: number, ...want: number[]) => want.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return { type: "image/png", ext: "png" };
  if (at(0, 0xff, 0xd8, 0xff)) return { type: "image/jpeg", ext: "jpg" };
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return { type: "image/gif", ext: "gif" };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { type: "image/webp", ext: "webp" };
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return { type: "application/pdf", ext: "pdf" };
  if (at(0, 0x50, 0x4b, 0x03, 0x04)) return { type: "application/zip", ext: "zip" };
  if (at(0, 0x1f, 0x8b)) return { type: "application/gzip", ext: "gz" };
  return null;
}

/** "512 B", "14 KB", "2.4 MB" */
export function sizeWord(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** what a clip is the same as: its bytes for a file, else its text */
export const clipKey = (c: { text: string; file?: ClipFile }): string => (c.file ? `file:${c.file.sha}` : c.text);

/** a clip's text as kept: as given, cut at CLIP_CHARS; empty when it is only whitespace */
export function clipText(text: string): { text: string; cut: boolean } {
  if (!text.trim()) return { text: "", cut: false };
  return text.length > CLIP_CHARS ? { text: text.slice(0, CLIP_CHARS), cut: true } : { text, cut: false };
}

/** a short label as kept: one line, trimmed, capped */
export const clipLabel = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim().slice(0, CLIP_FROM_CHARS);
  return s || undefined;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const timeOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** a device as sent or kept, or undefined when it is not one */
export function parseDevice(v: unknown): ClipDevice | undefined {
  if (!isRecord(v) || typeof v["id"] !== "string" || !/^[0-9a-f]{16}$/.test(v["id"])) return undefined;
  const name = clipLabel(v["name"]);
  if (!name) return undefined;
  const platform = typeof v["platform"] === "string" && /^[a-z]{1,16}$/.test(v["platform"]) ? v["platform"] : "other";
  return { id: v["id"], name, platform };
}

/** a file as sent or kept, or undefined when it is not one */
export function parseFile(v: unknown): ClipFile | undefined {
  if (!isRecord(v) || typeof v["sha"] !== "string" || !/^[0-9a-f]{64}$/.test(v["sha"])) return undefined;
  const size = v["size"];
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return undefined;
  return { name: fileName(v["name"]), type: mediaType(v["type"]), size, sha: v["sha"] };
}

/** one record of the file as a clip, or null when it is not one */
export function parseClip(v: unknown): Clip | null {
  const source = isRecord(v) ? sourceOf(v["source"]) : null;
  if (!isRecord(v) || !isClipId(v["id"]) || typeof v["text"] !== "string" || !v["text"] || !source) return null;
  const at = timeOf(v["at"]);
  if (at === undefined) return null;
  const clip: Clip = {
    id: v["id"],
    text: v["text"].slice(0, CLIP_CHARS),
    source,
    createdAt: timeOf(v["createdAt"]) ?? at,
    at,
    count: typeof v["count"] === "number" && Number.isInteger(v["count"]) && v["count"] > 0 ? v["count"] : 1,
  };
  const from = clipLabel(v["from"]);
  if (from) clip.from = from;
  const device = parseDevice(v["device"]);
  if (device) clip.device = device;
  if (v["pinned"] === true) clip.pinned = true;
  if (v["cut"] === true || v["text"].length > CLIP_CHARS) clip.cut = true;
  const file = parseFile(v["file"]);
  if (file) {
    clip.file = file;
    clip.text = file.name;
    delete clip.cut;
  }
  return clip;
}

/** the file's array read back, newest first; a record that is not a clip is dropped, never the file */
export function parseClips(v: unknown): Clip[] {
  if (!Array.isArray(v)) return [];
  const out: Clip[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const c = parseClip(item);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return sortClips(out);
}

/** newest copy first; a tie goes to the one kept first */
export const sortClips = (clips: readonly Clip[]): Clip[] => [...clips].sort((a, b) => b.at - a.at || b.createdAt - a.createdAt);

const DAY = 24 * 60 * 60_000;

/** The clips a backend keeps at `now`: every pinned one, and the newest
 *  CLIP_KEEP unpinned ones copied within CLIP_DAYS, their files together no
 *  more than `budget` bytes (an older file past it goes, the text clips
 *  around it stay). `gone` is the ids left out; the list is the same object
 *  when nothing went. */
export function pruneClips(clips: readonly Clip[], now: number, budget = CLIP_FILES_BUDGET): { clips: readonly Clip[]; gone: string[] } {
  const gone: string[] = [];
  let kept = 0;
  let bytes = 0;
  const out = sortClips(clips).filter((c) => {
    if (c.pinned) return true;
    const size = c.file?.size ?? 0;
    if (now - c.at > CLIP_DAYS * DAY || kept >= CLIP_KEEP || bytes + size > budget) {
      gone.push(c.id);
      return false;
    }
    kept += 1;
    bytes += size;
    return true;
  });
  return gone.length === 0 ? { clips, gone } : { clips: out, gone };
}

/**
 * `incoming` kept at `now`. The same text already kept is that clip, moved
 * to the top with its count up and the newest copy's source, place and
 * device; it keeps its id, its pin and when it was first kept. New text is a
 * new clip under `id`. Then the list is pruned. `clip` is the one kept and
 * `gone` the ids the prune left out.
 */
export function putClip(clips: readonly Clip[], incoming: ClipIn, now: number, id: string): { clips: Clip[]; clip: Clip; gone: string[] } {
  const { text, cut } = incoming.file ? { text: incoming.file.name, cut: false } : clipText(incoming.text);
  const key = clipKey({ text, ...(incoming.file ? { file: incoming.file } : {}) });
  // a text is only ever the same as a text and a file as a file: a text that
  // reads "file:<sha>" is not the file with that hash
  const old = clips.find((c) => clipKey(c) === key && !c.file === !incoming.file);
  const clip: Clip = {
    id: old?.id ?? id,
    text,
    source: incoming.source,
    createdAt: old?.createdAt ?? now,
    at: now,
    count: (old?.count ?? 0) + 1,
  };
  const from = clipLabel(incoming.from);
  if (from) clip.from = from;
  if (incoming.device) clip.device = incoming.device;
  if (old?.pinned) clip.pinned = true;
  if (incoming.file) clip.file = incoming.file;
  else if (cut || old?.cut) clip.cut = true;
  const next = [clip, ...clips.filter((c) => c.id !== clip.id)];
  const pruned = pruneClips(next, now);
  return { clips: sortClips(pruned.clips), clip, gone: pruned.gone.filter((g) => g !== clip.id) };
}

/** A clip taken again from the list: moved to the top with its count up,
 *  its source and place as they were. Null when no clip has that id. */
export function takeClip(clips: readonly Clip[], id: string, now: number): { clips: Clip[]; clip: Clip } | null {
  const old = clips.find((c) => c.id === id);
  if (!old) return null;
  const clip: Clip = { ...old, at: now, count: old.count + 1 };
  return { clips: sortClips([clip, ...clips.filter((c) => c.id !== id)]), clip };
}

/** A change to apply to a list of clips: `put` clips added or changed,
 *  `gone` ids dropped. Applying the same change twice changes nothing, so a
 *  page can take an event and a read in either order. */
export function applyClips(clips: readonly Clip[], change: { put?: readonly Clip[]; gone?: readonly string[] }): Clip[] {
  const drop = new Set([...(change.gone ?? []), ...(change.put ?? []).map((c) => c.id)]);
  return sortClips([...clips.filter((c) => !drop.has(c.id)), ...(change.put ?? [])]);
}

export const CLIP_KINDS = ["link", "color", "hash", "path", "json", "command", "code", "text", "image", "pdf", "video", "audio", "file"] as const;
export type ClipKind = (typeof CLIP_KINDS)[number];

/** what a file is, for the viewer: a picture, a PDF, a video, a sound, or any other file */
export function fileKind(type: string): ClipKind {
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "file";
}

/** what a clip is: its file's kind, else its text's */
export const kindOf = (c: { text: string; file?: ClipFile }): ClipKind => (c.file ? fileKind(c.file.type) : clipKind(c.text));

/** The types the server hands a file back as, which a browser can show
 *  without running anything in it. Any other type goes out as bytes. SVG
 *  is served as itself, behind the sandbox, for an <img> to draw; nothing
 *  opens it. */
const SHOWN_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "application/pdf", "text/plain",
  "audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "audio/flac",
  "video/mp4", "video/webm", "video/ogg", "video/quicktime",
]);

/** the type a kept file is served as */
export const servedType = (type: string): string => (SHOWN_TYPES.has(type) ? type : "application/octet-stream");

/** whether the page may open a file of `type` in a tab of its own: a type
 *  the browser shows with nothing in it that runs (never SVG or HTML) */
export const openable = (type: string): boolean => SHOWN_TYPES.has(type) && type !== "image/svg+xml";

/** whether a file reads as text in the viewer: text/*, JSON, XML, a script, or a name ending as code does;
 *  never a picture, so an SVG draws as one */
export function textFile(f: { name: string; type: string; size: number }): boolean {
  if (f.size > 512 * 1024 || f.type.startsWith("image/")) return false;
  if (f.type.startsWith("text/") || /(?:json|xml|javascript|typescript|yaml|toml|x-sh)$/.test(f.type)) return true;
  return /\.(?:txt|md|markdown|json|jsonl|ya?ml|toml|ini|conf|cfg|csv|tsv|log|xml|html?|css|scss|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|lua|vue|svelte|diff|patch)$/i.test(f.name);
}

/** how a text file's text is drawn: prose for notes and plain text, else as
 *  what the text reads as, and code when that is plain words in a code file */
export function textFileKind(f: { name: string; type: string }, text: string): ClipKind {
  const k = clipKind(text);
  if (k !== "text" || f.type === "text/plain" || f.type === "text/markdown" || /\.(?:txt|md|markdown|log)$/i.test(f.name)) return k;
  return "code";
}

/** a CSS color written out: hex, or a color function with numbers, units,
 *  commas, slashes and spaces only, so a swatch can never carry anything else */
const COLOR_HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?:[-+0-9.%\s,/]|deg|grad|rad|turn|none){1,80}\)$/i;
const HASH = /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}$/;
const ABS_PATH = /^(?:~|\.{1,2})?\/[^\n\0]*$/;
const REL_PATH = /^[\w.@-]+(?:\/[\w.@-]+)+\/?$/;

/** the words that open a shell command often enough to call a line one */
const COMMAND_WORDS = new Set([
  "awk", "brew", "bun", "bunx", "canopy", "cargo", "cat", "cd", "chmod", "claude", "code", "codex", "cp", "curl", "deno", "docker", "echo",
  "export", "find", "gh", "git", "go", "grep", "head", "journalctl", "just", "kill", "kubectl", "ls", "make", "mise", "mkdir", "mv", "node",
  "npm", "npx", "open", "pacman", "pnpm", "python", "python3", "rg", "rm", "rsync", "scp", "sed", "ssh", "sudo", "systemctl", "tail",
  "tailscale", "tmux", "touch", "uv", "uvx", "vim", "wget", "yarn",
]);

/** whether a JSON parse of `t` comes back as an object or an array */
function isJson(t: string): boolean {
  if (t.length > 200_000) return false;
  const first = t[0];
  const last = t[t.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return false;
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === "object" && v !== null;
  } catch {
    return false;
  }
}

/** whether lines read as code: a third of them indented or carrying code's punctuation */
function codey(lines: readonly string[]): boolean {
  const full = lines.filter((l) => l.trim() !== "");
  if (full.length < 2) return false;
  const hits = full.filter((l) => /^\s{2,}|\t/.test(l) || /[{};]\s*$|=>|\(\)|^\s*(?:import|export|const|let|function|def|class|return|if|for)\b/.test(l)).length;
  return hits * 3 >= full.length;
}

/** What a clip's text is, for the viewer: a link, a color, a hash, a path,
 *  JSON, a shell command, code, or plain text. */
export function clipKind(text: string): ClipKind {
  const t = text.trim();
  if (!t) return "text";
  const lines = t.split("\n");
  if (lines.length === 1) {
    if (COLOR_HEX.test(t) || COLOR_FN.test(t)) return "color";
    if (/^https?:\/\/\S+$/i.test(t)) {
      try {
        new URL(t);
        return "link";
      } catch {
        // not a URL after all: plain text below
      }
    }
    if (HASH.test(t)) return "hash";
    if (!t.includes("://") && t.length <= 1024 && (ABS_PATH.test(t) || REL_PATH.test(t) || /^[A-Za-z]:\\/.test(t))) return "path";
  }
  if (isJson(t)) return "json";
  const word = (lines[0] ?? "").replace(/^\$\s+/, "").split(/\s+/)[0] ?? "";
  const continued = lines.slice(0, -1).every((l) => l.trimEnd().endsWith("\\"));
  if ((lines.length === 1 || continued) && (t.startsWith("$ ") || COMMAND_WORDS.has(word))) return "command";
  if (lines.length > 1 && codey(lines)) return "code";
  return "text";
}

/** a whitelisted CSS color the viewer may paint a swatch with, or null */
export const swatchOf = (text: string): string | null => (clipKind(text) === "color" ? text.trim() : null);

/** how many lines a clip's text runs to */
export const lineCount = (text: string): number => text.replace(/\n+$/, "").split("\n").length;

/** a clip as one line: its text with whitespace runs folded, cut at `max` with an ellipsis */
export function clipLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "now", "4m", "2h", "3d": how long ago a clip was copied */
export function agoWord(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

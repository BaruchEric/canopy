/**
 * The clipboard (FR-054): every copy canopy sees, whatever made it, kept on
 * a backend so another window or another device can take it again. A clip
 * is a piece of text with where it came from: a program in a shell (OSC 52)
 * or a shell's selection, one of canopy's own copy buttons and keys, text
 * selected on the page, `canopy clip` from a shell, an agent or a script, or
 * this device's clipboard taken in by hand. The same text copied again is
 * the same clip, moved to the top. Text shaped like a key or a password is
 * never kept (`looksSecret`), and neither is anything pasted.
 *
 * Browser-safe and pure: the page imports the record, the kinds and the
 * words; the server half is `server/clips.ts`. Tested in clips.test.ts.
 */

import { mintNoteId } from "./notes";

export const CLIP_SOURCES = ["shell", "canopy", "page", "cli", "clipboard"] as const;
export type ClipSource = (typeof CLIP_SOURCES)[number];

export const isClipSource = (v: unknown): v is ClipSource => typeof v === "string" && (CLIP_SOURCES as readonly string[]).includes(v);

/** what each source is, for a title */
export const CLIP_SOURCE_WHAT: Readonly<Record<ClipSource, string>> = {
  shell: "Copied in a shell: a program's copy (Claude Code's, tmux's) or a selection",
  canopy: "Copied by one of canopy's copy buttons, copy keys or gears",
  page: "Text selected on the page and copied",
  cli: "Sent with canopy clip, from a shell, an agent or a script",
  clipboard: "Taken in from a device's clipboard",
};

/** the most characters a clip keeps; past it the text is cut and the clip says so */
export const CLIP_CHARS = 16_000;
/** how many unpinned clips a backend keeps, newest first */
export const CLIP_KEEP = 200;
/** how long an unpinned clip is kept after it was last copied */
export const CLIP_DAYS = 14;
/** the most characters a clip's `from` and a device's name keep */
export const CLIP_FROM_CHARS = 80;

/** the browser that made a clip */
export interface ClipDevice {
  /** the browser's own id (client.ts) */
  id: string;
  /** what the user calls it, or the browser's guess ("Mac, Chrome") */
  name: string;
  /** mac, android, windows, linux, ios, other */
  platform: string;
}

export interface Clip {
  /** `c-` and eight base32 characters */
  id: string;
  text: string;
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

/** what a page, a shell or the CLI sends to keep a clip */
export interface ClipIn {
  text: string;
  source: ClipSource;
  from?: string;
  device?: ClipDevice;
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
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
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
  /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*["']?[^\s"']{8,}/m,
];

/** whether text carries something shaped like a key or a password, which is never kept */
export const looksSecret = (text: string): boolean => SECRET_SHAPES.some((re) => re.test(text));

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

/** one record of the file as a clip, or null when it is not one */
export function parseClip(v: unknown): Clip | null {
  if (!isRecord(v) || !isClipId(v["id"]) || typeof v["text"] !== "string" || !v["text"] || !isClipSource(v["source"])) return null;
  const at = timeOf(v["at"]);
  if (at === undefined) return null;
  const clip: Clip = {
    id: v["id"],
    text: v["text"].slice(0, CLIP_CHARS),
    source: v["source"],
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
 *  CLIP_KEEP unpinned ones copied within CLIP_DAYS. `gone` is the ids left
 *  out; the list is the same object when nothing went. */
export function pruneClips(clips: readonly Clip[], now: number): { clips: readonly Clip[]; gone: string[] } {
  const gone: string[] = [];
  let kept = 0;
  const out = sortClips(clips).filter((c) => {
    if (c.pinned) return true;
    if (now - c.at > CLIP_DAYS * DAY || kept >= CLIP_KEEP) {
      gone.push(c.id);
      return false;
    }
    kept += 1;
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
  const { text, cut } = clipText(incoming.text);
  const old = clips.find((c) => c.text === text);
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
  if (cut || old?.cut) clip.cut = true;
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

export const CLIP_KINDS = ["link", "color", "hash", "path", "json", "command", "code", "text"] as const;
export type ClipKind = (typeof CLIP_KINDS)[number];

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

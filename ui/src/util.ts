import { isDirty, type GitUser, type Repo } from "../../src/core/types";

export type RepoState = "error" | "conflict" | "dirty" | "ahead" | "clean";

export function stateOf(r: Repo): RepoState {
  if (r.error) return "error";
  if (r.status?.files.some((f) => f.conflicted)) return "conflict";
  if ((r.status?.files.length ?? 0) > 0) return "dirty";
  if ((r.status?.ahead ?? 0) > 0) return "ahead";
  return "clean";
}

/** The "needs attention" filter: local changes, unpushed commits, or a repo
 *  git cannot read. Behind-only repos stay out; nothing of yours is at risk. */
export const needsAttention = (r: Repo): boolean =>
  isDirty(r) || Boolean(r.error);

export function ago(unixSeconds: number | undefined): string {
  if (!unixSeconds) return "—";
  const s = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / 86400 / 30)}mo ago`;
}

/** API-equivalent dollars the way claude-history prints them: cents until
 *  the number is big enough that they stop meaning anything. */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function duration(ms: number | null): string {
  if (ms === null || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** A session's start, local: "Aug 24 19:50" this year, "Nov 03, 2025" before
 *  it. Both are 12 characters so a column of them lines up. */
export function when(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mon = MONTHS[d.getMonth()] ?? "";
  if (d.getFullYear() === now.getFullYear()) {
    return `${mon} ${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return `${mon} ${pad2(d.getDate())}, ${d.getFullYear()}`;
}

/** A local YYYY-MM-DD as "Aug 24" for ring tooltips. */
export function dayLabel(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? ""} ${d ?? ""}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One line for a tool call, from the JSON claude-history kept of its input:
 *  the command for Bash, the path for file tools, else the tool's own name. */
export function toolLine(name: string, inputJson: string): string {
  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch {
    return inputJson.slice(0, 120);
  }
  if (!isRecord(input)) return "";
  const pick = (k: string): string | null => {
    const v = input[k];
    return typeof v === "string" ? v : null;
  };
  const line =
    pick("command") ??
    pick("file_path") ??
    pick("path") ??
    pick("pattern") ??
    pick("query") ??
    pick("url") ??
    pick("description") ??
    pick("prompt") ??
    pick("skill") ??
    "";
  return line.replace(/\s+/g, " ").trim().slice(0, 160);
}

export const GLYPH: Record<RepoState, string> = {
  error: "✗",
  conflict: "◆",
  dirty: "●",
  ahead: "◐",
  clean: "○",
};

/** A remote link as a person reads it: "github.com/owner/name". Falls back to
 *  the URL itself if it will not parse. */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname}`;
  } catch {
    return url;
  }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** One key per identity for grouping and filtering: the email, lower-cased,
 *  or the name when there is no email. Null when the repo has neither. */
export function userKey(r: Repo): string | null {
  const u = r.status?.user;
  return u ? (u.email || u.name).toLowerCase() : null;
}

export interface Identity {
  key: string;
  /** the name, or the email when there is no name */
  label: string;
  email: string;
}

/** Every identity across the given repos, in first-seen order. Two identities
 *  that share a name get the email appended, the way git writes authors, so
 *  the two headings cannot be told apart only by their counts. */
export function identities(repos: Repo[]): Identity[] {
  const seen = new Map<string, GitUser>();
  for (const r of repos) {
    const key = userKey(r);
    const u = r.status?.user;
    if (key !== null && u && !seen.has(key)) seen.set(key, u);
  }
  const byName = new Map<string, number>();
  for (const u of seen.values()) {
    const n = u.name || u.email;
    byName.set(n, (byName.get(n) ?? 0) + 1);
  }
  return [...seen.entries()].map(([key, u]) => {
    const name = u.name || u.email;
    const shared = (byName.get(name) ?? 0) > 1 && u.name && u.email;
    return { key, label: shared ? `${u.name} <${u.email}>` : name, email: u.email };
  });
}

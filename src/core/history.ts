/**
 * The archive behind the rings: claude-history keeps every Claude Code session
 * per project, and canopy reads it through that CLI's `--json` reports rather
 * than its sqlite file, so the schema stays claude-history's business.
 * Bun-only (spawns processes); the browser gets the results through the API.
 */
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import type {
  CanopyConfig,
  HistoryHit,
  HistoryOverview,
  HistorySession,
  HistorySessionDetail,
  HistoryWindow,
  Repo,
  RepoHistory,
} from "./types";

/** Days the rings cover: today and the ones before it, on the local clock. */
export const RING_DAYS = 30;

/** An error carrying the HTTP status the API should answer with. */
export class HistoryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HistoryError";
  }
}

/** Where the CLI is: the config's word first, then PATH, then the checkout
 *  that lives next to canopy in ~/dev. */
export function locateHistory(
  cfg: CanopyConfig,
): { bin: string } | { reason: string } {
  if (cfg.historyBin) {
    return existsSync(cfg.historyBin)
      ? { bin: cfg.historyBin }
      : { reason: `historyBin in config points at ${cfg.historyBin}, which does not exist` };
  }
  const onPath = Bun.which("claude-history");
  if (onPath) return { bin: onPath };
  const sibling = join(homedir(), "dev", "dev-tools", "claude-history", "bin", "claude-history");
  if (existsSync(sibling)) return { bin: sibling };
  return {
    reason:
      "claude-history is not on PATH and not at ~/dev/dev-tools/claude-history; set historyBin in ~/.config/canopy/config.json",
  };
}

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";

/** The message out of a crashed CLI's stderr. Bun prints the source frame
 *  first and the "SomeError: why" line after it, so the first line is code. */
function crashMessage(stderr: string, stdout: string, code: number): string {
  for (const line of stderr.split("\n")) {
    const m = /^\s*(?:\w*Error|error):\s*(.+)$/.exec(line);
    if (m?.[1]) return m[1].trim();
  }
  return firstLine(stderr) || firstLine(stdout) || `claude-history exited ${code}`;
}

/** Runs one report with --json. The CLI answers a bad lookup ("no project
 *  matches", "no session starts with") as plain text on stdout with exit 0,
 *  so a parse failure is a 404 carrying that text, not a crash. */
async function report<T>(bin: string, args: string[]): Promise<T> {
  const r = await exec([bin, ...args, "--json"], { timeoutMs: 60_000 });
  if (r.code !== 0) {
    const why = crashMessage(r.stderr, r.stdout, r.code);
    // an FTS query the index cannot parse is the caller's to fix
    const status = /fts5|syntax error/i.test(why) ? 400 : 502;
    throw new HistoryError(status, why);
  }
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new HistoryError(404, firstLine(r.stdout) || "claude-history returned nothing");
  }
}

/** claude-history `projects --json` */
interface ProjectRow {
  id: string;
  name: string;
  path: string;
  sessions: number;
  tokens: number;
  cost: number;
  first: string | null;
  last: string | null;
  commits: number;
}

/** claude-history `activity --json` */
interface ActivityRow {
  project: string;
  /** local date */
  day: string;
  sessions: number;
  cost: number;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The last `n` local dates ending today, oldest first. */
export function localDays(n: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

/** Local midnight of a YYYY-MM-DD, as the ISO instant `--since` takes. */
export function localMidnightIso(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toISOString();
}

/** Paths as the filesystem knows them, so ~/Arik/dev and ~/dev agree. */
async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** Every repo's slice of the archive, matched on path. Two CLI calls however
 *  many repos there are: the project list, and the per-day activity. */
export async function historyOverview(
  bin: string,
  repos: Repo[],
  now = new Date(),
): Promise<HistoryOverview> {
  const days = localDays(RING_DAYS, now);
  const since = localMidnightIso(days[0] ?? dayKey(now));
  const [projects, activity] = await Promise.all([
    report<ProjectRow[]>(bin, ["projects"]),
    report<ActivityRow[]>(bin, ["activity", "--since", since]),
  ]);

  const byPath = new Map<string, ProjectRow>();
  for (const p of projects) byPath.set(await real(p.path), p);

  const out: Record<string, RepoHistory> = {};
  // a project can back more than one repo (a worktree checkout, say)
  const reposOf = new Map<string, string[]>();
  for (const r of repos) {
    const p = byPath.get(await real(r.path));
    if (!p) continue;
    out[r.id] = {
      project: p.id,
      sessions: p.sessions,
      costUsd: p.cost,
      tokens: p.tokens,
      commits: p.commits,
      first: p.first,
      last: p.last,
      days: Array.from(days, () => 0),
      daySessions: Array.from(days, () => 0),
    };
    reposOf.set(p.id, [...(reposOf.get(p.id) ?? []), r.id]);
  }

  const dayIdx = new Map(days.map((d, i) => [d, i]));
  let maxDay = 0;
  for (const a of activity) {
    const i = dayIdx.get(a.day);
    if (i === undefined) continue;
    for (const id of reposOf.get(a.project) ?? []) {
      const h = out[id];
      if (!h) continue;
      h.days[i] = (h.days[i] ?? 0) + a.cost;
      h.daySessions[i] = (h.daySessions[i] ?? 0) + a.sessions;
      maxDay = Math.max(maxDay, h.days[i] ?? 0);
    }
  }
  return { available: true, days, maxDay, repos: out, fetchedAt: Date.now() };
}

export function historySessions(
  bin: string,
  project: string,
  window: HistoryWindow,
  limit = 60,
): Promise<HistorySession[]> {
  const args = ["sessions", project, "--limit", String(limit)];
  if (window !== "all") args.push("--since", window);
  return report<HistorySession[]>(bin, args);
}

/** Session ids are uuids or cloud ids; anything else never reaches the CLI. */
const SESSION_ID = /^[\w-]{6,80}$/;

export async function historySession(
  bin: string,
  project: string,
  sessionId: string,
): Promise<HistorySessionDetail> {
  if (!SESSION_ID.test(sessionId)) throw new HistoryError(400, "malformed session id");
  const detail = await report<HistorySessionDetail>(bin, ["show", sessionId]);
  // `show` matches any prefix across the whole archive; hold it to this repo
  if (detail.session.project_id !== project) {
    throw new HistoryError(404, "that session belongs to another project");
  }
  return detail;
}

export function historySearch(
  bin: string,
  project: string,
  query: string,
  limit = 40,
): Promise<HistoryHit[]> {
  return report<HistoryHit[]>(bin, ["search", query, "--project", project, "--limit", String(limit)]);
}

/** Opens the session's vault note: in Obsidian when it is installed, else in
 *  whatever the system opens markdown with. */
export async function openHistoryNote(
  bin: string,
  project: string,
  sessionId: string,
): Promise<void> {
  const { session } = await historySession(bin, project, sessionId);
  const note = session.note_path;
  if (!note || !existsSync(note)) {
    throw new HistoryError(404, "no note for this session yet; run claude-history sync");
  }
  const viaObsidian = await exec(
    ["open", `obsidian://open?path=${encodeURIComponent(note)}`],
    { timeoutMs: 15_000 },
  );
  if (viaObsidian.code === 0) return;
  const plain = await exec(["open", note], { timeoutMs: 15_000 });
  if (plain.code !== 0) throw new HistoryError(500, plain.stderr.trim() || "could not open the note");
}

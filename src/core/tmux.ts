/**
 * canopy's tmux server: the thing that lets a shell outlive the canopy
 * process. Every shell is a session named for its id on a socket under the
 * config dir, started with `lib/tmux.conf` (no status bar, no prefix), and
 * every browser socket on it is a tmux client of its own on a pty, so tmux
 * hands each one the screen and the terminal modes as it would any
 * terminal, and asks it what it is while it is there to answer. When
 * canopy stops, the clients go and the sessions stay; when it starts, it
 * lists them, and the next socket attaches. The session carries the repo,
 * place and path in user options, so the list is enough to rebuild what
 * the browser reads. What scrolled off before a client came is read back
 * out of tmux's history and sent ahead of the attach (`primeText`).
 *
 * The argv builders, the list parser and `primeText` are pure and tested;
 * the rest is Bun-only.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./exec";
import { parseLocator, shellQuote } from "./host";
import { configDir } from "./store";
import { isTermId, shellArgs, spawnOnPty, termPlace, type TermHooks, type TermSession, type TermSize } from "./term";
import type { ShellPlace } from "./types";

/** what a session knows about the shell it holds */
export interface TmuxMeta {
  id: string;
  repoId: string;
  /** the repo's locator, where the shell landed */
  path: string;
  place: ShellPlace;
  /** the tailchan handle the shell runs under (`TAILCHAN_AS`), when it has one */
  handle?: string;
}

const PREFIX = "canopy-";

/** the session for a shell: its id is tmux-name-safe (hex, no dots or colons) */
export const sessionName = (id: string): string => `${PREFIX}${id}`;

/** the shell a session name is for, or null for one canopy did not make */
export function sessionId(name: string): string | null {
  if (!name.startsWith(PREFIX)) return null;
  const id = name.slice(PREFIX.length);
  return isTermId(id) ? id : null;
}

/** the front of every tmux argv: the binary, `-u` to force UTF-8 (a
 *  launchd job runs in the C locale, where tmux turns the tab in
 *  `LIST_FORMAT` into `_` and `parseSessions` reads nothing), canopy's
 *  socket and its config */
export const tmuxArgv = (bin: string, socket: string, conf: string): string[] => [bin, "-u", "-S", socket, "-f", conf];

/**
 * A detached session for a shell, sized for the terminal that will show it,
 * running what the pty would have run directly (`shellArgs`), then the
 * repo, place and path set on it in the same call. A local folder is the
 * session's start directory; a remote shell is an ssh line and starts here.
 * A handle goes into the session's environment as `TAILCHAN_AS` and onto
 * it as an option, so a later list reads it back.
 */
export function newSessionArgs(base: string[], meta: TmuxMeta, size: TermSize, command: string[]): string[] {
  const name = sessionName(meta.id);
  const { host, path } = parseLocator(meta.path);
  return [
    ...base,
    "new-session",
    "-d",
    "-s",
    name,
    ...(host === null ? ["-c", path] : []),
    ...(meta.handle ? ["-e", `TAILCHAN_AS=${meta.handle}`] : []),
    "-x",
    String(size.cols),
    "-y",
    String(size.rows),
    command.map(shellQuote).join(" "),
    ";",
    "set-option",
    "-t",
    name,
    "@canopy_repo",
    meta.repoId,
    ";",
    "set-option",
    "-t",
    name,
    "@canopy_place",
    meta.place,
    ";",
    "set-option",
    "-t",
    name,
    "@canopy_path",
    meta.path,
    ...(meta.handle ? [";", "set-option", "-t", name, "@canopy_handle", meta.handle] : []),
  ];
}

export const attachArgs = (base: string[], id: string): string[] => [...base, "attach-session", "-t", sessionName(id)];

export const killArgs = (base: string[], id: string): string[] => [...base, "kill-session", "-t", sessionName(id)];

export const hasArgs = (base: string[], id: string): string[] => [...base, "has-session", "-t", sessionName(id)];

/** how many lines of history a new client is handed */
export const HISTORY_LINES = 2000;

export const historySizeArgs = (base: string[], id: string): string[] => [
  ...base,
  "display-message",
  "-p",
  "-t",
  sessionName(id),
  "#{history_size}",
];

/** the last `lines` of history before the screen, colors kept, wrapped
 *  lines joined so the client wraps them at its own width */
export const captureArgs = (base: string[], id: string, lines = HISTORY_LINES): string[] => [
  ...base,
  "capture-pane",
  "-p",
  "-e",
  "-J",
  "-t",
  sessionName(id),
  "-S",
  `-${lines}`,
  "-E",
  "-1",
];

/** The same capture, plus the screen the pane shows now: what is on screen
 *  is redrawn for a client that attaches, so `captureArgs` leaves it out,
 *  but nothing redraws it after the machine goes down. This is the shape
 *  kept on disk. */
export const snapshotArgs = (base: string[], id: string, lines = HISTORY_LINES): string[] => [
  ...base,
  "capture-pane",
  "-p",
  "-e",
  "-J",
  "-t",
  sessionName(id),
  "-S",
  `-${lines}`,
  "-E",
  "-",
];

/** what tmux can say about the pane: the command it is running and its
 *  title, which is what `agentIn` reads to tell an agent shell apart */
export const PANE_FORMAT = "#{pane_current_command}\t#{pane_title}";

export const paneArgs = (base: string[], id: string): string[] => [...base, "display-message", "-p", "-t", sessionName(id), PANE_FORMAT];

/** a line typed into a shell, Enter and all */
export const sendLineArgs = (base: string[], id: string, line: string): string[] => [...base, "send-keys", "-t", sessionName(id), line, "Enter"];

/** What a client is sent before tmux draws for it: the captured history as
 *  terminal lines, then enough newlines to push them off a screen of
 *  `rows`, since tmux's first draw clears the screen and what is on it then
 *  is lost, while what scrolled off is in the terminal's scrollback. Empty
 *  when there is no history. */
export function primeText(captured: string, rows: number): string {
  const lines = captured.replace(/\r?\n$/, "");
  if (lines === "") return "";
  return lines.split("\n").join("\r\n") + "\x1b[0m" + "\r\n".repeat(Math.max(1, rows));
}

/** one line per session: name, repo, place, created (unix seconds), path */
export const LIST_FORMAT = "#{session_name}\t#{@canopy_repo}\t#{@canopy_place}\t#{session_created}\t#{@canopy_path}\t#{@canopy_handle}";

export const listArgs = (base: string[]): string[] => [...base, "list-sessions", "-F", LIST_FORMAT];

/** a session as the list prints it */
export interface TmuxSession extends TmuxMeta {
  /** ms since the epoch */
  createdAt: number;
}

/** Reads `list-sessions -F LIST_FORMAT`. Sessions canopy did not make, or
 *  that lost their repo, are left out. */
export function parseSessions(out: string): TmuxSession[] {
  const sessions: TmuxSession[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [name = "", repoId = "", place, created = "", path = "", handle = ""] = line.split("\t");
    const id = sessionId(name);
    if (!id || !repoId || !path) continue;
    const secs = Number(created);
    sessions.push({
      id,
      repoId,
      path,
      place: termPlace(place),
      createdAt: Number.isFinite(secs) && secs > 0 ? secs * 1000 : Date.now(),
      ...(handle ? { handle } : {}),
    });
  }
  return sessions;
}

/** where a duplicate `new-session` is what tmux said, so the shell is there already */
export const isDuplicate = (stderr: string): boolean => /duplicate session/.test(stderr);

/** where a list failing is only the server not running yet */
export const noServer = (stderr: string): boolean => /no server running|No such file/.test(stderr);

/* ---------- Bun-only: the server on this machine ---------- */

/** the config bundled with canopy */
export const TMUX_CONF = join(import.meta.dir, "../../lib/tmux.conf");

/** where tmux sits when PATH does not say (a launchd job gets a bare one) */
const TMUX_PLACES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];

/** the tmux binary, or null when there is none to find */
export function findTmux(): string | null {
  const bin = Bun.which("tmux");
  if (bin) return bin;
  for (const place of TMUX_PLACES) if (existsSync(place)) return place;
  return null;
}

/** The argv front for canopy's tmux server, or null when tmux is not on
 *  this machine or `CANOPY_TMUX=0` asked for plain ptys. */
export function tmuxBase(): string[] | null {
  if (process.env["CANOPY_TMUX"] === "0") return null;
  const bin = findTmux();
  return bin ? tmuxArgv(bin, join(configDir(), "tmux.sock"), TMUX_CONF) : null;
}

/** the sessions canopy's server holds; none when it is not running */
export async function listSessions(base: string[]): Promise<TmuxSession[]> {
  const r = await exec(listArgs(base), { timeoutMs: 10_000 });
  if (r.code !== 0) {
    if (noServer(r.stderr)) return [];
    throw new Error(r.stderr.trim() || "tmux could not list its sessions");
  }
  return parseSessions(r.stdout);
}

/** Whether canopy's tmux server is answering at all. A session that is gone
 *  while the server is up is a shell that exited; the server itself being
 *  gone (its container restarted, the machine went down) is not, and the two
 *  must never be confused, since one means there is nothing left to restore
 *  and the other is exactly when what a shell left is wanted. Anything but a
 *  clean answer counts as down, which keeps records rather than dropping
 *  them on a hiccup. */
export async function serverUp(base: string[]): Promise<boolean> {
  return (await exec(listArgs(base), { timeoutMs: 10_000 })).code === 0;
}

/** ends canopy's tmux server and every shell on it (tests) */
export async function killServer(base: string[]): Promise<void> {
  await exec([...base, "kill-server"], { timeoutMs: 10_000 });
}

/** The session for a shell, made when there is none by that name. The
 *  command is the login shell for the repo unless a caller has something to
 *  run ahead of it (a restore replays what the lost shell printed). */
export async function newSession(base: string[], meta: TmuxMeta, size: TermSize, command = shellArgs(meta.path)): Promise<void> {
  const r = await exec(newSessionArgs(base, meta, size, command), { timeoutMs: 15_000 });
  if (r.code !== 0 && !isDuplicate(r.stderr)) throw new Error(r.stderr.trim() || "tmux could not start the shell");
}

export async function hasSession(base: string[], id: string): Promise<boolean> {
  return (await exec(hasArgs(base, id), { timeoutMs: 10_000 })).code === 0;
}

/** ends a shell's session; the clients on it exit on their own */
export async function killSession(base: string[], id: string): Promise<void> {
  await exec(killArgs(base, id), { timeoutMs: 10_000 });
}

/** How much the session has scrolled off its screen; 0 for one that has not
 *  yet, which is how a restored shell is told from one that has done work of
 *  its own since. */
export async function historySize(base: string[], id: string): Promise<number> {
  const size = await exec(historySizeArgs(base, id), { timeoutMs: 10_000 });
  if (size.code !== 0) return 0;
  const n = Number(size.stdout.trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** What a new client is sent before tmux draws for it (see `primeText`).
 *  A restored shell needs nothing special here: what it was restored from
 *  was printed into the pane, so it is the session's own history like the
 *  rest. */
export async function history(base: string[], id: string, rows: number, lines = HISTORY_LINES): Promise<string> {
  if (!(await historySize(base, id))) return "";
  const r = await exec(captureArgs(base, id, lines), { timeoutMs: 10_000 });
  return r.code === 0 ? primeText(r.stdout, rows) : "";
}

/** the pane's command and title, null when tmux will not say (the session
 *  or its server is gone) */
export async function paneInfo(base: string[], id: string): Promise<{ command: string; title: string } | null> {
  const r = await exec(paneArgs(base, id), { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  const [command = "", title = ""] = r.stdout.replace(/\n$/, "").split("\t");
  return { command, title };
}

/** the session's history and screen as they stand, for the record on disk;
 *  null when tmux will not say, which is not the same as an empty screen */
export async function snapshot(base: string[], id: string, lines = HISTORY_LINES): Promise<string | null> {
  const r = await exec(snapshotArgs(base, id, lines), { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout : null;
}

/** types a line into a shell, as though the user had */
export async function sendLine(base: string[], id: string, line: string): Promise<void> {
  await exec(sendLineArgs(base, id, line), { timeoutMs: 10_000 });
}

/** A pty client on a session: what one browser socket sees and types
 *  into. `detach` ends the client and leaves the session; `close` ends
 *  the session, and the client follows. */
export function attachTmuxTerm(base: string[], id: string, size: TermSize, hooks: TermHooks): TermSession {
  return spawnOnPty(
    {
      argv: attachArgs(base, id),
      end: () => killSession(base, id),
    },
    size,
    hooks,
  );
}

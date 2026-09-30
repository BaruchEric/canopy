/**
 * The processes under a shell's pane, for telling which agent it runs when
 * what tmux says is not enough: a bun-installed codex runs as `node`, so its
 * pane's command and title name no harness, and only the argv of the process
 * under the shell does. Linux reads `/proc` (canopy shares the shells
 * container's pid namespace on the mini, so it sees their processes); a Mac
 * asks `ps`. The parsers and the walk are pure and tested; the reads are
 * best effort and come back empty rather than throw.
 */
import { readdir, readFile, readlink } from "node:fs/promises";
import { exec } from "./exec";
import { agentIn, isShellCommand } from "./keep";
import type { PaneInfo } from "./tmux";
import type { AgentKind } from "./types";

export interface Proc {
  pid: number;
  ppid: number;
  argv: string[];
  /** the kernel's name for it (`/proc/<pid>/stat`'s, or `ps -o comm`'s,
   *  which on a Mac is the executable's path), when it was read */
  comm?: string;
  /** the one-letter state (`Z` for a zombie), on Linux */
  state?: string;
  /** when it started, unix ms, when it could be told */
  startedAt?: number;
}

/** how many processes under a pane are looked at, at most */
const TREE_CAP = 64;

/** The ppid out of a `/proc/<pid>/stat` line: the field after the state,
 *  which comes after the command in parens, and the command may itself hold
 *  spaces and parens, so the split starts at the last one. */
export function parseStatPpid(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const ppid = Number(stat.slice(close + 2).split(" ")[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
}

/** The `/proc/<pid>/stat` fields the process table keeps: the command
 *  (in parens, and it may hold spaces and parens itself), the state letter
 *  after it, the ppid, and the start time in clock ticks after boot (field
 *  22). Null for a line that is not one. */
export function parseStat(stat: string): { comm: string; state: string; ppid: number; start: number | null } | null {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = stat.slice(close + 2).split(" ");
  const ppid = Number(rest[1]);
  if (!Number.isInteger(ppid) || ppid < 0) return null;
  const start = Number(rest[19]);
  return { comm: stat.slice(open + 1, close), state: rest[0] ?? "", ppid, start: Number.isFinite(start) && rest[19] !== undefined ? start : null };
}

/** The boot time out of `/proc/stat`, unix seconds: its `btime` line. A
 *  container reads the host's, which is what its processes' start ticks
 *  count from. */
export function parseBootTime(text: string): number | null {
  const m = /^btime\s+(\d+)\s*$/m.exec(text);
  return m ? Number(m[1]) : null;
}

/** clock ticks a second in `/proc/<pid>/stat` (USER_HZ, 100 on every
 *  Linux canopy runs on) */
export const CLOCK_TICKS = 100;

/** a stat start time as unix ms, off the boot time */
export const tickTime = (bootSecs: number, ticks: number, hz = CLOCK_TICKS): number => Math.round(bootSecs * 1000 + (ticks * 1000) / hz);

/** `/proc/<pid>/cmdline`: NUL-separated words, empty for a kernel thread. */
export const parseCmdline = (raw: string): string[] => raw.split("\0").filter((w) => w !== "");

/** `ps -axo pid=,ppid=,args=`: one process a line. The args are split on
 *  spaces, which is enough for the program and script words read here. */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), argv: (m[3] ?? "").trim().split(/\s+/).filter(Boolean) });
  }
  return out;
}

/** The processes under `root`, root first, each before its children, at
 *  most `cap` of them. */
export function descendants(procs: readonly Proc[], root: number, cap = TREE_CAP): Proc[] {
  const kids = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = kids.get(p.ppid);
    if (list) list.push(p);
    else kids.set(p.ppid, [p]);
  }
  const out: Proc[] = [];
  const self = procs.find((p) => p.pid === root);
  const queue: Proc[] = self ? [self] : (kids.get(root) ?? []).slice();
  const seen = new Set<number>();
  while (queue.length && out.length < cap) {
    const p = queue.shift()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    for (const k of kids.get(p.pid) ?? []) queue.push(k);
  }
  return out;
}

/** Every process `/proc` shows: pid, ppid, argv, and off the same stat
 *  read its comm, state and start (as unix ms when the boot time reads). */
export async function linuxProcs(): Promise<Proc[]> {
  const [pids, boot] = await Promise.all([
    readdir("/proc").then((ds) => ds.filter((d) => /^\d+$/.test(d))).catch(() => [] as string[]),
    readFile("/proc/stat", "utf8").then(parseBootTime).catch(() => null),
  ]);
  const read = await Promise.all(
    pids.map(async (pid): Promise<Proc | null> => {
      const [stat, cmd] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""),
        readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
      ]);
      const f = parseStat(stat);
      if (!f) return null;
      return {
        pid: Number(pid),
        ppid: f.ppid,
        argv: parseCmdline(cmd),
        comm: f.comm,
        state: f.state,
        ...(boot !== null && f.start !== null ? { startedAt: tickTime(boot, f.start) } : {}),
      };
    }),
  );
  return read.filter((p): p is Proc => p !== null);
}

/** A process's working folder off `/proc`, undefined when it cannot be
 *  read (another user's, or gone). Shared by the ports list and the scan. */
export const procCwd = (pid: number | string): Promise<string | undefined> => readlink(`/proc/${pid}/cwd`).catch(() => undefined);

/** a process's comm off `/proc`, trimmed */
export const procComm = (pid: number | string): Promise<string | undefined> =>
  readFile(`/proc/${pid}/comm`, "utf8")
    .then((s) => s.trim())
    .catch(() => undefined);

async function psProcs(): Promise<Proc[]> {
  const r = await exec(["ps", "-axo", "pid=,ppid=,args="], { timeoutMs: 5_000 });
  return r.code === 0 ? parsePs(r.stdout) : [];
}

/** the argv of every process under `root` on this machine */
export async function processTree(root: number): Promise<string[][]> {
  const procs = process.platform === "linux" ? await linuxProcs() : await psProcs();
  return descendants(procs, root).map((p) => p.argv);
}

/** The agent a pane runs: what tmux says, and when that names nothing and
 *  the pane is not at a shell prompt, the argv under it. */
export async function paneAgent(pane: PaneInfo): Promise<AgentKind | null> {
  const quick = agentIn(pane.command, pane.title);
  if (quick || isShellCommand(pane.command) || !pane.pid) return quick;
  return agentIn(pane.command, pane.title, await processTree(pane.pid).catch(() => []));
}

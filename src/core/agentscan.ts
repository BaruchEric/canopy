/**
 * The agent scan (agents spec, phase 3): every Claude Code and Codex process
 * on this backend's machine, hooked or not, posted to tailchan's broker as
 * this node's scan cards every `SCAN_EVERY`. The broker drops a pid a hooked
 * card already names, so the scan is what shows an agent started without
 * the hooks.
 *
 * Linux reads `/proc` through procs.ts's walk (pid, ppid, argv, and comm,
 * state and start off the one stat read), then each agent's cwd. A Mac asks
 * `ps` twice, the long columns with the args last and then the comm alone,
 * since on a Mac the comm is the executable's path, which may hold spaces,
 * and only the last column can; then `lsof` for the agents' cwds. The
 * parsers, `classify`, `pickAgents` and `scanBody` are pure and tested; the
 * walk in `scanProcs` is the only part that reads the machine.
 */
import { existsSync } from "node:fs";
import { exec } from "./exec";
import { argvAgent } from "./keep";
import { parseLsofCwd, repoOfCwd } from "./ports";
import { linuxProcs, procCwd, type Proc } from "./procs";
import type { Harness, Repo, ScanBody, ScanProc } from "./types";

/** how often a backend scans its machine */
export const SCAN_EVERY = 30_000;

/** one agent the scan found, before its folder is matched to a repo */
export interface AgentProc {
  pid: number;
  ppid: number;
  harness: Harness;
  /** "" when it could not be read (another user's process) */
  cwd: string;
  startedAt: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})/;

/** `ps -o lstart` ("Wed Sep 30 10:11:12 2026", in the C locale), as unix ms
 *  in this machine's time zone; null for anything else */
export function parseLstart(text: string): number | null {
  const m = LSTART.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2] ?? "");
  if (month < 0) return null;
  return new Date(Number(m[7]), month, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

/** `ps -axww -o pid=,ppid=,lstart=,args=`: one process a line, the args
 *  split on spaces, which is enough for the program and script words the
 *  classifier reads */
export function parsePsLong(text: string): Proc[] {
  const out: Proc[] = [];
  const line = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(${LSTART.source})\\s*(.*)$`);
  for (const l of text.split("\n")) {
    const m = line.exec(l);
    if (!m) continue;
    const startedAt = parseLstart(m[3] ?? "");
    const args = m[11] ?? "";
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      argv: args.trim().split(/\s+/).filter(Boolean),
      ...(startedAt !== null ? { startedAt } : {}),
    });
  }
  return out;
}

/** `ps -ax -o pid=,comm=`: each process's comm by pid, spaces and all */
export function parsePsComm(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const l of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(l);
    if (m?.[2]) out.set(Number(m[1]), m[2]);
  }
  return out;
}

const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const INTERPRETER = /^(node|nodejs|bun|deno)(\d+(\.\d+)*)?$/;
const VERSION = /^\d+\.\d+\.\d+/;

/**
 * The harness a process is, or null. Measured, not assumed: Claude Code's
 * comm is `claude` on Linux, and on a Mac its executable is the version
 * file under `~/.local/share/claude/versions/`, so its comm reads as a
 * version string, taken as Claude only with `claude` in its path or argv
 * (or an argv that is its version too); a bun- or npm-installed Codex is
 * `node …/codex` (the script word only counts after an interpreter, so
 * `which codex` is no agent) over a native `codex` child.
 */
export function classify(comm: string, argv: readonly string[]): Harness | null {
  const name = base(comm).toLowerCase();
  if (name === "claude") return "claude";
  if (name === "codex") return "codex";
  const head = base(argv[0] ?? "").toLowerCase();
  if (VERSION.test(name)) {
    const claude = [comm, ...argv.slice(0, 2)].some((w) => /claude/i.test(w)) || VERSION.test(head);
    return claude ? "claude" : null;
  }
  const words = INTERPRETER.test(head) || INTERPRETER.test(name) ? argv.slice(0, 2) : argv.slice(0, 1);
  return argvAgent(words);
}

/** The agents in a process table: each process `classify` names, but not a
 *  zombie, and not one whose parent is the same harness, which is Codex's
 *  node wrapper over its native binary: one agent, counted by the parent. */
export function pickAgents(procs: readonly Proc[]): (Proc & { harness: Harness })[] {
  const hits = new Map<number, Proc & { harness: Harness }>();
  for (const p of procs) {
    if (p.state === "Z") continue;
    const harness = classify(p.comm ?? p.argv[0] ?? "", p.argv);
    if (harness) hits.set(p.pid, { ...p, harness });
  }
  return [...hits.values()].filter((p) => hits.get(p.ppid)?.harness !== p.harness).sort((a, b) => a.pid - b.pid);
}

/** What the broker's scan route takes: each agent with its repo (the
 *  remote as a web url, the key cards join repo cards on) and branch when
 *  its folder is inside a scanned repo on this machine, the deepest one
 *  when repos nest. */
export function scanBody(procs: readonly AgentProc[], repos: readonly Repo[], container: boolean, os: string): ScanBody {
  const local = repos.filter((r) => !r.host && !r.forge);
  return {
    container,
    os,
    procs: procs.map((p): ScanProc => {
      const id = repoOfCwd(p.cwd || undefined, local);
      const repo = id === undefined ? undefined : local.find((r) => r.id === id);
      const branch = repo?.status?.branch;
      return {
        pid: p.pid,
        harness: p.harness,
        cwd: p.cwd,
        startedAt: p.startedAt,
        ...(repo?.link ? { repo: repo.link } : {}),
        ...(branch ? { branch } : {}),
      };
    }),
  };
}

/** whether this process runs in a container, which is the pid namespace a
 *  scan names: docker's `/.dockerenv` or podman's `/run/.containerenv` */
export const inContainer = (exists: (p: string) => boolean = existsSync): boolean =>
  exists("/.dockerenv") || exists("/run/.containerenv");

/** the tail of a timed-out command's output cut back to whole lines, so a
 *  half line never reads as a different pid or folder */
const whole = (text: string): string => text.slice(0, text.lastIndexOf("\n") + 1);

async function macProcs(): Promise<Proc[]> {
  const env = { LC_ALL: "C", LANG: "C" };
  const [long, comm] = await Promise.all([
    exec(["ps", "-axww", "-o", "pid=,ppid=,lstart=,args="], { timeoutMs: 5_000, env }),
    exec(["ps", "-ax", "-o", "pid=,comm="], { timeoutMs: 5_000, env }),
  ]);
  const comms = parsePsComm(whole(comm.stdout));
  return parsePsLong(whole(long.stdout)).map((p) => {
    const c = comms.get(p.pid);
    return c ? { ...p, comm: c } : p;
  });
}

async function macCwds(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  const r = await exec(["lsof", "-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], { timeoutMs: 2_000 });
  return parseLsofCwd(whole(r.stdout));
}

/** Every agent on this machine, best effort: an unreadable table is none. */
export async function scanProcs(platform: NodeJS.Platform = process.platform): Promise<AgentProc[]> {
  const now = Date.now();
  if (platform === "linux") {
    const hits = pickAgents(await linuxProcs());
    return Promise.all(
      hits.map(async (p) => ({ pid: p.pid, ppid: p.ppid, harness: p.harness, cwd: (await procCwd(p.pid)) ?? "", startedAt: p.startedAt ?? now })),
    );
  }
  if (platform === "darwin") {
    const hits = pickAgents(await macProcs().catch(() => []));
    const cwds = await macCwds(hits.map((p) => p.pid)).catch(() => new Map<number, string>());
    return hits.map((p) => ({ pid: p.pid, ppid: p.ppid, harness: p.harness, cwd: cwds.get(p.pid) ?? "", startedAt: p.startedAt ?? now }));
  }
  return [];
}

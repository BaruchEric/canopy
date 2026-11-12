/**
 * The agent scan (agents spec, phase 3): every Claude Code and Codex process
 * on this backend's machine, hooked or not, posted to tailchan's broker as
 * this node's scan cards every `SCAN_EVERY`. The broker drops a pid a hooked
 * card already names, so the scan is what shows an agent started without
 * the hooks.
 *
 * One kind it passes over: a process a test run started (`underTest`,
 * `NODE_ENV=test` in its environment). canopy's own suite types `claude`
 * into shells and runs stand-ins named `claude`, in folders that are gone
 * a minute later, and a backend on the same machine listed each as an
 * agent: 79 of the registry's 350 cards on 2026-11-09.
 *
 * Linux reads `/proc` through procs.ts's walk (pid, ppid, argv, and comm,
 * state and start off the one stat read), then each agent's cwd. A Mac asks
 * `ps` twice, the long columns with the args last and then the comm alone,
 * since on a Mac the comm is the executable's path, which may hold spaces,
 * and only the last column can; then `lsof` for the agents' cwds. The
 * parsers, `classify`, `pickAgents` and `scanBody` are pure and tested; the
 * walk in `scanProcs` is the only part that reads the machine.
 *
 * A scan card has no hooks to say what the agent is doing, so the scan
 * guesses it from CPU: an agent whose process tree (itself, its tools, its
 * MCP servers) used `BUSY_SHARE` of a core or more since the last scan is
 * working, else idle (`scanStates`). Measured on a Mac over 20 minutes: a
 * Claude Code at its prompt used 0.3 to 2% of a core, one taking a turn 2
 * to 24% and mostly over 5%, its low stretches being the model's own
 * thinking, which spends no CPU here.
 */
import { existsSync } from "node:fs";
import { exec } from "./exec";
import { argvAgent } from "./keep";
import { lsofBin, parseLsofCwd, repoOfCwd } from "./ports";
import { linuxProcs, procCwd, procEnviron, type Proc } from "./procs";
import type { Harness, Repo, ScanBody, ScanProc } from "./types";

/** how often a backend scans its machine */
export const SCAN_EVERY = 30_000;

/** the share of one core an agent's process tree uses between two scans
 *  from which it reads as working */
export const BUSY_SHARE = 0.03;

/** one agent the scan found, before its folder is matched to a repo */
export interface AgentProc {
  pid: number;
  ppid: number;
  harness: Harness;
  /** "" when it could not be read (another user's process) */
  cwd: string;
  startedAt: number;
  /** the CPU time used so far by it and each process under it, in ms by
   *  pid, when the table had its own */
  tree?: ReadonlyMap<number, number>;
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

/** `ps -o time` as ms: a Mac's `M:SS.ss` (minutes past 59 and all) or
 *  procps's `[D-]HH:MM:SS`; null for anything else */
export function parseCpuTime(text: string): number | null {
  const m = /^(?:(\d+)-)?(\d+(?::\d+){0,2}(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  const secs = (m[2] ?? "").split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
  return Math.round((Number(m[1] ?? 0) * 86_400 + secs) * 1000);
}

/** `ps -axww -o pid=,ppid=,lstart=,time=,args=`: one process a line, the
 *  args split on spaces, which is enough for the program and script words
 *  the classifier reads */
export function parsePsLong(text: string): Proc[] {
  const out: Proc[] = [];
  const line = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(${LSTART.source})\\s+([\\d:.-]+)\\s*(.*)$`);
  for (const l of text.split("\n")) {
    const m = line.exec(l);
    if (!m) continue;
    const startedAt = parseLstart(m[3] ?? "");
    const cpuMs = parseCpuTime(m[11] ?? "");
    const args = m[12] ?? "";
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      argv: args.trim().split(/\s+/).filter(Boolean),
      ...(startedAt !== null ? { startedAt } : {}),
      ...(cpuMs !== null ? { cpuMs } : {}),
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
/** The harnesses' own helpers and one-off commands, which run the agent's
 *  binary but are no session: Claude Code's Chrome extension host, its
 *  background daemon with the daemon's pty hosts and warm spares, Codex's
 *  shared app server, and either CLI's `plugin` and `mcp` commands (the
 *  kit's plugin scan runs `codex plugin list` on every machine every 10
 *  minutes, and each one a scan met was a "codex pid N" card). The session a
 *  pty host runs is its child, the version file, and counts once the host is
 *  passed over; a Codex session counts by its TUI. */
const HELPER = new Set(["--chrome-native-host", "--bg-pty-host", "bg-pty-host", "--bg-spare", "bg-spare"]);
const HELPER_VERB = new Set(["daemon", "app-server", "plugin", "mcp"]);
/** the subcommand: the word after the program, or after the script when an
 *  interpreter runs one (the npm codex is `node …/codex app-server`) */
const verbOf = (argv: readonly string[]): string => argv[INTERPRETER.test(base(argv[0] ?? "").toLowerCase()) ? 2 : 1] ?? "";
const isHelper = (argv: readonly string[]): boolean => HELPER_VERB.has(verbOf(argv)) || argv.some((w) => HELPER.has(w));

/**
 * The harness a process is, or null. Measured, not assumed: Claude Code's
 * comm is `claude` on Linux, and on a Mac its executable is the version
 * file under `~/.local/share/claude/versions/`, so its comm reads as a
 * version string, taken as Claude only with `claude` in its path or argv
 * (or an argv that is its version too); a bun- or npm-installed Codex is
 * `node …/codex` (the script word only counts after an interpreter, so
 * `which codex` is no agent) over a native `codex` child. Claude's helper
 * processes (`isHelper`) are none.
 */
export function classify(comm: string, argv: readonly string[]): Harness | null {
  if (isHelper(argv)) return null;
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

/** What a process a test run started carries in its environment: `bun
 *  test` sets it, as jest and vitest do, and it passes down to every shell
 *  and stand-in agent the test starts. */
export const TEST_ENV = "NODE_ENV=test";

/** whether a process's environment, as `NAME=value` words, says a test
 *  started it */
export const underTest = (env: readonly string[]): boolean => env.includes(TEST_ENV);

/** `ps -Eww -o pid=,command=`: the pids a test started. A Mac's `ps` writes
 *  the environment after the args, as more words of the one line, so an arg
 *  that reads as `TEST_ENV` counts too. It shows none for another user's
 *  process or for one of the system's own binaries (`/bin/sh`, `perl`),
 *  which therefore never reads as a test's. */
export function psUnderTest(text: string): Set<number> {
  const out = new Set<number>();
  for (const l of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l);
    if (m && underTest((m[2] ?? "").split(/\s+/))) out.add(Number(m[1]));
  }
  return out;
}

/** The CPU time a process and each one under it has used, in ms by pid,
 *  or undefined when the table did not read the process's own. It stops at
 *  the harnesses' helpers (`isHelper`): a session that started the background
 *  daemon is its parent, and the sessions the daemon hosts count on their
 *  own, so the daemon's tree would make the first read as busy as all. */
export function treeCpu(procs: readonly Proc[], pid: number): Map<number, number> | undefined {
  const kids = new Map<number, Proc[]>();
  let self: Proc | undefined;
  for (const p of procs) {
    if (p.pid === pid) self = p;
    else {
      const list = kids.get(p.ppid);
      if (list) list.push(p);
      else kids.set(p.ppid, [p]);
    }
  }
  if (self?.cpuMs === undefined) return undefined;
  const tree = new Map<number, number>();
  const queue = [self];
  for (let p = queue.pop(); p; p = queue.pop()) {
    if (tree.has(p.pid)) continue;
    tree.set(p.pid, p.cpuMs ?? 0);
    for (const k of kids.get(p.pid) ?? []) if (!isHelper(k.argv)) queue.push(k);
  }
  return tree;
}

/** one agent's CPU reading at a scan, kept for the next */
export interface CpuSample {
  /** its tree's CPU time in ms by pid, as `treeCpu` read it */
  tree: ReadonlyMap<number, number>;
  at: number;
  /** the process's start, so a reused pid is not read as the same agent */
  startedAt: number;
}

/**
 * Each agent's state off two scans' CPU readings: working when its tree
 * used `BUSY_SHARE` of a core or more between them, idle otherwise, and
 * idle on its first scan; none without a reading, which the broker takes
 * as idle. The use is added up process by process: what each one in the
 * tree used since the last scan, all of it for one that is new since. A
 * process that ended takes its time with it, which a plain sum of the tree
 * would read as the agent giving CPU back, and a tool that started and
 * ended between scans is missed. Returns the samples to keep for the next
 * call.
 */
export function scanStates(
  prev: ReadonlyMap<number, CpuSample>,
  procs: readonly AgentProc[],
  now: number,
): { states: Map<number, "working" | "idle">; next: Map<number, CpuSample> } {
  const states = new Map<number, "working" | "idle">();
  const next = new Map<number, CpuSample>();
  for (const p of procs) {
    if (p.tree === undefined) continue;
    next.set(p.pid, { tree: p.tree, at: now, startedAt: p.startedAt });
    const before = prev.get(p.pid);
    const span = before && before.startedAt === p.startedAt ? now - before.at : 0;
    let used = 0;
    if (before && span > 0) for (const [pid, ms] of p.tree) used += Math.max(0, ms - (before.tree.get(pid) ?? 0));
    states.set(p.pid, span > 0 && used / span >= BUSY_SHARE ? "working" : "idle");
  }
  return { states, next };
}

/** What the broker's scan route takes: each agent with its repo (the
 *  remote as a web url, the key cards join repo cards on) and branch when
 *  its folder is inside a scanned repo on this machine, the deepest one
 *  when repos nest, and its state when `states` has one. */
export function scanBody(
  procs: readonly AgentProc[],
  repos: readonly Repo[],
  container: boolean,
  os: string,
  states: ReadonlyMap<number, "working" | "idle"> = new Map(),
): ScanBody {
  const local = repos.filter((r) => !r.host && !r.forge);
  return {
    container,
    os,
    procs: procs.map((p): ScanProc => {
      const id = repoOfCwd(p.cwd || undefined, local);
      const repo = id === undefined ? undefined : local.find((r) => r.id === id);
      const branch = repo?.status?.branch;
      const state = states.get(p.pid);
      return {
        pid: p.pid,
        harness: p.harness,
        cwd: p.cwd,
        startedAt: p.startedAt,
        ...(repo?.link ? { repo: repo.link } : {}),
        ...(branch ? { branch } : {}),
        ...(state ? { state } : {}),
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

/** every process a Mac's `ps` shows, with its start, CPU time and comm */
export async function macProcs(): Promise<Proc[]> {
  const env = { LC_ALL: "C", LANG: "C" };
  const [long, comm] = await Promise.all([
    exec(["ps", "-axww", "-o", "pid=,ppid=,lstart=,time=,args="], { timeoutMs: 5_000, env }),
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
  const r = await exec([lsofBin(), "-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], { timeoutMs: 2_000 });
  return parseLsofCwd(whole(r.stdout));
}

/** which of `pids` a test started, on a Mac. Only the pids come back: the
 *  environments `ps` printed, tokens and all, are read here and dropped. */
async function macUnderTest(pids: number[]): Promise<Set<number>> {
  if (pids.length === 0) return new Set();
  const r = await exec(["ps", "-Eww", "-o", "pid=,command=", "-p", pids.join(",")], { timeoutMs: 2_000, env: { LC_ALL: "C", LANG: "C" } });
  return psUnderTest(whole(r.stdout));
}

/** Every agent on this machine but the ones a test started, best effort:
 *  an unreadable table is none, and an agent whose environment cannot be
 *  read counts. */
export async function scanProcs(platform: NodeJS.Platform = process.platform): Promise<AgentProc[]> {
  const now = Date.now();
  const agent = (table: readonly Proc[], p: Proc & { harness: Harness }, cwd: string): AgentProc => {
    const tree = treeCpu(table, p.pid);
    return { pid: p.pid, ppid: p.ppid, harness: p.harness, cwd, startedAt: p.startedAt ?? now, ...(tree ? { tree } : {}) };
  };
  if (platform === "linux") {
    const table = await linuxProcs();
    const read = await Promise.all(
      pickAgents(table).map(async (p) => {
        const [cwd, env] = await Promise.all([procCwd(p.pid), procEnviron(p.pid)]);
        return underTest(env) ? null : agent(table, p, cwd ?? "");
      }),
    );
    return read.filter((p): p is AgentProc => p !== null);
  }
  if (platform === "darwin") {
    const table = await macProcs().catch(() => []);
    const hits = pickAgents(table);
    const pids = hits.map((p) => p.pid);
    const [cwds, tested] = await Promise.all([
      macCwds(pids).catch(() => new Map<number, string>()),
      macUnderTest(pids).catch(() => new Set<number>()),
    ]);
    return hits.filter((p) => !tested.has(p.pid)).map((p) => agent(table, p, cwds.get(p.pid) ?? ""));
  }
  return [];
}

/**
 * What listens on the backend's loopback, for the preview section: every
 * TCP port in LISTEN on a loopback or wildcard address (one bound to some
 * other address is not reachable through the proxy's loopback dial), the
 * process behind it and its working folder when the backend can see them.
 *
 * Linux reads `/proc/net/tcp{,6}` and walks `/proc/<pid>/fd` for the socket
 * inodes; macOS asks `lsof`. The parsers and `repoOfCwd` are pure and
 * tested; `listeningPorts` is fs and processes.
 */
import { readFile, readdir, readlink } from "node:fs/promises";

/** one listening socket as it is read, before the ports are merged */
export interface Listener {
  port: number;
  /** which loopback reaches it */
  family: 4 | 6;
  inode?: string;
  pid?: number;
  command?: string;
  cwd?: string;
}

/** a port the proxy can dial, with the address that reaches it */
export interface Listening {
  port: number;
  /** `127.0.0.1` or `[::1]` */
  host: string;
  pid?: number;
  command?: string;
  cwd?: string;
}

const V4_LOOPBACK = /^[0-9A-F]{6}7F$/i; // 127.x.x.x, little-endian: the first octet is last
const V4_ANY = "00000000";
const V6_ANY = "0".repeat(32);
const V6_LOOPBACK = "00000000000000000000000001000000";
// ::ffff:127.x.x.x and ::ffff:0.0.0.0, the v4-mapped forms
const V6_MAPPED = /^0000000000000000FFFF0000([0-9A-F]{6}7F|00000000)$/i;

/**
 * The LISTEN rows of a `/proc/net/tcp` or `/proc/net/tcp6` file that the
 * loopback reaches. Addresses are hex, each 32-bit word little-endian, and
 * the state column is `0A` for LISTEN.
 */
export function parseProcNet(text: string, family: 4 | 6): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue;
    const [addr, portHex] = (f[1] ?? "").split(":");
    if (!addr || !portHex) continue;
    const reachable =
      family === 4
        ? addr === V4_ANY || V4_LOOPBACK.test(addr)
        : addr === V6_ANY || addr === V6_LOOPBACK || V6_MAPPED.test(addr);
    if (!reachable) continue;
    const port = parseInt(portHex, 16);
    if (!Number.isInteger(port) || port <= 0) continue;
    out.push({ port, family, inode: f[9] });
  }
  return out;
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` output: a `p<pid>` line opens a
 * process, `c<name>` names it, and each `n<addr>:<port>` is one of its
 * listening sockets. Only loopback and wildcard addresses are kept.
 */
export function parseLsofListen(text: string): Listener[] {
  const out: Listener[] = [];
  let pid: number | undefined;
  let command: string | undefined;
  for (const line of text.split("\n")) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") {
      pid = Number(val);
      command = undefined;
    } else if (tag === "c") {
      command = val;
    } else if (tag === "n") {
      const m = /^(.*):(\d+)$/.exec(val);
      if (!m) continue;
      const addr = m[1] ?? "";
      const port = Number(m[2]);
      let family: 4 | 6;
      if (addr === "*" || addr === "127.0.0.1" || addr.startsWith("127.") || addr === "localhost") family = 4;
      else if (addr === "[::1]" || addr === "[::]") family = 6;
      else continue;
      out.push({ port, family, pid, command });
    }
  }
  return out;
}

/** `lsof -a -d cwd -p <pids> -Fpn` output: each process's working folder by pid */
export function parseLsofCwd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined) out.set(pid, line.slice(1));
  }
  return out;
}

/** One entry per port, v4 ahead of v6 (a dual-stack server answers either,
 *  and a v4 dial is what most dev servers expect), the first process known
 *  for it winning, sorted by port. */
export function mergeListeners(ls: Listener[]): Listening[] {
  const by = new Map<number, Listening>();
  const sorted = [...ls].sort((a, b) => a.family - b.family);
  for (const l of sorted) {
    const have = by.get(l.port);
    if (!have) {
      by.set(l.port, {
        port: l.port,
        host: l.family === 4 ? "127.0.0.1" : "[::1]",
        ...(l.pid !== undefined ? { pid: l.pid } : {}),
        ...(l.command ? { command: l.command } : {}),
        ...(l.cwd ? { cwd: l.cwd } : {}),
      });
    } else {
      if (have.pid === undefined && l.pid !== undefined) have.pid = l.pid;
      if (!have.command && l.command) have.command = l.command;
      if (!have.cwd && l.cwd) have.cwd = l.cwd;
    }
  }
  return [...by.values()].sort((a, b) => a.port - b.port);
}

/** the id of the repo whose folder holds `cwd`, the deepest one when repos
 *  nest (a submodule's server belongs to the submodule) */
export function repoOfCwd(cwd: string | undefined, repos: { id: string; path: string }[]): string | undefined {
  if (!cwd) return undefined;
  let best: { id: string; len: number } | undefined;
  for (const r of repos) {
    const p = r.path.replace(/\/+$/, "");
    if (cwd === p || cwd.startsWith(`${p}/`)) {
      if (!best || p.length > best.len) best = { id: r.id, len: p.length };
    }
  }
  return best?.id;
}

async function procListeners(): Promise<Listener[]> {
  const ls: Listener[] = [];
  for (const [file, family] of [["/proc/net/tcp", 4], ["/proc/net/tcp6", 6]] as const) {
    try {
      ls.push(...parseProcNet(await readFile(file, "utf8"), family));
    } catch {
      // no v6 in this kernel, or no /proc: nothing from this file
    }
  }
  if (ls.length === 0) return ls;
  // Which process holds each socket: walk every fd this user can read.
  // Another user's processes are skipped, and their ports still list.
  const want = new Map(ls.filter((l) => l.inode && l.inode !== "0").map((l) => [`socket:[${l.inode}]`, l]));
  let pids: string[] = [];
  try {
    pids = (await readdir("/proc")).filter((d) => /^\d+$/.test(d));
  } catch {
    return ls;
  }
  await Promise.all(
    pids.map(async (pid) => {
      let fds: string[];
      try {
        fds = await readdir(`/proc/${pid}/fd`);
      } catch {
        return;
      }
      const mine: Listener[] = [];
      for (const fd of fds) {
        try {
          const l = want.get(await readlink(`/proc/${pid}/fd/${fd}`));
          if (l) mine.push(l);
        } catch {
          // closed while we looked
        }
      }
      if (mine.length === 0) return;
      const [cwd, comm] = await Promise.all([
        readlink(`/proc/${pid}/cwd`).catch(() => undefined),
        readFile(`/proc/${pid}/comm`, "utf8").then((s) => s.trim()).catch(() => undefined),
      ]);
      for (const l of mine) {
        l.pid = Number(pid);
        if (comm) l.command = comm;
        if (cwd) l.cwd = cwd;
      }
    }),
  );
  return ls;
}

async function lsofListeners(): Promise<Listener[]> {
  const run = async (args: string[]) => {
    const p = Bun.spawn(["lsof", ...args], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(p.stdout).text();
    await p.exited;
    return text;
  };
  let ls: Listener[];
  try {
    ls = parseLsofListen(await run(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]));
  } catch {
    return [];
  }
  const pids = [...new Set(ls.map((l) => l.pid).filter((p): p is number => p !== undefined))];
  if (pids.length > 0) {
    try {
      const cwds = parseLsofCwd(await run(["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"]));
      for (const l of ls) if (l.pid !== undefined) l.cwd = cwds.get(l.pid);
    } catch {
      // the ports list without their folders
    }
  }
  return ls;
}

/** every port the backend's loopback reaches, with its process where visible */
export async function listeningPorts(): Promise<Listening[]> {
  return mergeListeners(process.platform === "linux" ? await procListeners() : await lsofListeners());
}

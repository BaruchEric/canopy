import { mkdirSync } from "node:fs";
import { parseLocator, remoteCommand, sshArgs } from "./host";
import { configDir } from "./store";
import { SEED_BUSY, SEED_GIT_FLAGS, seedBusy, seedGitRefusal, seedRootsNow, seedsRootOf } from "./seedgit";
import { SEED_GIT_ENV } from "./stagewire";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** variables laid over the server's own environment */
  env?: Record<string, string>;
  /** the environment `env` is laid over, in place of the server's live one */
  base?: Readonly<Record<string, string | undefined>>;
}

/** How long a timed-out command gets after SIGTERM before SIGKILL, and
 *  after that before its pipes stop being waited on. */
export const KILL_GRACE = 2_000;

/** A pipe read to the end, keeping what arrived if it is given up on. */
function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const done = (async () => {
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) return;
        chunks.push(value);
      }
    } catch {
      // cancelled or broken: what arrived before stands
    }
  })();
  return {
    done,
    text: () => Buffer.concat(chunks).toString("utf8"),
    cancel: () => void reader.cancel().catch(() => {}),
  };
}

/** whether `p` settles within `ms` */
async function settles(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** a signal to the command's whole process group, or to the command alone
 *  when the group is gone */
function signal(proc: { pid: number; kill: (sig?: NodeJS.Signals) => void }, sig: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid, sig);
  } catch {
    try {
      proc.kill(sig);
    } catch {
      // already gone
    }
  }
}

/** Run a command, capture output. Never throws — errors land in code/stderr.
 *
 *  With a timeout the command runs in a process group of its own and the
 *  timeout ends the whole group: killing only the command left whatever it
 *  started (git fetch's per-remote child, its transport helper, the test
 *  runner a check line ran) holding the pipes, and the call waiting on them
 *  for as long as those lived. A process that leaves the group and keeps a
 *  pipe (a daemon) is stopped being waited on after `KILL_GRACE`. */
export async function exec(
  cmd: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      // always the live env: a spawn without one gets the environment the
      // process started with, secrets canopy took out of it since included
      // (the answer token, which a tmux server started here would hand every
      // shell)
      env: { ...(opts.base ?? process.env), ...opts.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      detached: !!opts.timeoutMs,
    });
    const out = collect(proc.stdout);
    const err = collect(proc.stderr);
    const all = Promise.all([out.done, err.done, proc.exited]);
    if (opts.timeoutMs && !(await settles(all, opts.timeoutMs))) {
      signal(proc, "SIGTERM");
      if (!(await settles(all, KILL_GRACE))) {
        signal(proc, "SIGKILL");
        if (!(await settles(all, KILL_GRACE))) {
          out.cancel();
          err.cancel();
        }
      }
    }
    const [, , code] = await all;
    return { code, stdout: out.text(), stderr: err.text() };
  } catch (err) {
    return { code: 127, stdout: "", stderr: String(err) };
  }
}

/** Where ssh keeps its control sockets: the config dir, made once. */
let controlDir: string | null = null;
function sshControlDir(): string {
  if (controlDir === null) {
    controlDir = configDir();
    try {
      mkdirSync(controlDir, { recursive: true });
    } catch {
      // a missing dir only costs the shared connection; ssh still works
    }
  }
  return controlDir;
}

/** Run `cmd` where the target lives: here when `host` is null, else over
 *  ssh. Remote runs assume a POSIX shell and key-based login. */
export async function onHost(
  host: string | null,
  cmd: string[],
  opts: Omit<ExecOptions, "cwd"> = {},
): Promise<ExecResult> {
  if (host === null) return exec(cmd, opts);
  // The env is this machine's; a remote command sees the host's own.
  return exec([...sshArgs(host, sshControlDir()), remoteCommand(cmd)], { timeoutMs: opts.timeoutMs });
}

/** Where canopy's git in a seed runs instead of here: on an isolated
 *  backend, the stage runner (seedgit.ts, amendment 4). Both calls answer
 *  as git would, or with SEED_AWAY when the runner cannot run them now;
 *  neither ever runs git in this process. */
export interface SeedGitHook {
  /** the seeds this hook answers for (its own backend's); every seed when
   *  absent. A seed it does not cover runs here behind the guard. */
  covers?(path: string): boolean;
  run(path: string, args: string[], opts: { timeoutMs: number; env: Record<string, string> }): Promise<ExecResult>;
  /** stdout into `file`, for bytes (a bundle) */
  toFile(path: string, args: string[], file: string, opts: { timeoutMs: number; env: Record<string, string> }): Promise<ExecResult>;
}
let seedGitHook: SeedGitHook | null = null;
/** set by the server on an isolated backend, cleared on one that is not */
export function setSeedGit(hook: SeedGitHook | null): void {
  seedGitHook = hook;
}
const hookCovers = (hook: SeedGitHook, path: string): boolean => hook.covers?.(path) ?? true;

/** a refusal for an env the stage runner would refuse: a name dropped
 *  would change what the command writes, so it never goes */
function offGitEnv(env: Record<string, string>): ExecResult | null {
  const off = Object.keys(env).find((k) => !SEED_GIT_ENV.includes(k));
  return off === undefined ? null : { code: 128, stdout: "", stderr: `canopy runs git in a seed with ${SEED_GIT_ENV.join(", ")} alone, not ${off}` };
}

/** git() in a local repo with stdout into `file` (a bundle: bytes, not
 *  text). A seed goes where git() sends it: the stage runner on an isolated
 *  backend, else here behind the guard, with the same busy rule. */
export async function gitToFile(path: string, args: string[], file: string, timeoutMs = 300_000): Promise<ExecResult> {
  const seeds = seedsRootOf(path, seedRootsNow());
  if (seeds !== null && seedBusy(path)) return { code: 128, stdout: "", stderr: SEED_BUSY };
  const refused = await seedGitRefusal(path);
  if (refused) return { code: 128, stdout: "", stderr: refused };
  const env = { GIT_OPTIONAL_LOCKS: "0" };
  if (seeds !== null && seedGitHook && hookCovers(seedGitHook, path)) return seedGitHook.toFile(path, args, file, { timeoutMs, env });
  const seedOnly = seeds !== null ? { flags: SEED_GIT_FLAGS, env: { GIT_CEILING_DIRECTORIES: seeds } } : { flags: [], env: {} };
  const p = Bun.spawn(["git", ...seedOnly.flags, "-C", path, ...args], {
    env: { ...process.env, ...env, ...seedOnly.env },
    stdin: "ignore",
    stdout: Bun.file(file),
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, stdout: "", stderr };
}

/** git in a repo, wherever the repo's locator says it is.
 *
 *  `GIT_OPTIONAL_LOCKS=0`: canopy reads while the user works, and a status
 *  that refreshes the index holds index.lock while it does, so the user's
 *  own `git add` or commit landing in that moment failed. Commands that
 *  change the index still take the lock; only the opportunistic write goes.
 *  (The variable does not travel over ssh; a remote repo is read as before.) */
export async function git(
  repoPath: string,
  args: string[],
  timeoutMs = 30_000,
  env?: Record<string, string>,
): Promise<ExecResult> {
  const { host, path } = parseLocator(repoPath);
  const opts = { timeoutMs, env: { GIT_OPTIONAL_LOCKS: "0", ...env } };
  if (host === null) {
    // A seed is written by agents: see seedgit.ts.
    const seeds = seedsRootOf(path, seedRootsNow());
    if (seeds !== null && seedBusy(path)) return { code: 128, stdout: "", stderr: SEED_BUSY };
    const refused = await seedGitRefusal(path);
    if (refused) return { code: 128, stdout: "", stderr: refused };
    if (seeds !== null && seedGitHook && hookCovers(seedGitHook, path)) {
      const off = offGitEnv(opts.env);
      return off ?? seedGitHook.run(path, args, opts);
    }
    if (seeds !== null) {
      return onHost(host, ["git", ...SEED_GIT_FLAGS, "-C", path, ...args], { ...opts, env: { ...opts.env, GIT_CEILING_DIRECTORIES: seeds } });
    }
  }
  return onHost(host, ["git", "-C", path, ...args], opts);
}

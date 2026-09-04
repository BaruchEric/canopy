import { mkdirSync } from "node:fs";
import { parseLocator, remoteCommand, sshArgs } from "./host";
import { configDir } from "./store";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command, capture output. Never throws — errors land in code/stderr. */
export async function exec(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => proc.kill(), opts.timeoutMs);
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timer) clearTimeout(timer);
    return { code, stdout, stderr };
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
  opts: { timeoutMs?: number } = {},
): Promise<ExecResult> {
  if (host === null) return exec(cmd, opts);
  return exec([...sshArgs(host, sshControlDir()), remoteCommand(cmd)], opts);
}

/** git in a repo, wherever the repo's locator says it is. */
export async function git(
  repoPath: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<ExecResult> {
  const { host, path } = parseLocator(repoPath);
  return onHost(host, ["git", "-C", path, ...args], { timeoutMs });
}

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

export async function git(
  repoPath: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<ExecResult> {
  return exec(["git", "-C", repoPath, ...args], { timeoutMs });
}

/**
 * A workflow step's check, in the repo, through a login shell so the user's
 * PATH (bun, cargo) applies; over ssh for a remote repo. A stage's check
 * through the stage runner is a plain `sh -c`: its login files sit in the
 * stages container's home, which every stage can write. Bun-only.
 */
import { checkEnv } from "./cli";
import { gateEnv, stageEnv } from "./envnames";
import { exec, firstLine, git, onHost, type ExecResult } from "./exec";
import type { CheckResult } from "./flow";
import { GATES_FILE, gatesScript, packageGates, parseGatesFile, type Gate, type Gates } from "./gates";
import { parseLocator, shellQuote } from "./host";
import { SCENARIO_DIR_VAR } from "./scenario";
import type { StageClient } from "./stageclient";
import { STAGE_AWAY } from "./stagewire";
import type { Repo } from "./types";

/** stdout and stderr of a check, tail-capped for the sheet */
const CHECK_OUTPUT_CAP = 4000;
const CHECK_TIMEOUT = 10 * 60_000;

/** A line run here, under a plain `sh` that waits for it. The timeout's
 *  spawn starts a session of its own, and `sh -lc` execs a lone command, so
 *  without the outer shell the command would lead that session and take the
 *  first pty it opens as its controlling terminal, then be hung up when the
 *  pty closes. Canopy's own suite as a gate died that way at its shell
 *  tests (exit 129, 2026-10-16). */
const ledLine = (command: string): string[] => ["sh", "-c", 'sh -lc "$1"; exit $?', "sh", command];

/** `stage` is an incubator seed's check, which starts without canopy's
 *  GitHub login and the rest `stageEnv` drops, like the stage's runs.
 *  `client` is the stage runner's: a stage check with one runs in the stages
 *  container, with the runner's env and none of canopy's; null means the
 *  runner is away or not set up, and the check says `away` (the runner's
 *  absence, or the env to set) as a shell says a command is missing, with
 *  `away` set so the flow waits rather than counting a failed check.
 *  Undefined runs it here, as an unisolated backend does. */
export async function runCheck(
  repo: Pick<Repo, "path">,
  command: string,
  stage = false,
  client?: StageClient | null,
  away: string = STAGE_AWAY,
  /** a stopped flow's: kills the check and what it started */
  signal?: AbortSignal,
): Promise<CheckResult> {
  const sig = signal ? { signal } : {};
  const { host, path } = parseLocator(repo.path);
  if (stage && client === null) return { exit: 127, output: away, away: true };
  const r: ExecResult & { unfenced?: string } =
    stage && client
      ? await client.exec(["sh", "-c", command], { cwd: path, timeoutMs: CHECK_TIMEOUT, ...sig })
      : host === null
        ? await exec(ledLine(command), {
            cwd: path,
            timeoutMs: CHECK_TIMEOUT,
            env: checkEnv(),
            ...(stage ? { base: stageEnv(process.env) } : {}),
            ...sig,
          })
        : await onHost(host, ["sh", "-lc", `cd ${shellQuote(path)} && ${command}`], { timeoutMs: CHECK_TIMEOUT, ...sig });
  // the runner refused it for its fence, by the refusal's own field: the
  // check waits for the fence, as it waits for a runner away
  if (stage && client && r.unfenced !== undefined) return { exit: r.code, output: r.unfenced, away: true };
  const output = capped(r);
  // A connection that failed reads as 127 with the runner's words, which a
  // command could print as well: away only when a hello finds no runner.
  if (stage && client && r.code === 127 && r.stderr.startsWith(STAGE_AWAY) && (await client.hello().catch(() => null)) === null) {
    return { exit: r.code, output: STAGE_AWAY, away: true };
  }
  return { exit: r.code, output };
}

/** The gates `@gates` runs, or why they cannot be read.
 *  `.canopy/gates.json` is read as HEAD holds it, so the step before the
 *  check cannot loosen the gates by editing the file; the package.json
 *  scripts are read from the working tree, since that step may be what adds
 *  them, and a script's body runs from the tree either way. `setup` is left
 *  out: the checkout a workflow runs in is the one already installed. Read
 *  through git and `cat`, so a remote repo's come from its host. */
export async function checkGates(repoPath: string): Promise<{ gates: Gate[]; source: Gates["source"]; note: string } | CheckResult> {
  const { host, path } = parseLocator(repoPath);
  const file = await git(repoPath, ["show", `HEAD:${GATES_FILE}`]);
  if (file.code === 0) {
    const parsed = parseGatesFile(file.stdout);
    if ("error" in parsed) return { exit: 1, output: parsed.error };
    return { gates: parsed.gates, source: "file", note: "" };
  }
  if (!/does not exist|exists on disk|invalid object name|bad revision|unknown revision/i.test(file.stderr)) {
    return { exit: 1, output: `could not read ${GATES_FILE}: ${firstLine(file.stderr) || `git exit ${file.code}`}` };
  }
  const note = /exists on disk/i.test(file.stderr) ? `${GATES_FILE} is not committed, so it does not count yet` : "";
  const pkg = await onHost(host, ["cat", `${path}/package.json`]);
  if (pkg.code !== 0 && !/no such file/i.test(pkg.stderr)) {
    return { exit: 1, output: `could not read package.json: ${firstLine(pkg.stderr) || `exit ${pkg.code}`}` };
  }
  const gates = pkg.code === 0 ? packageGates(pkg.stdout) : [];
  return { gates, source: gates.length > 0 ? "package" : "none", note };
}

/** `@gates` as the shell script to run in its place, or why it cannot run. */
export async function gatesCheck(repoPath: string): Promise<string | CheckResult> {
  const read = await checkGates(repoPath);
  return "gates" in read ? gatesScript(read.gates, read.source, read.note) : read;
}

/** The permission rules that let a step checked by `@gates` run each gate's
 *  line without asking: the same list its check runs, so an agent told to
 *  run the gates can, whatever tool a repo's gates use. Nothing when the
 *  gates cannot be read; the check says why. */
export async function gateTools(repoPath: string): Promise<string[]> {
  const read = await checkGates(repoPath);
  return "gates" in read ? read.gates.map((g) => `Bash(${g.run})`) : [];
}

/** A landing gate, or the setup a branch run starts with: the repo's own
 *  line in a worktree on this machine, under `gateEnv` and none of the
 *  check variables, so what an agent wrote runs with no login of canopy's
 *  and no reach into the server's config dir, tmux server or sockets. */
export async function runGate(dir: string, command: string): Promise<CheckResult> {
  const r = await exec(ledLine(command), { cwd: dir, timeoutMs: CHECK_TIMEOUT, base: gateEnv(process.env) });
  return { exit: r.code, output: capped(r) };
}

/** A scenario's line in a branch run's worktree: `runGate`'s environment
 *  with `SCENARIO_DIR` laid over it, pointing at the set's temp copy, under
 *  the set's own timeout. */
export async function runScenario(dir: string, command: string, setDir: string, timeoutMs: number): Promise<CheckResult> {
  const r = await exec(ledLine(command), {
    cwd: dir,
    timeoutMs,
    base: gateEnv(process.env),
    env: { [SCENARIO_DIR_VAR]: setDir },
  });
  return { exit: r.code, output: capped(r) };
}

function capped(r: ExecResult): string {
  const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
  return out.length > CHECK_OUTPUT_CAP ? `…${out.slice(-CHECK_OUTPUT_CAP)}` : out;
}

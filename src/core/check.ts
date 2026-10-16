/**
 * A workflow step's check, in the repo, through a login shell so the user's
 * PATH (bun, cargo) applies; over ssh for a remote repo. A stage's check
 * through the stage runner is a plain `sh -c`: its login files sit in the
 * stages container's home, which every stage can write. Bun-only.
 */
import { checkEnv } from "./cli";
import { gateEnv, stageEnv } from "./envnames";
import { exec, onHost, type ExecResult } from "./exec";
import type { CheckResult } from "./flow";
import { parseLocator, shellQuote } from "./host";
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
): Promise<CheckResult> {
  const { host, path } = parseLocator(repo.path);
  if (stage && client === null) return { exit: 127, output: away, away: true };
  const r: ExecResult & { unfenced?: string } =
    stage && client
      ? await client.exec(["sh", "-c", command], { cwd: path, timeoutMs: CHECK_TIMEOUT })
      : host === null
        ? await exec(ledLine(command), {
            cwd: path,
            timeoutMs: CHECK_TIMEOUT,
            env: checkEnv(),
            ...(stage ? { base: stageEnv(process.env) } : {}),
          })
        : await onHost(host, ["sh", "-lc", `cd ${shellQuote(path)} && ${command}`], { timeoutMs: CHECK_TIMEOUT });
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

/** A landing gate, or the setup a branch run starts with: the repo's own
 *  line in a worktree on this machine, under `gateEnv` and none of the
 *  check variables, so what an agent wrote runs with no login of canopy's
 *  and no reach into the server's config dir, tmux server or sockets. */
export async function runGate(dir: string, command: string): Promise<CheckResult> {
  const r = await exec(ledLine(command), { cwd: dir, timeoutMs: CHECK_TIMEOUT, base: gateEnv(process.env) });
  return { exit: r.code, output: capped(r) };
}

function capped(r: ExecResult): string {
  const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
  return out.length > CHECK_OUTPUT_CAP ? `…${out.slice(-CHECK_OUTPUT_CAP)}` : out;
}

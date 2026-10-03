/**
 * A workflow step's check, in the repo, through a login shell so the user's
 * PATH (bun, cargo) applies; over ssh for a remote repo. A stage's check
 * through the stage runner is a plain `sh -c`: its login files sit in the
 * stages container's home, which every stage can write. Bun-only.
 */
import { checkEnv } from "./cli";
import { stageEnv } from "./envnames";
import { exec, onHost, type ExecResult } from "./exec";
import type { CheckResult } from "./flow";
import { parseLocator, shellQuote } from "./host";
import type { StageClient } from "./stageclient";
import { STAGE_AWAY } from "./stagewire";
import type { Repo } from "./types";

/** stdout and stderr of a check, tail-capped for the sheet */
const CHECK_OUTPUT_CAP = 4000;
const CHECK_TIMEOUT = 10 * 60_000;

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
        ? await exec(["sh", "-lc", command], {
            cwd: path,
            timeoutMs: CHECK_TIMEOUT,
            env: checkEnv(),
            ...(stage ? { base: stageEnv(process.env) } : {}),
          })
        : await onHost(host, ["sh", "-lc", `cd ${shellQuote(path)} && ${command}`], { timeoutMs: CHECK_TIMEOUT });
  // the runner refused it for its fence, by the refusal's own field: the
  // check waits for the fence, as it waits for a runner away
  if (stage && client && r.unfenced !== undefined) return { exit: r.code, output: r.unfenced, away: true };
  const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
  const output = out.length > CHECK_OUTPUT_CAP ? `…${out.slice(-CHECK_OUTPUT_CAP)}` : out;
  // A connection that failed reads as 127 with the runner's words, which a
  // command could print as well: away only when a hello finds no runner.
  if (stage && client && r.code === 127 && r.stderr.startsWith(STAGE_AWAY) && (await client.hello().catch(() => null)) === null) {
    return { exit: r.code, output: STAGE_AWAY, away: true };
  }
  return { exit: r.code, output };
}

/**
 * A workflow step's check, in the repo, through a login shell so the user's
 * PATH (bun, cargo) applies; over ssh for a remote repo. Bun-only.
 */
import { checkEnv } from "./cli";
import { stageEnv } from "./envnames";
import { exec, onHost } from "./exec";
import type { CheckResult } from "./flow";
import { parseLocator, shellQuote } from "./host";
import type { Repo } from "./types";

/** stdout and stderr of a check, tail-capped for the sheet */
const CHECK_OUTPUT_CAP = 4000;
const CHECK_TIMEOUT = 10 * 60_000;

/** `stage` is an incubator seed's check, which starts without canopy's
 *  GitHub login and the rest `stageEnv` drops, like the stage's runs. */
export async function runCheck(repo: Pick<Repo, "path">, command: string, stage = false): Promise<CheckResult> {
  const { host, path } = parseLocator(repo.path);
  const r =
    host === null
      ? await exec(["sh", "-lc", command], {
          cwd: path,
          timeoutMs: CHECK_TIMEOUT,
          env: checkEnv(),
          ...(stage ? { base: stageEnv(process.env) } : {}),
        })
      : await onHost(host, ["sh", "-lc", `cd ${shellQuote(path)} && ${command}`], { timeoutMs: CHECK_TIMEOUT });
  const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
  return { exit: r.code, output: out.length > CHECK_OUTPUT_CAP ? `…${out.slice(-CHECK_OUTPUT_CAP)}` : out };
}

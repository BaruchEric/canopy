/**
 * The secrets service's way to the host's compose projects (phase 3 spec,
 * part A1): ssh with the canopy-restart key, whose forced command is
 * scripts/canopy-restart. The request travels as the ssh command line,
 * which the forced command reads from SSH_ORIGINAL_COMMAND; the host never
 * runs it. Only the script's tab lines come back, and only their fields
 * are kept.
 */

import { exec, firstLine, type ExecResult } from "../core/exec";
import { PROJECT } from "../core/secretfile";
import type { SecretContainer, SecretStack } from "../core/types";

export interface StackRunner {
  list(): Promise<{ stacks: SecretStack[] } | { error: string }>;
  restart(project: string): Promise<{ code: number; containers: SecretContainer[] } | { error: string }>;
}

export interface SshStackOptions {
  /** the folder restart-setup.sh fills: key and known_hosts */
  dir: string;
  host: string;
  user: string;
  run?: (argv: string[], timeoutMs: number) => Promise<ExecResult>;
}

/** compose's up plus the 60 s wait the script allows, and some room */
const RESTART_TIMEOUT = 150_000;
const LIST_TIMEOUT = 20_000;
const FIELD = /^[^\t\n]{0,200}$/;

export function parseStacks(stdout: string): SecretStack[] {
  return stdout
    .split("\n")
    .flatMap((line) => {
      const [name, files, ...rest] = line.split("\t");
      if (rest.length > 0 || !name || !PROJECT.test(name) || !files) return [];
      const list = files.split(",");
      return list.every((f) => f.startsWith("/") && f.length <= 512) ? [{ name, files: list }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function parseContainers(stdout: string): SecretContainer[] {
  return stdout.split("\n").flatMap((line) => {
    if (line === "") return [];
    const [service = "", state = "", health = "", ...rest] = line.split("\t");
    if (rest.length > 0 || service === "" || ![service, state, health].every((x) => FIELD.test(x))) return [];
    return [{ service, state, health }];
  });
}

export function sshStacks(o: SshStackOptions): StackRunner {
  const run = o.run ?? ((argv, timeoutMs) => exec(argv, { timeoutMs }));
  const ssh = (request: string, timeoutMs: number) =>
    run(
      [
        "ssh", "-i", `${o.dir}/key`,
        "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "LogLevel=ERROR",
        "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${o.dir}/known_hosts`,
        "-o", "ControlMaster=no", "-o", "ConnectTimeout=10",
        `${o.user}@${o.host}`, request,
      ],
      timeoutMs,
    );
  return {
    async list() {
      const r = await ssh("list", LIST_TIMEOUT);
      if (r.code !== 0) return { error: `the host did not list its stacks: ${firstLine(r.stderr) || `exit ${r.code}`}` };
      return { stacks: parseStacks(r.stdout) };
    },
    async restart(project) {
      if (!PROJECT.test(project)) return { error: `${project} is not a project name` };
      const r = await ssh(`restart ${project}`, RESTART_TIMEOUT);
      // 255 is ssh's own failure; anything else is the script's or compose's
      if (r.code === 255 || (r.code === 2 && r.stdout === "")) return { error: firstLine(r.stderr) || `ssh exited ${r.code}` };
      return { code: r.code, containers: parseContainers(r.stdout) };
    },
  };
}

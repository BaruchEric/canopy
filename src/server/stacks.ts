/**
 * Ending a worktree's compose stack (FR-039 plan 3). The checks come first
 * because `down -v` deletes volumes: the project's name is worked out from
 * the folder, a project whose files sit elsewhere is refused, and a project
 * holding a volume a compose file named outright keeps its volumes, since
 * another stack may share them (P3). Everything goes through `ComposeExec`:
 * the real one is built only in server/index.ts, and tests use a fake.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { COMPOSE_DOWN_MS, composeDownArgs, composeLsArgs, configInside, foreignVolumes, parseComposeLs, projectName, volumeLsArgs, type ComposeRoots } from "../core/compose";
import { exec } from "../core/exec";
import { repoKey } from "../core/worktree";

export interface ComposeExec {
  run(args: string[], opts: { cwd: string; timeoutMs: number }): Promise<{ code: number; out: string }>;
}

const READ_MS = 15_000;

/** the lines of a teardown that left a stack up */
export const notDown = (line: string): boolean => /^(refused|could not read compose|compose down failed)/.test(line);

/** The teardown of the stack in `dir`, as lines for the run's sheet. It
 *  never throws: a stack left up is reported with the command to finish it,
 *  and the worktree still goes. `folders` are the names `dir` goes by. */
export async function tearDown(c: ComposeExec, dir: string, roots: ComposeRoots, opts: { volumes: boolean; folders: readonly string[] }): Promise<string[]> {
  const name = projectName(dir, roots);
  if (name === null) return [`refused to take down a stack in ${dir}: canopy did not make that folder`];
  const finish = `run: docker compose -p ${name} down`;
  // run from `/`: an unset variable in the worktree's file would fail the command (P3)
  const at = { cwd: "/", timeoutMs: READ_MS };
  try {
    const ls = await c.run(composeLsArgs(name), at);
    const project = ls.code === 0 ? parseComposeLs(ls.out, name) : "unreadable";
    if (project === "unreadable") return [`could not read compose project ${name}, so it may still be up; ${finish}`];
    if (project && !configInside(project.files, opts.folders)) {
      return [`refused to take down ${name}: its compose files are ${project.files.join(", ") || "unknown"}, not in ${dir}`];
    }
    const lines: string[] = [];
    let volumes = opts.volumes;
    if (volumes) {
      const vols = await c.run(volumeLsArgs(name), at);
      const fixed = vols.code === 0 ? foreignVolumes(vols.out, name) : null;
      if (fixed === null) lines.push(`could not read ${name}'s volumes, so they were kept`);
      else if (fixed.length) lines.push(`kept ${name}'s volumes, because ${fixed.join(", ")} has a fixed name another stack may share`);
      volumes = fixed !== null && fixed.length === 0;
    }
    const args = composeDownArgs(dir, roots, volumes);
    if (args === null) return [`refused to take down a stack in ${dir}: canopy did not make that folder`];
    const down = await c.run(args, { cwd: "/", timeoutMs: COMPOSE_DOWN_MS });
    if (down.code !== 0) return [...lines, `compose down failed for ${name}: ${down.out.trim().split("\n").at(-1) ?? ""}; ${finish}`];
    const said = volumes ? `removed compose stack ${name} and its volumes` : opts.volumes ? `removed compose stack ${name}` : `stopped compose stack ${name}`;
    return [said, ...lines];
  } catch (err) {
    return [`compose down failed for ${name}: ${err instanceof Error ? err.message : String(err)}; ${finish}`];
  }
}

/** Whether a repo is canopy itself: by its repo's name, its package name, or
 *  this server's own checkout. Its stack belongs to redeploy, on any machine
 *  and in any worktree of it. */
export async function isCanopyStack(repo: { name: string; path: string }, self: string): Promise<boolean> {
  const keys = [repoKey(self), basename(dirname(self))];
  if (repo.name.toLowerCase() === "canopy" || keys.includes(repoKey(repo.path)) || keys.includes(basename(dirname(repo.path)))) return true;
  try {
    return (JSON.parse(await readFile(join(repo.path, "package.json"), "utf8")) as { name?: unknown }).name === "canopy";
  } catch {
    return false;
  }
}

/** The real thing, for server/index.ts alone: docker from the PATH. */
export function realCompose(): ComposeExec & { missing(): Promise<string | null> } {
  return {
    run: async (args, opts) => {
      const r = await exec(["docker", ...args], { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
      return { code: r.code, out: `${r.stdout}${r.stderr}` };
    },
    missing: async () => {
      if (!Bun.which("docker")) return "docker is not installed on this backend";
      const r = await exec(["docker", "version", "--format", "{{.Server.Version}}"], { cwd: "/", timeoutMs: 5_000 }).catch(() => null);
      return r?.code === 0 ? null : "docker is not running on this backend";
    },
  };
}

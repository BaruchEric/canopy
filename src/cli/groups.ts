/** `canopy groups`: inspect best-of-N runs and choose their winner. */

import { basename } from "node:path";
import { groupWord, type RunGroup } from "../core/group";
import type { BackendEntry, LandingInfo } from "../core/types";
import { apiBase } from "./api";
import { ask, errText, take, targetsOf, Unreachable, type Target } from "./health";

export const GROUPS_USAGE =
  "usage: canopy groups [repo] [--backend URL] [--on NAME]\n       canopy groups pick <group> <run> [--backend URL] [--on NAME]";

interface BackendList {
  self?: string;
  backends?: BackendEntry[];
}

type Fail = (message: string) => never;

function requestFailure(target: Target, fail: Fail): (error: unknown) => never {
  return (error: unknown) => fail(error instanceof Unreachable ? `${target.name} did not answer: ${error.message}` : errText(error));
}

async function commandTargets(given: string | undefined, on: string | undefined, fail: Fail): Promise<Target[]> {
  const home = apiBase(given);
  if (!/^https?:\/\/[^/\s]+$/.test(home)) return fail(`--backend must be an http(s) origin, got ${home}`);
  if (given !== undefined && on !== undefined) return fail("use either --backend URL or --on NAME");
  const homeTarget: Target = { name: "home", urls: [home] };
  if (given !== undefined) return [homeTarget];

  const listed = await ask<BackendList>(homeTarget, "GET", "/api/backends").catch((error: unknown) => {
    if (on !== undefined) return requestFailure(homeTarget, fail)(error);
    return null;
  });
  const all = listed?.self ? targetsOf(home, listed.self, listed.backends ?? []) : [homeTarget];
  if (on === undefined) return all;
  const selected = all.find((target) => target.name === on);
  if (!selected) return fail(`no backend named ${on}; the home backend lists ${all.map((target) => target.name).join(", ")}`);
  return [selected];
}

function repoMatches(repo: string | undefined, group: RunGroup): boolean {
  if (repo === undefined) return true;
  const localId = group.repoId.split("|").at(-1) ?? group.repoId;
  const idName = localId.split(/[/:]/).at(-1) ?? localId;
  return repo === group.repoId || repo === group.repoPath || repo === basename(group.repoPath) || repo === idName;
}

/** One header per group and one line per member, using the live landing row
 * for its branch and state while the dry score is still pending. */
export function groupLines(info: Pick<LandingInfo, "groups" | "runs">, repo?: string, backend = ""): string[] {
  const where = backend ? ` on ${backend}` : "";
  const groups = (info.groups ?? []).filter((group) => repoMatches(repo, group));
  const out: string[] = [];
  for (const group of groups) {
    out.push(`${group.id}  ${groupWord(group)}  ${group.repoId}${where}`);
    for (const member of group.members) {
      const run = info.runs.find((candidate) => candidate.id === member.origin || candidate.runId === member.run);
      const score = group.scores?.[member.origin];
      const branch = run?.branch ?? score?.branch ?? member.origin;
      const state = run?.state ?? score?.state ?? "unknown";
      out.push(`  ${branch}  ${state}`);
    }
  }
  return out;
}

type GroupLookup = { target: Target; groups: RunGroup[] } | { target: Target; error: unknown };

async function pickGroup(
  groupId: string,
  run: string,
  targets: Target[],
  direct: boolean,
  fail: Fail,
): Promise<void> {
  let selected: Target | undefined;
  if (direct) {
    selected = targets[0];
  } else {
    const results: GroupLookup[] = await Promise.all(targets.map(async (target) => {
      try {
        return { target, groups: await ask<RunGroup[]>(target, "GET", "/api/groups") };
      } catch (error) {
        return { target, error };
      }
    }));
    const matches = results.flatMap((result) => "groups" in result
      ? result.groups.filter((group) => group.id === groupId).map(() => result.target)
      : []);
    if (matches.length > 1) {
      return fail(`${groupId} is on ${matches.map((target) => target.name).join(" and ")}; say which with --on NAME`);
    }
    selected = matches[0];
    if (!selected) {
      const errors = results.flatMap((result) => "error" in result
        ? [`${result.target.name}: ${errText(result.error)}`]
        : []);
      if (errors.length > 0) return fail(`could not find ${groupId}; ${errors.join("; ")}`);
      return fail(`no group ${groupId}; canopy groups lists them`);
    }
  }

  if (!selected) return fail(GROUPS_USAGE);
  await ask<RunGroup>(selected, "POST", "/api/groups/pick", { group: groupId, run })
    .catch(requestFailure(selected, fail));
  console.log(`picked ${run} in ${groupId}${direct ? "" : ` on ${selected.name}`}`);
}

export async function groupsCommand(argv: string[], { fail }: { fail: Fail }): Promise<void> {
  const args = [...argv];
  const backendFlag = args.includes("--backend");
  const given = take(args, "--backend");
  const onFlag = args.includes("--on");
  const on = take(args, "--on");
  if (backendFlag && given === undefined) return fail("--backend needs a value");
  if (onFlag && on === undefined) return fail("--on needs a value");
  const targets = await commandTargets(given, on, fail);

  if (args[0] === "pick") {
    args.shift();
    const group = args.shift();
    const run = args.shift();
    if (!group || !run || args.length > 0) return fail(GROUPS_USAGE);
    return pickGroup(group, run, targets, given !== undefined || on !== undefined, fail);
  }

  const repo = args.shift();
  if (args.length > 0) return fail(GROUPS_USAGE);
  let any = false;
  for (const target of targets) {
    try {
      const info = await ask<LandingInfo>(target, "GET", "/api/landing");
      const lines = groupLines(info, repo, targets.length > 1 ? target.name : "");
      for (const line of lines) console.log(line);
      any ||= lines.length > 0;
    } catch (error) {
      console.log(`${target.name}: ${error instanceof Unreachable ? `did not answer: ${error.message}` : errText(error)}`);
    }
  }
  if (!any) console.log(repo ? `no groups in ${repo}` : "no groups");
}

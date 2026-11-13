/** `canopy run`: start a branch or best-of-N run, or inspect its transcript. */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { groupWord, type RunGroup } from "../core/group";
import { parsePriority } from "../core/capacity";
import { RUN_ACTIONS, type BackendEntry, type Priority, type Run, type RunAction, type ScanResult } from "../core/types";
import { apiBase } from "./api";
import { ask, errText, has, Refused, take, targetsOf, Unreachable, type Target } from "./health";
import { RUN_USAGE, runTranscriptCommand } from "./run-transcripts";

export { RUN_USAGE };

export interface RunArgs {
  repo: string;
  action: Exclude<RunAction, "compare">;
  note: string;
  times: number;
  explicitTimes: boolean;
  autoLand: boolean;
  pr: boolean;
  /** one per member, null for the repo's job route; a short list repeats its last */
  profiles?: (string | null)[];
  /** 2 asks a second reviewer, who must agree on the winner */
  reviewers?: 2;
  /** who may go first when the plan's window runs low (FR-036); absent, the
   *  backend's default for the start */
  priority?: Priority;
  /** a named loadout from kit.json: the run's model, effort, skills and servers */
  loadout?: string;
  /** canopy's tools on or off for this start (FR-038); absent, the settings' */
  canopyTools?: boolean;
  backend?: string;
  on?: string;
}

const isAction = (value: string): value is Exclude<RunAction, "compare"> =>
  RUN_ACTIONS.some((action) => action === value);

/** Parse the group-start form without mutating the caller's arguments. */
export function parseRunArgs(argv: string[]): RunArgs | string {
  const args = [...argv];
  const backendFlag = args.includes("--backend");
  const backend = take(args, "--backend");
  const onFlag = args.includes("--on");
  const on = take(args, "--on");
  const noteFlag = args.includes("-m");
  const note = take(args, "-m");
  const timesFlag = args.includes("--times");
  const rawTimes = take(args, "--times");
  const profilesFlag = args.includes("--profiles");
  const rawProfiles = take(args, "--profiles");
  const loadoutFlag = args.includes("--loadout");
  const loadout = take(args, "--loadout");
  const reviewersFlag = args.includes("--reviewers");
  const rawReviewers = take(args, "--reviewers");
  const autoLand = has(args, "--auto-land");
  const pr = has(args, "--pr");
  const priorityFlag = args.includes("--priority");
  const rawPriority = take(args, "--priority");
  const toolsOn = has(args, "--tools");
  const toolsOff = has(args, "--no-tools");
  if (toolsOn && toolsOff) return "use either --tools or --no-tools";
  if (backendFlag && backend === undefined) return "--backend needs a value";
  if (onFlag && on === undefined) return "--on needs a value";
  if (noteFlag && note === undefined) return "-m needs a note";
  if (timesFlag && rawTimes === undefined) return "--times needs a value";
  if (profilesFlag && rawProfiles === undefined) return "--profiles needs a list of names";
  if (loadoutFlag && loadout === undefined) return "--loadout needs a name";
  if (reviewersFlag && rawReviewers !== "1" && rawReviewers !== "2") return "--reviewers must be 1 or 2";
  const priority = rawPriority === undefined ? undefined : parsePriority(rawPriority);
  if (priorityFlag && (priority === undefined || priority === null)) return "--priority must be interactive, normal or low";
  if (backend !== undefined && !/^https?:\/\/[^/\s]+$/.test(apiBase(backend))) {
    return `--backend must be an http(s) origin, got ${backend}`;
  }
  if (backend !== undefined && on !== undefined) return "use either --backend URL or --on NAME";

  const repo = args.shift();
  const rawAction = args.shift();
  if (!repo || !rawAction || args.length > 0) return RUN_USAGE;
  if (!isAction(rawAction)) return `unknown run action: ${rawAction}`;

  let times = 1;
  if (rawTimes !== undefined) {
    if (!/^\d+$/.test(rawTimes)) return "--times must be 1, 2, or 3";
    times = Number(rawTimes);
    if (times < 1 || times > 3) return "--times must be 1, 2, or 3";
  }
  if (loadout !== undefined && (times > 1 || profilesFlag)) return "--loadout starts one run; use --profiles for a group";
  if (autoLand && times === 1) return "--auto-land requires --times 2 or 3";
  if (profilesFlag && times === 1) return "--profiles requires --times 2 or 3";
  if (reviewersFlag && times === 1) return "--reviewers requires --times 2 or 3";
  // an empty name is the repo's job route: --profiles ,codex-fast
  const profiles = rawProfiles?.split(",").map((name) => name.trim() || null);
  if (profiles && profiles.length > times) return `--profiles names ${profiles.length} members; --times says ${times}`;

  return {
    repo,
    action: rawAction,
    note: note ?? "",
    times,
    explicitTimes: timesFlag,
    autoLand,
    pr,
    ...(profiles ? { profiles } : {}),
    ...(rawReviewers === "2" ? { reviewers: 2 as const } : {}),
    ...(priority ? { priority } : {}),
    ...(toolsOn || toolsOff ? { canopyTools: toolsOn } : {}),
    ...(loadout !== undefined ? { loadout } : {}),
    ...(backend !== undefined ? { backend } : {}),
    ...(on !== undefined ? { on } : {}),
  };
}

export const RUNS_USAGE = "usage: canopy runs child <repo> --note text --parent <run> [--action ask|propose] [--backend URL] [--on NAME]";

export interface ChildArgs {
  repo: string;
  note: string;
  parent: string;
  action?: string;
  backend?: string;
  on?: string;
}

/** `canopy runs child`'s words, without mutating the caller's arguments. */
export function parseChildArgs(argv: string[]): ChildArgs | string {
  const args = [...argv];
  const backend = take(args, "--backend");
  const on = take(args, "--on");
  const note = take(args, "--note");
  const parent = take(args, "--parent");
  const action = take(args, "--action");
  if (args.shift() !== "child") return RUNS_USAGE;
  const repo = args.shift();
  if (!repo || args.length > 0 || !note?.trim() || !parent) return RUNS_USAGE;
  if (backend !== undefined && on !== undefined) return "use either --backend URL or --on NAME";
  return { repo, note, parent, ...(action !== undefined ? { action } : {}), ...(backend !== undefined ? { backend } : {}), ...(on !== undefined ? { on } : {}) };
}

/** The same start `canopy_run_start` makes, from a shell. */
export async function runsCommand(argv: string[], { fail }: { fail: Fail }): Promise<void> {
  const parsed = parseChildArgs(argv);
  if (typeof parsed === "string") return fail(parsed);
  const target = await selectedTarget({ ...parsed }, fail);
  const repo = await repoId(parsed.repo, target, fail);
  const run = await ask<Run>(target, "POST", "/api/runs/child", { repo, note: parsed.note, parent: parsed.parent, ...(parsed.action !== undefined ? { action: parsed.action } : {}) })
    .catch(requestFailure(target, fail));
  console.log(`started run ${run.id} on ${run.branch?.name ?? "its branch"}, child of ${parsed.parent}`);
}

type Fail = (message: string) => never;
type TranscriptCommand = (argv: string[], deps: { fail: Fail }) => Promise<void> | void;

export interface RunCommandDeps {
  fail: Fail;
  /** Optional override; `runCommand` supplies the built-in transcript handler. */
  transcripts?: TranscriptCommand;
}

/** The one `run` dispatch point shared by group starts and transcript tools. */
export async function dispatchRunCommand(argv: string[], deps: RunCommandDeps): Promise<void> {
  const args = [...argv];
  const first = firstWord(args);
  if (first === "pickup") return pickupCommand(args, deps);
  if (first === undefined || first === "show" || first === "export" || first === "fork" || first === "prune" || first === "say" || first === "interrupt") {
    if (deps.transcripts) return deps.transcripts(args, { fail: deps.fail });
    return deps.fail(RUN_USAGE);
  }
  return runStartCommand(args, deps);
}

/** `canopy run pickup <flow>`: take up a flow a restart or a stop left. */
async function pickupCommand(argv: string[], { fail }: RunCommandDeps): Promise<void> {
  const args = [...argv];
  const backendFlag = args.includes("--backend");
  const backend = take(args, "--backend");
  const onFlag = args.includes("--on");
  const on = take(args, "--on");
  if (backendFlag && backend === undefined) return fail("--backend needs a value");
  if (onFlag && on === undefined) return fail("--on needs a value");
  if (backend !== undefined && on !== undefined) return fail("use either --backend URL or --on NAME");
  if (args.shift() !== "pickup") return fail(RUN_USAGE);
  const id = args.shift();
  if (!id || args.length > 0) return fail(RUN_USAGE);
  const target = await selectedTarget({ ...(backend !== undefined ? { backend } : {}), ...(on !== undefined ? { on } : {}) }, fail);
  const flow = await ask<{ id: string; status: string }>(target, "POST", "/api/flows/pickup", { id }).catch(requestFailure(target, fail));
  console.log(`${flow.id} ${flow.status}`);
}

/** Alias used by the top-level CLI. Transcript forms share the dispatcher
 * while group starts retain their existing parser and backend flow. */
export function runCommand(argv: string[], deps: RunCommandDeps): Promise<void> {
  return dispatchRunCommand(argv, { ...deps, transcripts: deps.transcripts ?? runTranscriptCommand });
}

function firstWord(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "-m" || value === "--times" || value === "--backend" || value === "--on" || value === "--priority" || value === "--at" || value === "--profile" || value === "--profiles" || value === "--reviewers" || value === "--loadout") {
      i += 1;
      continue;
    }
    if (value !== undefined && !value.startsWith("-")) return value;
  }
  return undefined;
}

function requestFailure(target: Target, fail: Fail): (error: unknown) => never {
  return (error: unknown) => fail(error instanceof Unreachable ? `${target.name} did not answer: ${error.message}` : errText(error));
}

async function selectedTarget(args: Pick<RunArgs, "backend" | "on">, fail: Fail): Promise<Target> {
  const home = apiBase(args.backend);
  if (!/^https?:\/\/[^/\s]+$/.test(home)) return fail(`--backend must be an http(s) origin, got ${home}`);
  const homeTarget: Target = { name: "home", urls: [home] };
  if (args.on === undefined) return homeTarget;

  const listed = await ask<{ self?: string; backends?: BackendEntry[] }>(homeTarget, "GET", "/api/backends")
    .catch((error: unknown) => requestFailure(homeTarget, fail)(error));
  const targets = listed.self ? targetsOf(home, listed.self, listed.backends ?? []) : [homeTarget];
  const found = targets.find((target) => target.name === args.on);
  if (!found) return fail(`no backend named ${args.on}; the home backend lists ${targets.map((target) => target.name).join(", ")}`);
  return found;
}

function isPathArgument(value: string): boolean {
  return value === "." || value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~");
}

async function repoId(repoArg: string, target: Target, fail: Fail): Promise<string> {
  if (!isPathArgument(repoArg)) return repoArg;
  const path = await realpath(resolve(repoArg.replace(/^~(?=$|\/)/, process.env["HOME"] ?? "~")))
    .catch(() => fail(`no such folder: ${repoArg}`));
  const tree = await ask<ScanResult>(target, "GET", "/api/tree").catch(requestFailure(target, fail));
  const repo = tree.repos.find((candidate) => candidate.path === path);
  if (!repo) return fail(`${target.name} does not scan ${path}`);
  return repo.id;
}

/** a backend as a person would name it: its name, or its address for --backend */
const backendWord = (target: Target): string => (target.name === "home" ? (target.urls[0] ?? target.name) : target.name);

async function runStartCommand(argv: string[], { fail }: RunCommandDeps): Promise<void> {
  const parsed = parseRunArgs(argv);
  if (typeof parsed === "string") return fail(parsed);
  const target = await selectedTarget(parsed, fail);
  // a backend from before loadouts would take the body, drop the name and
  // start a plain run with every skill on
  if (parsed.loadout !== undefined) {
    await ask<unknown>(target, "GET", "/api/loadouts").catch((error: unknown) =>
      error instanceof Refused && error.status === 404 ? fail(`${backendWord(target)} predates loadouts; redeploy it`) : requestFailure(target, fail)(error));
  }
  const id = await repoId(parsed.repo, target, fail);
  const body = {
    action: parsed.action,
    note: parsed.note,
    branch: true,
    ...(parsed.explicitTimes ? { times: parsed.times } : {}),
    ...(parsed.profiles ? { profiles: parsed.profiles } : {}),
    ...(parsed.reviewers ? { reviewers: parsed.reviewers } : {}),
    ...(parsed.autoLand ? { autoLand: true } : {}),
    ...(parsed.pr ? { pr: true } : {}),
    ...(parsed.priority ? { priority: parsed.priority } : {}),
    ...(parsed.canopyTools !== undefined ? { canopyTools: parsed.canopyTools } : {}),
    ...(parsed.loadout !== undefined ? { loadout: parsed.loadout } : {}),
  };
  const result = await ask<Run | RunGroup>(
    target,
    "POST",
    `/api/repos/run?id=${encodeURIComponent(id)}`,
    body,
  ).catch(requestFailure(target, fail));
  if (isRunGroup(result)) {
    console.log(`${result.id} ${groupWord(result)}`);
    return;
  }
  if (parsed.times > 1) return fail("the backend did not return a group record");
  if (parsed.loadout !== undefined && !result.equip) {
    return fail(`run ${result.id} started on ${backendWord(target)} without loadout ${parsed.loadout}; stop it and redeploy ${backendWord(target)}`);
  }
  console.log(`${result.id} ${result.status}`);
}

function isRunGroup(result: Run | RunGroup): result is RunGroup {
  return "members" in result;
}

/** `canopy run`: start a branch or best-of-N run, or inspect its transcript. */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { groupWord, type RunGroup } from "../core/group";
import { RUN_ACTIONS, type BackendEntry, type Run, type RunAction, type ScanResult } from "../core/types";
import { apiBase } from "./api";
import { ask, errText, has, take, targetsOf, Unreachable, type Target } from "./health";
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
  const autoLand = has(args, "--auto-land");
  const pr = has(args, "--pr");
  if (backendFlag && backend === undefined) return "--backend needs a value";
  if (onFlag && on === undefined) return "--on needs a value";
  if (noteFlag && note === undefined) return "-m needs a note";
  if (timesFlag && rawTimes === undefined) return "--times needs a value";
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
  if (autoLand && times === 1) return "--auto-land requires --times 2 or 3";

  return {
    repo,
    action: rawAction,
    note: note ?? "",
    times,
    explicitTimes: timesFlag,
    autoLand,
    pr,
    ...(backend !== undefined ? { backend } : {}),
    ...(on !== undefined ? { on } : {}),
  };
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
  if (first === undefined || first === "show" || first === "export" || first === "prune") {
    if (deps.transcripts) return deps.transcripts(args, { fail: deps.fail });
    return deps.fail(RUN_USAGE);
  }
  return runStartCommand(args, deps);
}

/** Alias used by the top-level CLI. Transcript forms share the dispatcher
 * while group starts retain their existing parser and backend flow. */
export function runCommand(argv: string[], deps: RunCommandDeps): Promise<void> {
  return dispatchRunCommand(argv, { ...deps, transcripts: deps.transcripts ?? runTranscriptCommand });
}

function firstWord(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "-m" || value === "--times" || value === "--backend" || value === "--on") {
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

async function selectedTarget(args: RunArgs, fail: Fail): Promise<Target> {
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

async function runStartCommand(argv: string[], { fail }: RunCommandDeps): Promise<void> {
  const parsed = parseRunArgs(argv);
  if (typeof parsed === "string") return fail(parsed);
  const target = await selectedTarget(parsed, fail);
  const id = await repoId(parsed.repo, target, fail);
  const body = {
    action: parsed.action,
    note: parsed.note,
    branch: true,
    ...(parsed.explicitTimes ? { times: parsed.times } : {}),
    ...(parsed.autoLand ? { autoLand: true } : {}),
    ...(parsed.pr ? { pr: true } : {}),
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
  console.log(`${result.id} ${result.status}`);
}

function isRunGroup(result: Run | RunGroup): result is RunGroup {
  return "members" in result;
}

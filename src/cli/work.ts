/** `canopy work`: list the backend's branch work items and read, annotate or
 *  close one through the HTTP API. */

import { fromWord, isWorkId, WORK_STATES, workIdOf, type WorkInfo, type WorkItem, type WorkState } from "../core/work";
import { currentBranch } from "../core/worktree";
import { apiBase } from "./api";
import { ask, errText, has, take, targetsOf, Unreachable, type Target } from "./health";

export const WORK_USAGE =
  'usage: canopy work [list] [--repo R] [--state S] [--backend URL]\n       canopy work show <id> [--backend URL]\n       canopy work note [<id>] "<text>" [--backend URL]\n       canopy work close <id> --landed | --dropped [-m why] [--backend URL]';

const isWorkState = (value: string): value is WorkState => WORK_STATES.some((state) => state === value);
const words = (values: readonly string[]): string => values.length ? values.join(", ") : "none";

/** One line per item, with the backend as a heading when requested. */
export function listLines(items: readonly WorkItem[], backend = ""): string[] {
  const lines = items.map((item) => {
    const newest = item.notes.at(-1);
    return `${item.id}  ${item.state.padEnd(8)} ${item.repos.join(",").padEnd(18)} ${item.title}${newest ? `  · ${newest.by}: ${newest.text}` : ""}`;
  });
  return backend ? [backend, ...lines] : lines;
}

/** The complete item: its source, branches, runs, links and dated notes. */
export function showLines(item: WorkItem): string[] {
  const prs = item.prs.map((pr) => `#${pr.number} ${pr.url}`);
  const out = [
    `${item.id}  ${item.title}`,
    `state: ${item.state}   repos: ${words(item.repos)}   from: ${fromWord(item.from)}`,
    `branches: ${words(item.branches)}   runs: ${words(item.runs)}   PRs: ${words(prs)}   events: ${words(item.events)}`,
    "notes:",
  ];
  if (item.notes.length === 0) out.push("  (none yet)");
  else {
    for (const note of item.notes) {
      const at = new Date(note.at).toISOString().slice(0, 16).replace("T", " ");
      out.push(`  ${at}  ${note.by}  ${note.text}`);
    }
  }
  return out;
}

const homeError = (err: unknown): string => (err instanceof Unreachable ? `home did not answer: ${err.message}` : errText(err));

export async function workCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const home = apiBase(given);
  if (!/^https?:\/\/[^/\s]+$/.test(home)) return fail(`--backend must be an http(s) origin, got ${home}`);
  const homeTarget: Target = { name: "home", urls: [home] };
  const askHome = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
    ask<T>(homeTarget, method, path, body).catch((err: unknown) => fail(homeError(err)));

  const sub = args[0] === "list" || args[0] === "show" || args[0] === "note" || args[0] === "close" ? args.shift()! : "list";
  if (sub === "list") {
    const repo = take(args, "--repo");
    const state = take(args, "--state");
    if ((state !== undefined && !isWorkState(state)) || args.length > 0) return fail(WORK_USAGE);
    const query = new URLSearchParams();
    if (repo !== undefined) query.set("repo", repo);
    if (state !== undefined) query.set("state", state);
    const path = `/api/work${query.size > 0 ? `?${query.toString()}` : ""}`;
    const listed = given === undefined ? await ask<{ self?: string; backends?: { name: string; tailnet?: string; public?: string }[] }>(homeTarget, "GET", "/api/backends").catch(() => null) : null;
    const targets = given === undefined && listed?.self ? targetsOf(home, listed.self, listed.backends ?? []) : [homeTarget];
    let any = false;
    for (const target of targets) {
      try {
        const info = await ask<WorkInfo>(target, "GET", path);
        if (info.items.length === 0) continue;
        const lines = listLines(info.items, targets.length > 1 ? target.name : "");
        for (const line of lines) console.log(line);
        any = true;
      } catch (err) {
        console.log(`${target.name}: ${err instanceof Unreachable ? `did not answer: ${err.message}` : errText(err)}`);
      }
    }
    if (!any) console.log("no work items");
    return;
  }

  if (sub === "show") {
    const id = args.shift();
    if (!id || !isWorkId(id) || args.length > 0) return fail(WORK_USAGE);
    const item = await askHome<WorkItem>("GET", `/api/work/one?id=${encodeURIComponent(id)}`);
    for (const line of showLines(item)) console.log(line);
    return;
  }

  if (sub === "note") {
    const first = args[0];
    let id: string | null;
    if (first && isWorkId(first)) id = args.shift() ?? null;
    else id = workIdOf(await currentBranch(process.cwd()));
    if (!id) return fail("no work id given, and this folder is not on a run/w-… branch");
    const text = args.join(" ").trim();
    if (!text) return fail(WORK_USAGE);
    await askHome<WorkItem>("POST", "/api/work/note", { id, text });
    console.log(`noted on ${id}`);
    return;
  }

  if (sub === "close") {
    const landed = has(args, "--landed");
    const dropped = has(args, "--dropped");
    const id = args.shift();
    const reasonFlag = args.includes("-m");
    const reason = take(args, "-m");
    if (landed === dropped || !id || !isWorkId(id) || args.length > 0 || (reasonFlag && reason === undefined)) return fail(WORK_USAGE);
    const state = landed ? "landed" : "dropped";
    await askHome<WorkItem>("POST", "/api/work/close", { id, state, ...(reason !== undefined ? { reason } : {}) });
    console.log(`${id} closed as ${state}`);
    return;
  }

  return fail(WORK_USAGE);
}

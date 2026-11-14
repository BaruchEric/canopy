/**
 * `canopy coordinator`: the live coordinators, one goal's cards, and the
 * steering verbs hold, resume and start. The lines are pure
 * (coordinator.test.ts).
 */

import { cardCarries, cardCounts } from "../core/coordinator";
import { isRunActive, type Run } from "../core/types";
import { basename } from "node:path";
import { apiBase, callerHeaders } from "./api";
import { ask, backendTargets, errText, has, take, Unreachable } from "./health";

export const COORDINATOR_USAGE =
  "usage: canopy coordinator [--json] [--backend URL | --on NAME]\n       canopy coordinator <run> [--json] [--backend URL | --on NAME]\n       canopy coordinator hold <run>\n       canopy coordinator resume <run>\n       canopy coordinator start <run> [id ...]\n       canopy coordinator new <goal> [--repo R ...] [--file PATH ...] [--model M] [--effort E] [--on NAME | --backend URL]";

export interface NewGoalArgs {
  goal: string;
  repos: string[];
  files: string[];
  model?: string;
  effort?: string;
}

/** `canopy coordinator new` arguments: the goal's words, repeated --repo and --file, --model and --effort */
export function parseNewArgs(argv: string[]): NewGoalArgs | { error: string } {
  const words: string[] = [];
  const repos: string[] = [];
  const files: string[] = [];
  let model: string | undefined;
  let effort: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    if (arg !== "--repo" && arg !== "--file" && arg !== "--model" && arg !== "--effort") return { error: `unknown flag ${arg}` };
    const value = argv[++i];
    if (value === undefined || value === "") return { error: `${arg} needs a value` };
    if (arg === "--repo") repos.push(value);
    else if (arg === "--file") files.push(value);
    else if (arg === "--model") model = value;
    else effort = value;
  }
  const goal = words.join(" ").trim();
  if (goal === "") return { error: COORDINATOR_USAGE };
  return { goal, repos, files, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
}

/** the multipart body `POST /api/coordinator/new` reads */
export function newGoalForm(args: { goal: string; repos: string[]; files: { name: string; data: Uint8Array }[]; model?: string; effort?: string }): FormData {
  const form = new FormData();
  form.append("goal", args.goal);
  for (const repo of args.repos) form.append("repos[]", repo);
  for (const file of args.files) form.append("files[]", new File([file.data], file.name), file.name);
  if (args.model !== undefined) form.append("model", args.model);
  if (args.effort !== undefined) form.append("effort", args.effort);
  return form;
}

/** what to try when the backend asked runs no coordinator */
export const NEW_GOAL_HINT = "hint: this backend runs no coordinator; name one that does with --on <backend>";

/** A refused new goal in words: the server's, and the hint to name a
 *  backend when the one asked runs no coordinator (its 409) and the command
 *  named none. */
export function newGoalRefusal(error: string, status: number, named: boolean): string {
  return status === 409 && !named ? `${error}\n${NEW_GOAL_HINT}` : error;
}

/** the page that shows a goal; its own backend serves it, so the id stays bare */
export const goalLink = (base: string, id: string): string => `${base.replace(/\/+$/, "")}/?view=manager&run=${encodeURIComponent(id)}`;

const firstLine = (text: string): string => text.split("\n")[0]?.trim() ?? "";

/** the live coordinators: id, repo, held or not, card counts, the goal's first line */
export function coordinatorLines(runs: Run[]): string[] {
  return runs
    .filter((run) => run.action === "coordinate" && isRunActive(run))
    .map((run) => [run.id, run.repoId, run.held ? "held" : "", cardCounts(run.tasks ?? []), firstLine(run.note)].filter((field) => field !== "").join("  "));
}

/** one coordinator's cards, columns padded: id, state, repo, loadout, workflow, after, files, title */
export function cardLines(run: Run): string[] {
  const rows = (run.tasks ?? []).map((task) => {
    const carries = cardCarries(task);
    return [task.id, task.state, task.repo, carries.loadout?.word ?? "", carries.workflow ?? "", carries.after ?? "", carries.files ?? ""];
  });
  const widths = [0, 1, 2, 3, 4, 5, 6].map((col) => Math.max(0, ...rows.map((row) => row[col]?.length ?? 0)));
  return (run.tasks ?? []).map((task, i) => {
    const row = rows[i] ?? [];
    const cells = row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).filter((_, col) => (widths[col] ?? 0) > 0);
    return [...cells, task.title].join("  ");
  });
}

export async function coordinatorCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const backendFlag = args.includes("--backend");
  const given = take(args, "--backend");
  const onFlag = args.includes("--on");
  const on = take(args, "--on");
  if (backendFlag && given === undefined) return fail("--backend needs a value");
  if (onFlag && on === undefined) return fail("--on needs a value");
  if (backendFlag && onFlag) return fail("use either --backend URL or --on NAME");
  const asJson = has(args, "--json");
  const home = apiBase(given);
  const [named] = on === undefined ? [] : await backendTargets(home, { ...(given !== undefined ? { given } : {}), on }, fail);
  const target = named ?? { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(err instanceof Unreachable ? `${target.name} did not answer: ${err.message}` : errText(err));

  const sub = args[0];
  if (sub === "hold" || sub === "resume") {
    const run = args[1];
    if (!run || args.length !== 2) return fail(COORDINATOR_USAGE);
    await ask<unknown>(target, "POST", "/api/coordinator/hold", { run, held: sub === "hold" }).catch(failed);
    console.log(sub === "hold" ? `${run} held: no card starts until you resume it` : `${run} resumed`);
    return;
  }
  if (sub === "new") {
    const parsed = parseNewArgs(args.slice(1));
    if ("error" in parsed) return fail(parsed.error);
    const files: { name: string; data: Uint8Array }[] = [];
    for (const path of parsed.files) {
      const f = Bun.file(path);
      if (!(await f.exists())) return fail(`no such file: ${path}`);
      files.push({ name: basename(path), data: new Uint8Array(await f.arrayBuffer()) });
    }
    const tried: string[] = [];
    for (const url of target.urls) {
      let res: Response;
      try {
        res = await fetch(`${url}/api/coordinator/new`, { method: "POST", body: newGoalForm({ ...parsed, files }), redirect: "manual", headers: callerHeaders(url) });
      } catch (err) {
        tried.push(`${url}: ${errText(err)}`);
        continue;
      }
      if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
        tried.push(`${url}: needs a sign-in`);
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !body.id) return fail(newGoalRefusal(body.error ?? `${target.name} answered ${res.status}`, res.status, given !== undefined || on !== undefined));
      console.log(`${body.id}  ${goalLink(url, body.id)}`);
      return;
    }
    return fail(`${target.name} did not answer: ${tried.join("; ") || "no address"}`);
  }
  if (sub === "start") {
    const run = args[1];
    if (!run) return fail(COORDINATOR_USAGE);
    const ids = args.slice(2);
    await ask<unknown>(target, "POST", "/api/coordinator/start", { run, ...(ids.length > 0 ? { ids } : {}) }).catch(failed);
    console.log(ids.length > 0 ? `${run}: started ${ids.join(", ")}` : `${run}: started every proposed card`);
    return;
  }

  if (args.length > 1) return fail(COORDINATOR_USAGE);
  const runs = await ask<Run[]>(target, "GET", "/api/runs").catch(failed);
  if (sub === undefined) {
    const live = runs.filter((run) => run.action === "coordinate" && isRunActive(run));
    if (asJson) return void console.log(JSON.stringify(live, null, 2));
    if (live.length === 0) return void console.log("no live coordinators");
    for (const line of coordinatorLines(runs)) console.log(line);
    return;
  }
  const run = runs.find((candidate) => candidate.id === sub && candidate.action === "coordinate" && isRunActive(candidate));
  if (!run) return fail(`no live coordinator ${sub}`);
  if (asJson) return void console.log(JSON.stringify(run.tasks ?? [], null, 2));
  const lines = cardLines(run);
  if (lines.length === 0) return void console.log(`${run.id} has no cards yet`);
  for (const line of lines) console.log(line);
}

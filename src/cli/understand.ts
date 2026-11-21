/** `canopy understand`: a checkout's knowledge graph (FR-072). Says where the
 *  graph stands, starts the Claude run that makes, updates or rebuilds it,
 *  and starts or stops the graph's viewer, the same things the repo panel's
 *  map section does when it shows Understand-Anything. The first start or
 *  open on a backend prepares the plugin there; the command waits for it. */

import { PREPARING_WORDS, isWait, understandLine, type UnderstandInfo, type UnderstandWait } from "../core/understand";
import type { Run } from "../core/types";
import { ask, has, take, type Target } from "./health";
import { repoId, requestFailure, selectedTarget } from "./run";
import { ageWord } from "./worktrees";

export const UNDERSTAND_USAGE = [
  "usage: canopy understand <repo> [status] [--json] [--backend URL] [--on NAME]",
  "       canopy understand <repo> make|update|rebuild [-m note] [--backend URL] [--on NAME]",
  "       canopy understand <repo> open|stop|prepare [--backend URL] [--on NAME]",
].join("\n");

const ACTS = ["status", "make", "update", "rebuild", "open", "stop", "prepare"] as const;
type Act = (typeof ACTS)[number];

export interface UnderstandArgs {
  repo: string;
  act: Act;
  note: string;
  json: boolean;
  backend?: string;
  on?: string;
}

/** The command's words, without changing the caller's list. */
export function parseUnderstandArgs(argv: string[]): UnderstandArgs | string {
  const args = [...argv];
  const backend = take(args, "--backend");
  const on = take(args, "--on");
  const note = take(args, "-m") ?? take(args, "--note");
  const json = has(args, "--json");
  const [repo, word = "status", ...rest] = args;
  const act = ACTS.find((a) => a === word);
  if (!repo || repo.startsWith("-") || !act || rest.length > 0) return UNDERSTAND_USAGE;
  if (backend !== undefined && on !== undefined) return "use either --backend URL or --on NAME";
  const starts = act === "make" || act === "update" || act === "rebuild";
  if (!starts && note !== undefined) return `-m goes with make, update or rebuild\n\n${UNDERSTAND_USAGE}`;
  return { repo, act, note: note ?? "", json, ...(backend !== undefined ? { backend } : {}), ...(on !== undefined ? { on } : {}) };
}

/** A status in lines: the graph, the plugin, its viewer, the run at it.
 *  `now` is unix ms. */
export function understandLines(info: UnderstandInfo, now: number): string[] {
  const ago = (iso: string): string => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? iso : `${ageWord(now - t)} ago`.replace("now ago", "just now");
  };
  const extras = [info.domain ? "a domain graph" : "", info.lessons ? "code lessons" : ""].filter(Boolean);
  return [
    `${understandLine(info, ago)}${info.state === "graph" ? ` (in ${info.folder}/)` : ""}`,
    ...(extras.length ? [`with ${extras.join(" and ")}`] : []),
    ...(info.plugin.state === "preparing" ? [`${PREPARING_WORDS}…`] : []),
    ...(info.plugin.state === "failed" ? [`preparing Understand-Anything failed: ${info.plugin.error} (any start or open tries again)`] : []),
    ...(info.server ? [`its viewer is up on the backend's port ${info.server.port}; the repo's map section shows it`] : []),
    ...(info.run ? [`run ${info.run} is making it now (canopy run show ${info.run})`] : []),
  ];
}

/** Sends `body`, and while the backend answers that it is preparing the
 *  plugin, says so once, waits for the prepare and sends it again. */
async function untilReady<T>(target: Target, path: string, body: unknown, failed: (err: unknown) => never): Promise<T> {
  const deadline = Date.now() + 15 * 60_000;
  let said = false;
  for (;;) {
    const got = await ask<T | UnderstandWait>(target, "POST", path, body, 60_000).catch(failed);
    if (!isWait(got)) return got;
    if (!said) console.log(`${PREPARING_WORDS}…`);
    said = true;
    for (;;) {
      if (Date.now() > deadline) throw failed(new Error("the backend is still preparing Understand-Anything; try again in a minute"));
      await Bun.sleep(3_000);
      const info = await ask<UnderstandInfo>(target, "GET", path, undefined, 30_000).catch(failed);
      if (info.plugin.state === "failed") throw failed(new Error(`preparing Understand-Anything failed: ${info.plugin.error}`));
      if (info.plugin.state === "ready") break;
    }
  }
}

export async function understandCommand(argv: string[], { fail }: { fail: (message: string) => never }): Promise<void> {
  const parsed = parseUnderstandArgs(argv);
  if (typeof parsed === "string") return fail(parsed);
  const target = await selectedTarget(parsed, fail);
  const id = await repoId(parsed.repo, target, fail);
  const path = `/api/repos/understand?${new URLSearchParams({ id })}`;
  const failed = requestFailure(target, fail);
  switch (parsed.act) {
    case "status": {
      const info = await ask<UnderstandInfo>(target, "GET", path, undefined, 30_000).catch(failed);
      if (parsed.json) console.log(JSON.stringify(info, null, 2));
      else for (const line of understandLines(info, Date.now())) console.log(line);
      return;
    }
    case "make":
    case "update":
    case "rebuild": {
      const body = { act: "make", note: parsed.note, ...(parsed.act === "rebuild" ? { full: true } : {}) };
      const run = await untilReady<Run>(target, path, body, failed);
      console.log(`started run ${run.id} (${run.verb}). Follow it with canopy run show ${run.id}; its questions wait in the page.`);
      return;
    }
    case "open": {
      const { port } = await untilReady<{ port: number }>(target, path, { act: "open" }, failed);
      console.log(`the graph's viewer is up on the backend's port ${port}; the repo's map section shows it`);
      return;
    }
    case "prepare": {
      await untilReady<{ plugin: unknown }>(target, path, { act: "prepare" }, failed);
      console.log("Understand-Anything is ready on the backend");
      return;
    }
    case "stop": {
      const { stopped } = await ask<{ stopped: boolean }>(target, "POST", path, { act: "stop" }).catch(failed);
      console.log(stopped ? "stopped the graph's viewer" : "no viewer was up");
      return;
    }
  }
}

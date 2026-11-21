/** `canopy floorplan`: a checkout's map (FR-070). Says where the map
 *  stands, starts the Claude run that makes or updates it, and starts or
 *  stops the map's own server, the same four things the repo panel's map
 *  section does. */

import { floorplanLine, type FloorplanInfo } from "../core/floorplan";
import type { Run } from "../core/types";
import { ask, has, take } from "./health";
import { repoId, requestFailure, selectedTarget } from "./run";
import { ageWord } from "./worktrees";

export const FLOORPLAN_USAGE = [
  "usage: canopy floorplan <repo> [status] [--json] [--backend URL] [--on NAME]",
  "       canopy floorplan <repo> make|update [-m note] [--developers] [--backend URL] [--on NAME]",
  "       canopy floorplan <repo> open|stop [--backend URL] [--on NAME]",
].join("\n");

const ACTS = ["status", "make", "update", "open", "stop"] as const;
type Act = (typeof ACTS)[number];

export interface FloorplanArgs {
  repo: string;
  act: Act;
  note: string;
  developers: boolean;
  json: boolean;
  backend?: string;
  on?: string;
}

/** The command's words, without changing the caller's list. */
export function parseFloorplanArgs(argv: string[]): FloorplanArgs | string {
  const args = [...argv];
  const backend = take(args, "--backend");
  const on = take(args, "--on");
  const note = take(args, "-m") ?? take(args, "--note");
  const developers = has(args, "--developers");
  const json = has(args, "--json");
  const [repo, word = "status", ...rest] = args;
  const act = ACTS.find((a) => a === word);
  if (!repo || repo.startsWith("-") || !act || rest.length > 0) return FLOORPLAN_USAGE;
  if (backend !== undefined && on !== undefined) return "use either --backend URL or --on NAME";
  const starts = act === "make" || act === "update";
  if (!starts && (note !== undefined || developers)) return `-m and --developers go with make or update\n\n${FLOORPLAN_USAGE}`;
  return { repo, act, note: note ?? "", developers, json, ...(backend !== undefined ? { backend } : {}), ...(on !== undefined ? { on } : {}) };
}

/** A status in lines: the map, its server, the run at it. `now` is unix ms. */
export function floorplanLines(info: FloorplanInfo, now: number): string[] {
  const ago = (iso: string): string => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? iso : `${ageWord(now - t)} ago`.replace("now ago", "just now");
  };
  return [
    floorplanLine(info, ago),
    ...(info.server ? [`its server is up on the backend's port ${info.server.port}; the repo's map section shows it`] : []),
    ...(info.run ? [`run ${info.run} is drawing it now (canopy run show ${info.run})`] : []),
  ];
}

export async function floorplanCommand(argv: string[], { fail }: { fail: (message: string) => never }): Promise<void> {
  const parsed = parseFloorplanArgs(argv);
  if (typeof parsed === "string") return fail(parsed);
  const target = await selectedTarget(parsed, fail);
  const id = await repoId(parsed.repo, target, fail);
  const path = `/api/repos/floorplan?${new URLSearchParams({ id })}`;
  const failed = requestFailure(target, fail);
  switch (parsed.act) {
    case "status": {
      const info = await ask<FloorplanInfo>(target, "GET", path, undefined, 30_000).catch(failed);
      if (parsed.json) console.log(JSON.stringify(info, null, 2));
      else for (const line of floorplanLines(info, Date.now())) console.log(line);
      return;
    }
    case "make":
    case "update": {
      const body = { act: "make", note: parsed.note, ...(parsed.developers ? { developers: true } : {}) };
      const run = await ask<Run>(target, "POST", path, body, 30_000).catch(failed);
      console.log(`started run ${run.id} (${run.verb}). Follow it with canopy run show ${run.id}; its questions wait in the page.`);
      return;
    }
    case "open": {
      const { port } = await ask<{ port: number }>(target, "POST", path, { act: "open" }, 60_000).catch(failed);
      console.log(`the map's server is up on the backend's port ${port}; the repo's map section shows it`);
      return;
    }
    case "stop": {
      const { stopped } = await ask<{ stopped: boolean }>(target, "POST", path, { act: "stop" }).catch(failed);
      console.log(stopped ? "stopped the map's server" : "no map server was up");
      return;
    }
  }
}

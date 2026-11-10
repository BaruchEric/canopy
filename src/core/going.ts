/** What a backend has going that recreating it would cut off, for the deploy
 *  script's check (`GET /api/going`, scripts/redeploy.sh). The route is open
 *  to a caller with no token, since the script on the host has none, so each
 *  line holds an id, a repo and a state and never an agent's words: no
 *  progress line, no note, no branch or step name. Pure and tested. */

import type { Fleet, Flow, LandEntry, Run } from "./types";

export interface Going {
  kind: "run" | "flow" | "fleet" | "landing";
  id: string;
  /** the repo's id; a fleet's first three, and how many more */
  repo: string;
  /** its verb and where it stands, in the script's words */
  doing: string;
}

const LANDING_BUSY: ReadonlySet<string> = new Set(["rebasing", "setup", "gate", "landing"]);
const FLEET_SHOWN = 3;

/** The work a restart would cut off: a run working or waiting on a prompt, a
 *  coordinator between turns with a card queued or running (a restart drops
 *  its queue), a flow working or waiting, a fleet working, and a landing
 *  entry rebasing, in setup, at its gate or landing. A chat that is idle and
 *  anything that has ended are not work going. */
export function goingOf(runs: readonly Run[], flows: readonly Flow[], fleets: readonly Fleet[], landing: readonly LandEntry[]): Going[] {
  const out: Going[] = [];
  for (const r of runs) {
    const cards = (r.tasks ?? []).filter((t) => t.state === "queued" || t.state === "running").length;
    const between = r.action === "coordinate" && r.status === "idle" && cards > 0;
    if (r.status !== "working" && r.status !== "waiting" && !between) continue;
    const state =
      r.status === "waiting" ? "waiting on a prompt" : between ? `idle with ${cards} ${cards === 1 ? "card" : "cards"} queued or running` : "working";
    out.push({ kind: "run", id: r.id, repo: r.repoId, doing: `${r.verb}, ${state}` });
  }
  for (const f of flows) {
    if (f.status !== "working" && f.status !== "waiting") continue;
    const at = `at step ${f.current + 1} of ${f.steps.length}`;
    out.push({ kind: "flow", id: f.id, repo: f.repoId, doing: `${f.verb}, ${at}${f.status === "waiting" ? ", waiting on a prompt" : ""}` });
  }
  for (const f of fleets) {
    if (f.status !== "working") continue;
    const ids = f.repos.map((r) => r.repoId);
    const more = ids.length - FLEET_SHOWN;
    out.push({ kind: "fleet", id: f.id, repo: `${ids.slice(0, FLEET_SHOWN).join(", ")}${more > 0 ? ` and ${more} more` : ""}`, doing: f.verb });
  }
  for (const e of landing) {
    if (!LANDING_BUSY.has(e.state)) continue;
    out.push({ kind: "landing", id: e.id, repo: e.repoId, doing: `${e.state}${e.gate ? ` (${e.gate})` : ""}` });
  }
  return out;
}

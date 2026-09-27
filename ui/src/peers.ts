/** Peer chips and lines: turns a repo's PeerState into what a card, a
 *  panel, or the feed says about it. Pure and browser-safe; the "how long
 *  ago" words come from the shared ago(), which reads the clock itself, so
 *  every timestamp here (PeerState.at, PeerWip.at, PeerSeen.at) rides in as
 *  milliseconds and is turned to ago()'s seconds at the call site. */

import { type PeerBranch, type PeerSeen, type PeerState, type Repo, type Run } from "../../src/core/types";
import { isLaunchSource } from "./backends";
import { ago } from "./util";

/** Whether peer sync covers this repo at all: a local checkout under its
 *  backend's launch root, not remote, not on a forge, and readable. Matches the
 *  server's own `peerable` in src/server/index.ts — a repo either side
 *  rejects never has anything worth showing here. */
export function peerable(repo: Repo): boolean {
  return isLaunchSource(repo.source) && !repo.host && !repo.forge && !repo.error;
}

export interface PeerChip {
  kind: "diverged" | "wip" | "only";
  text: string;
  title: string;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

function divergedChip(d: PeerBranch): PeerChip {
  return {
    kind: "diverged",
    text: `⇅ ${d.peer} ↑${d.behind} ↓${d.ahead}`,
    title: `${d.branch} diverged from ${d.peer}: ${plural(d.behind, "commit")} here, ${d.ahead} there`,
  };
}

export function peerChips(st: PeerState | undefined): PeerChip[] {
  if (!st) return [];
  const out: PeerChip[] = [];
  for (const d of st.diverged) out.push(divergedChip(d));
  for (const w of st.wip) {
    // ago() already ends in "ago" ("12m ago"), so nothing here repeats it.
    const when = ago(w.at / 1000);
    out.push({
      kind: "wip",
      text: `WIP on ${w.peer}/${w.branch} ${when}`,
      title: `${w.peer} has ${w.files} uncommitted files on ${w.branch}, ${when}`,
    });
  }
  if (st.onlyHere) out.push({ kind: "only", text: "only here", title: "no peer has this repo" });
  return out;
}

/** Each peer's uncommitted files, summed across its WIP branches: what the
 *  sidebar and the changes head say beside this checkout's own count.
 *  "mac 1" reads as the peer's, never as a file on this disk. */
export function peerWipCounts(st: PeerState | undefined): { peer: string; text: string; title: string }[] {
  const by = new Map<string, { files: number; branches: string[] }>();
  for (const w of st?.wip ?? []) {
    const e = by.get(w.peer) ?? { files: 0, branches: [] };
    e.files += w.files;
    e.branches.push(w.branch);
    by.set(w.peer, e);
  }
  return [...by].map(([peer, e]) => ({
    peer,
    text: `${peer} ${e.files}`,
    title: `${peer} has ${plural(e.files, "uncommitted file")} on ${e.branches.join(", ")}`,
  }));
}

// An offline peer's `at` stamps the failed attempt, not the last time it
// was actually reached, so there is no "ago" worth reporting for it.
export const seenWord = (s: PeerSeen): string =>
  s.ok ? `${s.name} · ${ago(s.at / 1000)}` : `${s.name} · offline`;

/** What changed between two readings of a repo's PeerState, for the feed:
 *  a branch moving forward, a divergence or a WIP not seen before. Nothing
 *  repeats once it has been reported, the same way statusLines() works. */
export function peerLines(prev: PeerState | undefined, next: PeerState | undefined): string[] {
  if (!next) return [];
  const out: string[] = [];
  const was = new Set((prev?.moved ?? []).map((m) => `${m.branch} ${m.to}`));
  for (const m of next.moved) {
    if (!was.has(`${m.branch} ${m.to}`)) out.push(`${m.branch} fast-forwarded to ${m.to.slice(0, 8)} from ${m.peer}`);
  }
  const div = new Set((prev?.diverged ?? []).map((d) => `${d.branch} ${d.peer}`));
  for (const d of next.diverged) {
    if (!div.has(`${d.branch} ${d.peer}`)) out.push(`${d.branch} diverged from ${d.peer}`);
  }
  const wips = new Set((prev?.wip ?? []).map((w) => `${w.peer} ${w.branch} ${w.hash}`));
  for (const w of next.wip) {
    if (!wips.has(`${w.peer} ${w.branch} ${w.hash}`)) out.push(`WIP from ${w.peer} on ${w.branch} (${w.files} files)`);
  }
  return out;
}

/** What "merge with claude" should do about a repo's active run, if any:
 *  start a fresh chat when there is none, send into an idle chat's next
 *  turn (a chat between turns is the only run status that means "waiting
 *  for a message", never a run actually busy), or refuse when one is
 *  genuinely in progress. */
export type MergeAction = "new" | "say" | "busy";

export function mergeAction(active: Run | undefined): MergeAction {
  if (!active) return "new";
  return active.status === "idle" ? "say" : "busy";
}

/** Peer chips and lines: turns a repo's PeerState into what a card, a
 *  panel, or the feed says about it. Pure and browser-safe; the "how long
 *  ago" words come from the shared ago(), which reads the clock itself, so
 *  every timestamp here (PeerState.at, PeerWip.at, PeerSeen.at) rides in as
 *  milliseconds and is turned to ago()'s seconds at the call site. */

import type { PeerBranch, PeerSeen, PeerState } from "../../src/core/types";
import { ago } from "./util";

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
      text: `WIP on ${w.peer} ${when}`,
      title: `${w.peer} has ${w.files} uncommitted files on ${w.branch}, ${when}`,
    });
  }
  if (st.onlyHere) out.push({ kind: "only", text: "only here", title: "no peer has this repo" });
  return out;
}

export const seenWord = (s: PeerSeen): string =>
  s.ok ? `${s.name} · ${ago(s.at / 1000)}` : `${s.name} · offline ${ago(s.at / 1000)}`;

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

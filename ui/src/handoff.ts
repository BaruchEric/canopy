/**
 * Hand-off (agents spec, phase 5): "switch to codex" on a Claude Code
 * session, or back, opens a new shell in the same repo on the same backend
 * with the other harness, told where the first session's transcript is so
 * it can pick the work up. Pure, so it is tested.
 */
import { isLiveAgent, type AgentCard, type Harness, type Repo } from "../../src/core/types";
import { cardOnRepo } from "./agentcards";
import { AGENT_NAME } from "./runs";

/** the harness a hand-off switches to */
export const otherHarness = (h: Harness): Harness => (h === "claude" ? "codex" : "claude");

/** The new session's first message: the old one's transcript to read. With
 *  no transcript (none on that machine) the switch goes without one: an
 *  empty message, so the new agent starts on nothing but the repo. */
export function handoffPrompt(from: Harness, transcript: string | null): string {
  if (!transcript) return "";
  return `Continue the work of the ${AGENT_NAME[from]} session whose transcript is ${transcript}. Read its last part first.`;
}

/** A registry card a hand-off starts from: a live Claude Code or Codex in
 *  a canopy shell or run on a backend the page shows, with that backend and
 *  harness; null for any other card, since a shell can only be opened on a
 *  backend the page reaches. */
export function handoffFrom(card: AgentCard, shown: readonly string[]): { backend: string; harness: Harness } | null {
  const cw = card.where.canopy;
  if (!isLiveAgent(card) || card.harness === "other" || !cw?.backend || !(cw.term || cw.run)) return null;
  if (!shown.includes(cw.backend)) return null;
  return { backend: cw.backend, harness: card.harness };
}

const under = (cwd: string, path: string): boolean => cwd === path || cwd.startsWith(`${path.replace(/\/+$/, "")}/`);

/** The checkout a hand-off opens its shell in: among one backend's repos,
 *  the deepest local checkout holding the agent's folder, else the one its
 *  repo url names. */
export function handoffRepo(card: AgentCard, backendRepos: readonly Repo[]): Repo | undefined {
  const local = backendRepos.filter((r) => !r.host && !r.forge && !r.error);
  const byCwd = card.cwd ? local.filter((r) => under(card.cwd, r.path)).sort((a, b) => b.path.length - a.path.length)[0] : undefined;
  return byCwd ?? local.find((r) => cardOnRepo(card, r));
}

/** The live card a canopy shell's agent registered under, by the shell's
 *  plain id on its backend: where its harness and transcript are read from
 *  when the pane cannot say. */
export function cardOfShell(cards: Readonly<Record<string, AgentCard>>, backend: string, term: string): AgentCard | undefined {
  return Object.values(cards)
    .filter((c) => isLiveAgent(c) && c.where.canopy?.backend === backend && c.where.canopy.term === term)
    .sort((a, b) => b.seenAt - a.seenAt)[0];
}

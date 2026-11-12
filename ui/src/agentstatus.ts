/**
 * An agent's status as the page reads it: its registry card, every
 * backend's pulse for it, and whether an ask of its is open
 * (core/agentstatus has the rules). Pure; tested in agentstatus.test.ts.
 */

import { agentStatus, type AgentStatus, type StatusFacts } from "../../src/core/agentstatus";
import type { AgentCard, AgentPulse, Ask } from "../../src/core/types";

/** what the page knows beside a card */
export type FactsOf = (c: AgentCard) => StatusFacts;
/** a card's status, with those facts laid over it */
export type StatusOf = (c: AgentCard) => AgentStatus;

/** the card alone, for a view handed no facts */
export const noFacts: FactsOf = () => ({});
export const cardStatus: StatusOf = (c) => agentStatus(c);

/** every backend's pulses, by backend and then card id */
export type Pulses = Readonly<Record<string, Readonly<Record<string, AgentPulse>>>>;

/** a card's pulse from whichever backend reads it; only the machine it
 *  runs on holds its transcript, so at most one does */
export function pulseIn(pulses: Pulses, id: string): AgentPulse | undefined {
  for (const by of Object.values(pulses)) {
    const p = Object.hasOwn(by, id) ? by[id] : undefined;
    if (p) return p;
  }
  return undefined;
}

/** the facts for each card, from the pulses and the asks still open */
export function factsFrom(pulses: Pulses, asks: Readonly<Record<string, Ask>>): FactsOf {
  const asking = new Set<string>();
  for (const a of Object.values(asks)) if (a.state === "open") asking.add(a.agent);
  return (c) => {
    const pulse = pulseIn(pulses, c.id);
    return { ...(pulse ? { pulse } : {}), ...(asking.has(c.id) ? { asking: true } : {}) };
  };
}

/** a status reader over those facts */
export const statusFrom =
  (facts: FactsOf): StatusOf =>
  (c) =>
    agentStatus(c, facts(c));

/** One backend's pulses with an event's changes laid in and its gone
 *  dropped; the same object when nothing moved. */
export function mergePulses(held: Record<string, AgentPulse> | undefined, changed: readonly AgentPulse[], gone: readonly string[] = []): Record<string, AgentPulse> {
  const base = held ?? {};
  if (changed.length === 0 && !gone.some((id) => Object.hasOwn(base, id))) return base;
  const next: Record<string, AgentPulse> = { ...base };
  for (const p of changed) next[p.id] = p;
  for (const id of gone) delete next[id];
  return next;
}

/* Words for a run in the UI, whichever agent does the work: its name in a
   heading, its word in a chip, and the footer's line, which says the
   tokens a run spent where the harness reports those (Codex) and what it
   cost where it reports a cost (Claude Code). Pure; tested in runs.test.ts. */

import { HARNESS } from "../../src/core/harness";
import type { Harness, RunResult } from "../../src/core/types";

/** The harness a run is on. A run from a backend older than harnesses was
 *  Claude's, the only agent a run could be then. */
export const harnessOf = (run: { harness?: Harness }): Harness => run.harness ?? "claude";

/** The agent's name in a heading or a sentence. */
export const AGENT_NAME: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };

/** The agent's short word in a chip: "claude", "codex". */
export const agentWord = (h: Harness): string => HARNESS[h].label;

/** minutes and seconds, "3:07" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A token count at a glance: 950, 1.2k, 48k, 1.3M. */
export function tokenCount(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** The console footer's line: turns and time, then the tokens where the
 *  harness reports those (Codex), else the cost where it reports one
 *  (Claude Code). A Codex result also carries a zero cost for pages older
 *  than harnesses, which the tokens win over. */
export function resultLine(r: RunResult): string {
  const parts = [`${r.turns} turn${r.turns === 1 ? "" : "s"}`, clock(r.durationMs)];
  if (r.tokens) parts.push(`${tokenCount(r.tokens.total)} tokens`);
  else if (r.costUsd !== undefined) parts.push(`$${r.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}

/** A token breakdown for the footer's tooltip, or null without one. */
export function tokenTitle(r: RunResult): string | null {
  const t = r.tokens;
  if (!t) return null;
  return `${t.input} in (${t.cachedInput} cached), ${t.output} out (${t.reasoning} reasoning), ${t.total} in all`;
}

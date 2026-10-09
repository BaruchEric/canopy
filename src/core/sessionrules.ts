/** Remembered rules for agents canopy did not start: a Claude or Codex
 *  session in a terminal, whose tailchan hook asks this machine's canopy
 *  (`POST /api/remembered/check`) before it raises an ask, and whose ask a
 *  browser can answer with a remember (`POST /api/asks/answer`).
 *
 *  Only a repo's scope holds for such a session, and only for the local repo
 *  its folder is in: the same matching a run's prompts get (`ruleCovers`,
 *  then the folder and files checked on disk), fail closed. And only a
 *  `keyed` rule: one kept with an answer key the broker took. The API that
 *  keeps rules is open to every shell on the loopback, so an agent could
 *  start a run, wait for its prompt and remember `Bash` itself; a rule kept
 *  that way answers canopy's runs as before, never a terminal's session. */

import { permissionAsk } from "./claudedrive";
import { runsInside, within } from "./codexrun";
import { EDIT_TOOLS } from "./shellwords";
import { rememberOffer } from "./offer";
import { factsOf, pathsInside, rememberedFor, ruleCovers } from "./remember";
import type { PermissionAsk, RememberedRule } from "./types";

/** The deepest of `roots` holding `cwd`, or null when none does. */
export function repoHolding(roots: readonly string[], cwd: string): string | null {
  if (!cwd.startsWith("/")) return null;
  let best: string | null = null;
  for (const r of roots) if (within(cwd, r) && (best === null || r.length > best.length)) best = r;
  return best;
}

/** A session's tool call as a run's permission: Claude's tool and input, in
 *  the session's folder, so a command is judged where it runs. */
export function sessionAsk(tool: string, input: Record<string, unknown>, cwd: string): PermissionAsk {
  return { ...permissionAsk(tool, input, cwd), cwd };
}

/** The remembered rule that answers a session's call, or null: a repo rule
 *  for the local repo the session works in that covers the call by its
 *  words, and whose folder and files stay inside that repo on disk. */
export async function sessionRule(
  rules: readonly RememberedRule[],
  roots: readonly string[],
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<string | null> {
  const root = repoHolding(roots, cwd);
  if (!root || !tool) return null;
  const p = sessionAsk(tool, input, cwd);
  const facts = factsOf(p);
  const hit = rememberedFor(rules.filter((r) => r.keyed), { path: root }, p, facts, root);
  if (!hit) return null;
  const inside = (await runsInside(facts, root)) && (await pathsInside(p.paths ?? [], root, { guard: EDIT_TOOLS.has(p.tool) }));
  return inside ? hit.rule : null;
}

/** Whether `rule` may be remembered for a session's call in the repo at
 *  `root`: one the page offers for it and that covers it, as a run's
 *  remember is checked. The error says why not. */
export function sessionRemember(rule: string, p: PermissionAsk, root: string): { ok: true } | { error: string } {
  if (!rememberOffer(p, root)?.rules.includes(rule)) return { error: `canopy does not offer ${rule} for this request` };
  if (!ruleCovers(rule, p, factsOf(p), root)) return { error: `${rule} does not cover this request, so remembering it would not stop it asking` };
  return { ok: true };
}

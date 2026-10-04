/** What a remember offers for one permission, pure and browser-safe: the
 *  page shows it and the server accepts only a rule it lists, so the two
 *  agree on what can be saved. */

import { explainCommand, guardedPath, startsOutside } from "./explain";
import { EDIT_TOOLS, FILE_TOOLS, ruleOffer, type RuleOffer } from "./shellwords";
import type { PermissionAsk } from "./types";

/** The rules a remember can save for `p` in the project at `root`, or null
 *  when none is offered: a prompt marked `noRule` (a sandbox escalation, an
 *  older Codex approval, an incubator stage's run), one that starts outside
 *  the project or whose command reaches outside it, a tool covered only by
 *  its files with none named, an edit or a command that writes where code
 *  runs from, a chain canopy cannot read (a bare `Bash` would not cover
 *  it), and whatever `ruleOffer` refuses. With no
 *  `root` (a repo on another machine) the outside is left to the server,
 *  which refuses what it would not offer. */
export function rememberOffer(p: PermissionAsk, root?: string): RuleOffer | null {
  if (p.noRule) return null;
  if (startsOutside(p, root)) return null;
  if (p.tool === "Bash") {
    if (!p.command) return null;
    const read = explainCommand(p.command, root, p.cwd);
    if (read.flags.includes("outside") || read.guarded) return null;
    const offer = ruleOffer("Bash", p.command);
    if (!offer || !read.opaque) return offer;
    // code canopy cannot read: only the exact command, never a bare Bash
    if (offer.chain) return null;
    const exact = offer.rules[offer.rules.length - 1];
    return exact ? { rules: [exact], pick: 0 } : null;
  }
  if (!FILE_TOOLS.has(p.tool) || !p.paths?.length) return null;
  if (EDIT_TOOLS.has(p.tool) && p.paths.some((x) => guardedPath(x, root ?? null))) return null;
  return ruleOffer(p.tool);
}

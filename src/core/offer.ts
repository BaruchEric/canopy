/** What a remember offers for one permission, pure and browser-safe: the
 *  page shows it and the server accepts only a rule it lists, so the two
 *  agree on what can be saved. */

import { explainCommand, startsOutside } from "./explain";
import { ruleOffer, type RuleOffer } from "./shellwords";
import type { PermissionAsk } from "./types";

/** the tools a rule covers by their files, so a prompt without any is not offered */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Read", "NotebookRead", "Glob", "Grep", "LS"]);

/** The rules a remember can save for `p` in the project at `root`, or null
 *  when none is offered: a prompt marked `noRule` (a sandbox escalation, an
 *  older Codex approval, an incubator stage's run), one that starts outside
 *  the project or whose command reaches outside it, a tool covered only by
 *  its files with none named, and whatever `ruleOffer` refuses. With no
 *  `root` (a repo on another machine) the outside is left to the server,
 *  which refuses what it would not offer. */
export function rememberOffer(p: PermissionAsk, root?: string): RuleOffer | null {
  if (p.noRule) return null;
  if (startsOutside(p, root)) return null;
  if (p.tool === "Bash") {
    if (root && p.command && explainCommand(p.command, root, p.cwd).flags.includes("outside")) return null;
    return ruleOffer("Bash", p.command);
  }
  if (!FILE_TOOLS.has(p.tool) || !p.paths?.length) return null;
  return ruleOffer(p.tool);
}

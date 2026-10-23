/* Handing text to an agent already running in one of a repo's shells: the
   part of the agent buttons, review notes and the preview's picker that
   looks for a live Claude Code or Codex before anything new starts. */
import { api } from "./api";
import { agentCandidates } from "./guided";
import { typeInto } from "./liveTerms";
import type { TermTab } from "./term";

/** whether tmux says a shell runs an agent, of either harness */
export const runsAgent = async (id: string): Promise<boolean> =>
  (await api.termAgent(id).catch(() => ({ agent: null }))).agent !== null;

/** Pastes text into the first of the repo's shells that runs an agent and
 *  has a view mounted here, best candidate first, and names that shell.
 *  Pasted, not sent: the agent may be on a question of its own, where Enter
 *  would pick an answer. Null when no such shell takes it. */
export async function pasteIntoAgentShell(
  repoId: string,
  text: string,
  showing: TermTab | null,
  terms: readonly TermTab[],
): Promise<string | null> {
  for (const id of agentCandidates(showing, terms, repoId)) {
    if ((await runsAgent(id)) && typeInto(id, text)) return id;
  }
  return null;
}

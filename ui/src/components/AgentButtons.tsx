import { useEffect, useState } from "react";
import { isSeedId, SEED_RUN_NOTE } from "../../../src/core/sprout";
import { useStore } from "../store";
import { api } from "../api";
import { cardOfShell } from "../handoff";
import { backendOf, plainOf } from "../registry";
import type { Harness } from "../../../src/core/types";
import { HandoffButton } from "./Handoff";
import { devTask } from "../tasks";
import { agentCandidates, canSave, debugPrompt, devState, pendingAgent, SAVE_PROMPT, SETUP_PROMPT } from "../guided";
import { LIVE, typeInto } from "../liveTerms";
import type { TermTab } from "../term";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** how long a prompt waits for an agent shell canopy just started */
const PENDING_WAIT = 20_000;

/** the repos a prompt is on its way to, so a second click does not open a
 *  second shell while the first is still being found or started */
const asking = new Set<string>();

/** whether tmux says a shell runs an agent, of either harness */
const runsAgent = async (id: string): Promise<boolean> =>
  (await api.termAgent(id).catch(() => ({ agent: null }))).agent !== null;

/** Hands a prompt to the repo's agent. A shell already running an agent
 *  (Claude Code or Codex) gets it pasted in, not sent: the agent may be on a
 *  question of its own (the folder trust, a tool permission) where Enter
 *  would pick an answer, so the user reads it and presses Enter. A shell
 *  canopy just started with its agent is waited for rather than doubled.
 *  With neither, a new panel shell starts the agent the shell route names,
 *  with the prompt as its first message. */
export async function askAgent(repoId: string, text: string, showing: TermTab | null): Promise<void> {
  if (asking.has(repoId)) return;
  asking.add(repoId);
  try {
    const { terms, openTerm } = useStore.getState();
    for (const id of agentCandidates(showing, terms, repoId)) {
      if ((await runsAgent(id)) && typeInto(id, text)) return;
    }
    const pending = pendingAgent(terms, repoId);
    if (pending) {
      for (let waited = 0; waited < PENDING_WAIT; waited += 500) {
        await sleep(500);
        if (!useStore.getState().terms.some((t) => t.id === pending)) break;
        if (LIVE.has(pending) && (await runsAgent(pending))) {
          // an agent names its pane before its prompt reads input
          await sleep(1500);
          typeInto(pending, text);
          return;
        }
      }
      return;
    }
    openTerm(repoId, "panel", "agent", text);
  } finally {
    asking.delete(repoId);
  }
}

/** how often the showing shell is asked what agent runs in it */
const AGENT_POLL = 15_000;

/** The agent running in a shell: what its registry card says (its hooks
 *  registered it), else what tmux says of the pane, asked again now and
 *  then since an agent starts and quits inside a shell that stays. */
function useShellAgent(tab: TermTab): { harness: Harness | null; transcript: string | null } {
  const backend = backendOf(tab.id);
  const card = useStore((s) => cardOfShell(s.registry, backend, plainOf(tab.id)));
  const [pane, setPane] = useState<Harness | null>(null);
  useEffect(() => {
    if (tab.task !== undefined) return;
    let live = true;
    const ask = () =>
      api
        .termAgent(tab.id)
        .then((r) => live && setPane(r.agent))
        .catch(() => live && setPane(null));
    void ask();
    const t = setInterval(() => void ask(), AGENT_POLL);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [tab.id, tab.task]);
  const fromCard = card && card.harness !== "other" ? card.harness : null;
  return { harness: fromCard ?? pane, transcript: card?.transcript ?? null };
}

/** ▶ ■ bug ✓ on a shell's tab row, for the repo of the tab showing, and
 *  "switch to" the other harness while an agent runs in it. */
export function AgentButtons({ tab }: { tab: TermTab }) {
  const repo = useStore((s) => s.repos.find((r) => r.id === tab.repoId));
  const tasks = useStore((s) => s.tasks[tab.repoId]);
  const loadTasks = useStore((s) => s.loadTasks);
  const taskAct = useStore((s) => s.taskAct);
  const agent = useShellAgent(tab);
  useEffect(() => {
    if (tasks === undefined && repo && !repo.forge && !repo.host) loadTasks(tab.repoId).catch(() => {});
  }, [tasks, repo, tab.repoId, loadTasks]);
  if (!repo || repo.forge || repo.host) return null;
  // a seed's agents run through the incubator alone: no button here asks one
  const seed = isSeedId(tab.repoId);
  const dev = devTask(tasks ?? []);
  const state = devState(dev);
  const debug = async () => {
    if (!dev) return;
    const page = await api.taskLog(tab.repoId, dev.name).catch(() => null);
    await askAgent(tab.repoId, debugPrompt(page?.lines.filter((l) => !l.mark).map((l) => l.text) ?? []), tab);
  };
  return (
    <span className="agent-buttons">
      {state === "none" && seed ? null : state === "none" ? (
        <button type="button" className="term-new term-word" title="Ask your agent to set up a way to run this app" onClick={() => void askAgent(tab.repoId, SETUP_PROMPT, tab)}>
          set up run
        </button>
      ) : state === "running" ? (
        <button type="button" className="term-new" title={`Stop ${dev?.name ?? "the app"}`} aria-label="Stop the app" onClick={() => void taskAct(tab.repoId, "stop", dev?.name)}>
          ■
        </button>
      ) : (
        <button type="button" className="term-new" title={seed ? `Run ${dev?.name ?? "the app"}: ${SEED_RUN_NOTE}` : `Run ${dev?.name ?? "the app"}`} aria-label="Run the app" onClick={() => void taskAct(tab.repoId, "start", dev?.name)}>
          ▶
        </button>
      )}
      {!seed && (state === "running" || state === "failed") && (
        <button type="button" className="term-new" title="Ask your agent to fix the app's error, with its latest output" aria-label="Debug with your agent" onClick={() => void debug()}>
          🐞
        </button>
      )}
      {!seed && canSave(repo) && (
        <button type="button" className="term-new" title="Ask your agent to commit and push your work" aria-label="Save my work" onClick={() => void askAgent(tab.repoId, SAVE_PROMPT, tab)}>
          ✓
        </button>
      )}
      {!seed && agent.harness && tab.task === undefined && (
        <HandoffButton className="term-new term-word" repoId={tab.repoId} backend={backendOf(tab.id)} from={agent.harness} transcript={agent.transcript} term={tab.id} />
      )}
    </span>
  );
}

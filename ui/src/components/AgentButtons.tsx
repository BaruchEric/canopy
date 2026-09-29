import { useEffect } from "react";
import { useStore } from "../store";
import { api } from "../api";
import { devTask } from "../tasks";
import { canSave, claudeCandidates, debugPrompt, devState, pendingClaude, SAVE_PROMPT, SETUP_PROMPT } from "../guided";
import { LIVE, typeInto } from "../liveTerms";
import type { TermTab } from "../term";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** how long a prompt waits for a Claude shell canopy just started */
const PENDING_WAIT = 20_000;

/** the repos a prompt is on its way to, so a second click does not open a
 *  second shell while the first is still being found or started */
const asking = new Set<string>();

const runsClaude = async (id: string): Promise<boolean> =>
  (await api.termAgent(id).catch(() => ({ agent: null }))).agent === "claude";

/** Hands a prompt to Claude at this repo. A shell already running Claude
 *  gets it pasted in, not sent: Claude may be on a question of its own (the
 *  folder trust, a tool permission) where Enter would pick an answer, so the
 *  user reads it and presses Enter. A shell canopy just started with claude
 *  is waited for rather than doubled. With neither, a new panel shell starts
 *  claude with the prompt as its first message. */
export async function askClaude(repoId: string, text: string, showing: TermTab | null): Promise<void> {
  if (asking.has(repoId)) return;
  asking.add(repoId);
  try {
    const { terms, openTerm } = useStore.getState();
    for (const id of claudeCandidates(showing, terms, repoId)) {
      if ((await runsClaude(id)) && typeInto(id, text)) return;
    }
    const pending = pendingClaude(terms, repoId);
    if (pending) {
      for (let waited = 0; waited < PENDING_WAIT; waited += 500) {
        await sleep(500);
        if (!useStore.getState().terms.some((t) => t.id === pending)) break;
        if (LIVE.has(pending) && (await runsClaude(pending))) {
          // claude names its pane before its prompt reads input
          await sleep(1500);
          typeInto(pending, text);
          return;
        }
      }
      return;
    }
    openTerm(repoId, "panel", "claude", text);
  } finally {
    asking.delete(repoId);
  }
}

/** ▶ ■ bug ✓ on a shell's tab row, for the repo of the tab showing. */
export function AgentButtons({ tab }: { tab: TermTab }) {
  const repo = useStore((s) => s.repos.find((r) => r.id === tab.repoId));
  const tasks = useStore((s) => s.tasks[tab.repoId]);
  const loadTasks = useStore((s) => s.loadTasks);
  const taskAct = useStore((s) => s.taskAct);
  useEffect(() => {
    if (tasks === undefined && repo && !repo.forge && !repo.host) loadTasks(tab.repoId).catch(() => {});
  }, [tasks, repo, tab.repoId, loadTasks]);
  if (!repo || repo.forge || repo.host) return null;
  const dev = devTask(tasks ?? []);
  const state = devState(dev);
  const debug = async () => {
    if (!dev) return;
    const page = await api.taskLog(tab.repoId, dev.name).catch(() => null);
    await askClaude(tab.repoId, debugPrompt(page?.lines.filter((l) => !l.mark).map((l) => l.text) ?? []), tab);
  };
  return (
    <span className="agent-buttons">
      {state === "none" ? (
        <button type="button" className="term-new" title="Ask Claude to set up a way to run this app" onClick={() => void askClaude(tab.repoId, SETUP_PROMPT, tab)}>
          set up run
        </button>
      ) : state === "running" ? (
        <button type="button" className="term-new" title={`Stop ${dev?.name ?? "the app"}`} aria-label="Stop the app" onClick={() => void taskAct(tab.repoId, "stop", dev?.name)}>
          ■
        </button>
      ) : (
        <button type="button" className="term-new" title={`Run ${dev?.name ?? "the app"}`} aria-label="Run the app" onClick={() => void taskAct(tab.repoId, "start", dev?.name)}>
          ▶
        </button>
      )}
      {(state === "running" || state === "failed") && (
        <button type="button" className="term-new" title="Ask Claude to fix the app's error, with its latest output" aria-label="Debug with Claude" onClick={() => void debug()}>
          🐞
        </button>
      )}
      {canSave(repo) && (
        <button type="button" className="term-new" title="Ask Claude to commit and push your work" aria-label="Save my work" onClick={() => void askClaude(tab.repoId, SAVE_PROMPT, tab)}>
          ✓
        </button>
      )}
    </span>
  );
}

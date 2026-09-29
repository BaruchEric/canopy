import { useEffect } from "react";
import { useStore } from "../store";
import { api } from "../api";
import { devTask } from "../tasks";
import { canSave, claudeCandidates, debugPrompt, devState, SAVE_PROMPT, SETUP_PROMPT } from "../guided";
import { LIVE, typeInto } from "../liveTerms";
import type { TermTab } from "../term";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Types a prompt into a shell of this repo that is running Claude: the
 *  showing one, else the repo's others, else a new panel shell started with
 *  claude, typed into once the backend says claude is up. */
export async function askClaude(repoId: string, text: string, showing: TermTab | null): Promise<void> {
  const { terms, openTerm } = useStore.getState();
  for (const id of claudeCandidates(showing, terms, repoId)) {
    const { agent } = await api.termAgent(id).catch(() => ({ agent: null }));
    if (agent === "claude" && typeInto(id, text)) return;
  }
  const before = new Set(useStore.getState().terms.map((t) => t.id));
  openTerm(repoId, "panel", "claude");
  const fresh = useStore.getState().terms.find((t) => !before.has(t.id));
  if (!fresh) return;
  for (let waited = 0; waited < 20_000; waited += 500) {
    await sleep(500);
    if (!LIVE.has(fresh.id)) continue;
    const { agent } = await api.termAgent(fresh.id).catch(() => ({ agent: null }));
    if (agent !== "claude") continue;
    // claude names its pane before its prompt reads input
    await sleep(1500);
    typeInto(fresh.id, text);
    return;
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

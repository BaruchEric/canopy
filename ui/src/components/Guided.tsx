import { useEffect, useState, type RefObject } from "react";
import type { Repo } from "../../../src/core/types";
import { closedIn, useStore } from "../store";
import { devTask } from "../tasks";
import { canSave, devState, plainStatus, SAVE_PROMPT, SETUP_PROMPT } from "../guided";
import { askClaude } from "./AgentButtons";
import { PreviewSection } from "./Preview";
import { isHome } from "../registry";

export interface GuidedTargets {
  run: RefObject<HTMLButtonElement | null>;
  save: RefObject<HTMLButtonElement | null>;
}

/** The intermediate panel's body: one status line in words, the app's run
 *  and stop, save, and the way to every section. The Claude shell under it
 *  is the panel's own footer, the same element the advanced body has. */
export function GuidedPanel({ repo, onMore, targets }: { repo: Repo; onMore: () => void; targets: GuidedTargets }) {
  const tasks = useStore((s) => s.tasks[repo.id]);
  const loadTasks = useStore((s) => s.loadTasks);
  const taskAct = useStore((s) => s.taskAct);
  useEffect(() => {
    if (!repo.forge && !repo.host) loadTasks(repo.id).catch(() => {});
  }, [repo.id, repo.forge, repo.host, loadTasks]);
  const dev = devTask(tasks ?? []);
  const state = devState(dev);
  // the preview opens the first time the app is seen running here; folding
  // it again afterwards is the user's call
  const previewClosed = useStore((s) => closedIn(s, repo.id, "preview"));
  const toggleSection = useStore((s) => s.toggleSection);
  const [previewShown, setPreviewShown] = useState(false);
  useEffect(() => {
    if (state !== "running" || previewShown) return;
    setPreviewShown(true);
    if (previewClosed) toggleSection(repo.id, "preview");
  }, [state, previewShown, previewClosed, repo.id, toggleSection]);
  if (repo.forge || repo.host) {
    return (
      <div className="guided">
        <p className="guided-status">{plainStatus(repo, "none")}</p>
        <p className="panel-hint">Open this project on its own machine to work on it.</p>
      </div>
    );
  }
  return (
    <div className="guided">
      <p className="guided-status">{plainStatus(repo, state)}</p>
      <div className="guided-actions">
        {state === "none" ? (
          <button ref={targets.run} type="button" className="guided-btn" onClick={() => void askClaude(repo.id, SETUP_PROMPT, null)}>
            Set up run
          </button>
        ) : state === "running" ? (
          <button ref={targets.run} type="button" className="guided-btn" onClick={() => void taskAct(repo.id, "stop", dev?.name)}>
            Stop
          </button>
        ) : (
          <button ref={targets.run} type="button" className="guided-btn primary" onClick={() => void taskAct(repo.id, "start", dev?.name)}>
            Run my app
          </button>
        )}
        <button
          ref={targets.save}
          type="button"
          className="guided-btn"
          disabled={!canSave(repo)}
          title={canSave(repo) ? "Claude commits and pushes your work" : "nothing to save"}
          onClick={() => void askClaude(repo.id, SAVE_PROMPT, null)}
        >
          Save my work
        </button>
        <span className="spacer" />
        <button type="button" className="mini" onClick={onMore}>
          show more
        </button>
      </div>
      {state === "running" && isHome(repo.id) && <PreviewSection repo={repo} />}
    </div>
  );
}

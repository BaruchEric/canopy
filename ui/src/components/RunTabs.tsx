import { useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { RUN_NAME_MAX, nameFailure, runTitle } from "../../../src/core/runname";
import { isSeedId } from "../../../src/core/sprout";
import type { Repo, Run } from "../../../src/core/types";
import { isCoordinator } from "../coord";
import { ownRun } from "../flows";
import { runWord } from "../runs";
import { runsFor, useStore } from "../store";

/** What the row is at. One value, so a field cannot be open while a chat
 *  starts, and a save always has the name it is saving. */
type Mode =
  | { kind: "tabs"; error: string | null }
  | { kind: "naming"; draft: string; error: string | null }
  | { kind: "saving"; draft: string }
  | { kind: "starting" };

const TABS: Mode = { kind: "tabs", error: null };

/** what a tab says when the pointer rests on it: the run's verb and state, then what was asked */
const tabTitle = (run: Run): string => `${run.verb}: ${runWord(run, true)}${run.note ? `\n${run.note}` : ""}`;

/**
 * The runs going on a run's repo, as a row of tabs under the console's
 * head (FR-073). A repo takes several runs at once, so the row is how a
 * person tells them apart and moves between them.
 *
 * This run's tab holds the name it goes by: the one canopy cut from its
 * first message, the one a small model wrote for it, or the user's own. A
 * press on it opens a field to rename the run while the run is live. Every
 * other tab shows that run, and "+ chat" starts another chat on the repo.
 * `solo` is a console in a window of its own (a popped-out chat, a shell
 * window's tab), which has nowhere to show another run: it keeps this
 * run's tab alone.
 *
 * Nothing shows for a coordinator (it holds no repo and takes no name), a
 * flow's step (its flow names it), or an ended run with no name and no
 * run going beside it.
 */
export function RunTabs({ run, repo, solo = false }: { run: Run; repo: Repo | undefined; solo?: boolean }) {
  const live = useStore(useShallow((s) => runsFor(s, run.repoId)));
  const own = useStore((s) => ownRun(s.flowRuns, run));
  const showRun = useStore((s) => s.showRun);
  const openChat = useStore((s) => s.openChat);
  const renameRun = useStore((s) => s.renameRun);
  const [mode, setMode] = useState<Mode>(TABS);

  if (isCoordinator(run) || !own) return null;
  const mine = live.some((r) => r.id === run.id);
  const canName = mine && !run.kept;
  const others = solo ? [] : live.filter((r) => r.id !== run.id);
  // another chat starts where a chat can: a local repo that is no seed
  const canChat = !solo && repo !== undefined && !repo.host && !repo.forge && !repo.archived && !isSeedId(run.repoId);
  if (others.length === 0 && !canName && !run.name) return null;

  const words = (e: unknown): string => String(e instanceof Error ? e.message : e);
  const save = (e: FormEvent, draft: string) => {
    e.preventDefault();
    const name = draft.trim();
    // nothing typed, or the same name: the field closes and nothing is sent
    if (!name || name === run.name) return setMode(TABS);
    setMode({ kind: "saving", draft });
    renameRun(run.id, name).then(
      () => setMode(TABS),
      (err: unknown) => setMode({ kind: "naming", draft, error: nameFailure(words(err)) }),
    );
  };
  const another = () => {
    setMode({ kind: "starting" });
    openChat(run.repoId, "", true).then(
      () => setMode(TABS),
      (err: unknown) => setMode({ kind: "tabs", error: words(err) }),
    );
  };
  const field = mode.kind === "naming" || mode.kind === "saving" ? mode : null;
  const saving = mode.kind === "saving";
  const error = mode.kind === "tabs" || mode.kind === "naming" ? mode.error : null;

  const face = (r: Run) => (
    <>
      <span className="dot" aria-hidden="true" />
      <span className="rtab-name">{runTitle(r)}</span>
    </>
  );

  return (
    <nav className="run-tabs no-autofocus" aria-label="Runs going on this repo">
      {field ? (
        <form className="rtab-edit" onSubmit={(e) => save(e, field.draft)}>
          <input
            className="settings-input"
            aria-label="This run's name"
            placeholder="a name for this run"
            value={field.draft}
            maxLength={RUN_NAME_MAX}
            disabled={saving}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setMode({ kind: "naming", draft: e.target.value, error: null })}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              // the field's own Escape: the sheet under it stays open
              e.stopPropagation();
              e.preventDefault();
              setMode(TABS);
            }}
          />
          <button type="submit" className="mini strong" disabled={saving || !field.draft.trim()}>
            {saving ? "saving…" : "save"}
          </button>
          <button type="button" className="mini" disabled={saving} onClick={() => setMode(TABS)}>
            cancel
          </button>
        </form>
      ) : canName ? (
        <button
          type="button"
          className={`rtab on st-${run.status}`}
          aria-current="true"
          title={`Rename this run\n${tabTitle(run)}`}
          onClick={() => setMode({ kind: "naming", draft: run.name ?? "", error: null })}
        >
          {face(run)}
          <span className="rtab-pen" aria-hidden="true">✎</span>
        </button>
      ) : (
        <span className={`rtab on st-${run.status}`} aria-current="true" title={tabTitle(run)}>
          {face(run)}
        </span>
      )}
      {others.map((r) => (
        <button key={r.id} type="button" className={`rtab st-${r.status}`} title={`Show this run\n${tabTitle(r)}`} onClick={() => showRun(r.id)}>
          {face(r)}
        </button>
      ))}
      {canChat && !field && (
        <button type="button" className="rtab add" disabled={mode.kind === "starting"} title="Start another chat on this repo, beside the runs going" onClick={another}>
          {mode.kind === "starting" ? "starting…" : "+ chat"}
        </button>
      )}
      {error && (
        <span className="run-tabs-err" role="alert">
          {error}
        </span>
      )}
    </nav>
  );
}

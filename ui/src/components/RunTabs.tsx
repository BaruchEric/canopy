import { useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { RUN_NAME_MAX, nameFailure, runTitle } from "../../../src/core/runname";
import { SIDE_WORD } from "../../../src/core/sidequestion";
import { isSeedId } from "../../../src/core/sprout";
import type { Repo, Run } from "../../../src/core/types";
import { isCoordinator } from "../coord";
import { ownRun } from "../flows";
import { runWord } from "../runs";
import { ownBranchBeside, runsFor, useStore } from "../store";
import { useLacks } from "../useLacks";

/** What the row is at. One value, so a field cannot be open while a chat
 *  starts, and a save always has the name it is saving. */
type Mode =
  | { kind: "tabs"; error: string | null }
  | { kind: "naming"; draft: string; error: string | null }
  | { kind: "saving"; draft: string }
  | { kind: "starting" };

const TABS: Mode = { kind: "tabs", error: null };

/** what a tab says when the pointer rests on it: the run's verb and state,
 *  then what was asked; a side question says what it started from (FR-077) */
const tabTitle = (run: Run): string =>
  `${run.verb}: ${runWord(run, true)}${run.sideOf ? `\na side question, started from: ${run.sideOf.title}` : ""}${run.note ? `\n${run.note}` : ""}`;

/**
 * The runs going on a run's repo, as a row of tabs under the console's
 * head (FR-073). A repo takes several runs at once, so the row is how a
 * person tells them apart and moves between them.
 *
 * This run's tab holds the name it goes by: the one canopy cut from its
 * first message, the one a small model wrote for it, or the user's own. A
 * press on it opens a field to rename the run while the run is live. Every
 * other tab shows that run, and "+ chat" starts another chat on the repo
 * and shows it. On the page a run is shown where the store shows one (its
 * docked panel, else the sheet over the page). A window of its own
 * (`?view=run`) has no sheet, so it passes `go`, its own way to another run.
 *
 * Nothing shows for a coordinator (it holds no repo and takes no name), a
 * flow's step (its flow names it), or an ended run with no name and no
 * run going beside it.
 */
export function RunTabs({ run, repo, go }: { run: Run; repo: Repo | undefined; go?: ((runId: string) => void) | undefined }) {
  const live = useStore(useShallow((s) => runsFor(s, run.repoId)));
  const own = useStore((s) => ownRun(s.flowRuns, run));
  const showRun = useStore((s) => s.showRun);
  // the side question on show beside this run, whose tab closes its column
  const sideOn = useStore((s) => s.sideShown[run.id]);
  const showSide = useStore((s) => s.showSide);
  const openSide = useStore((s) => s.openSide);
  const openChat = useStore((s) => s.openChat);
  const renameRun = useStore((s) => s.renameRun);
  const plan = useStore((s) => s.plan);
  const beside = useStore((s) => repo !== undefined && ownBranchBeside(s, repo));
  const [mode, setMode] = useState<Mode>(TABS);
  // a viewer moves between the tabs and names or starts nothing (FR-074)
  const reads = useLacks(run.repoId, "operate");

  if (isCoordinator(run) || !own) return null;
  const mine = live.some((r) => r.id === run.id);
  const canName = mine && !run.kept && !reads;
  const others = live.filter((r) => r.id !== run.id);
  const show = go ?? showRun;
  // another chat starts where a chat can: a local repo that is no seed
  const canChat = !reads && repo !== undefined && !repo.host && !repo.forge && !repo.archived && !isSeedId(run.repoId);
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
  // FR-080: on the page a chat beside what is going in the checkout opens
  // the pre-flight, its branch box ticked. A window of its own has no sheet
  // for that, so there the chat starts in the checkout.
  const asks = beside && !go;
  const another = () => {
    if (asks) return plan(run.repoId, "chat");
    setMode({ kind: "starting" });
    openChat(run.repoId, "", true).then(
      (id) => {
        setMode(TABS);
        // the page shows a chat it starts; a window of its own goes to it
        go?.(id);
      },
      (err: unknown) => setMode({ kind: "tabs", error: words(err) }),
    );
  };
  const field = mode.kind === "naming" || mode.kind === "saving" ? mode : null;
  const saving = mode.kind === "saving";
  const error = mode.kind === "tabs" || mode.kind === "naming" ? mode.error : null;

  const face = (r: Run) => (
    <>
      <span className="dot" aria-hidden="true" />
      {r.sideOf && <span className="rtab-side">{SIDE_WORD}</span>}
      <span className="rtab-name">{runTitle(r)}</span>
    </>
  );
  // a side question's tab shows it beside the run it was asked of, and
  // puts it away again when that is this run and it is on show
  const other = (r: Run) => {
    if (!r.sideOf) return { title: `Show this run\n${tabTitle(r)}`, press: () => show(r.id), shown: false };
    if (sideOn === r.id) return { title: `Put this side question away; its chat stays open\n${tabTitle(r)}`, press: () => showSide(run.id, null), shown: true };
    // this run's own side question shows beside it, here; another run's
    // shows beside that run
    const ofThis = r.sideOf.run === run.id;
    return { title: `Show this side question beside its run\n${tabTitle(r)}`, press: () => (ofThis ? showSide(run.id, r.id) : (go ?? openSide)(r.id)), shown: false };
  };

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
      {others.map((r) => {
        const tab = other(r);
        return (
          <button key={r.id} type="button" className={`rtab st-${r.status}${tab.shown ? " beside" : ""}`} title={tab.title} onClick={tab.press} {...(r.sideOf ? { "aria-pressed": tab.shown } : {})}>
            {face(r)}
          </button>
        );
      })}
      {canChat && !field && (
        <button type="button" className="rtab add" disabled={mode.kind === "starting"} title={asks ? "Start another chat on this repo: in a worktree of its own, or beside the runs going" : "Start another chat on this repo, beside the runs going"} onClick={another}>
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

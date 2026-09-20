import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FILTER_INFO, type RepoFilter } from "../filters";
import { PICK_FACETS, pickState, pickWhere, type PickState } from "../select";
import { pickableIds, pickedIds, useStore, visibleRepos } from "../store";

/** A tri-state tick: a checkbox that can also say "some". It swallows its
 *  click so the card or heading it sits in does not act on it too. */
export function Tick({ state, label, onClick }: { state: PickState; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
      aria-label={label}
      title={label}
      className={`tick tick-btn ${state}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {state === "all" ? "✓" : state === "some" ? "–" : ""}
    </button>
  );
}

/** The bar along the bottom in select mode: a master tick and count, the
 *  all/none/invert buttons and a facet picker on the left, a workflow picker
 *  and start on the right. The picker lists the bundled and user workflows,
 *  loaded into the store through the first visible repo since the list is
 *  the same for all. */
export function SelectBar() {
  const selecting = useStore((s) => s.selecting);
  const picked = useStore(useShallow(pickedIds));
  const pickable = useStore(useShallow(pickableIds));
  const visible = useStore(useShallow(visibleRepos));
  const setSelecting = useStore((s) => s.setSelecting);
  const planFleet = useStore((s) => s.planFleet);
  const pickAll = useStore((s) => s.pickAll);
  const pickNone = useStore((s) => s.pickNone);
  const pickInvert = useStore((s) => s.pickInvert);
  const pickFacet = useStore((s) => s.pickFacet);
  const loadWorkflows = useStore((s) => s.loadWorkflows);
  const first = pickable[0];
  const list = useStore(
    useShallow((s) => (first ? (s.workflows[first] ?? []) : []).filter((e) => e.ok && e.workflow.source !== "repo")),
  );
  const [workflow, setWorkflow] = useState("");
  // how many repos each facet would pick, so the menu says which are worth a click
  const facetCounts = useMemo(
    () => new Map<RepoFilter, number>(PICK_FACETS.map((f) => [f, pickWhere(visible, f).length])),
    [visible],
  );
  useEffect(() => {
    if (!selecting || !first) return;
    void loadWorkflows(first);
  }, [selecting, first, loadWorkflows]);
  useEffect(() => {
    const firstOk = list[0];
    if (firstOk?.ok && !workflow) setWorkflow(firstOk.workflow.name);
  }, [list, workflow]);
  if (!selecting) return null;
  const state = pickState(picked, pickable);
  return (
    <div className="select-bar" role="toolbar" aria-label="Fleet">
      <Tick
        state={state}
        label={state === "all" ? "Unpick every repo in view" : "Pick every repo in view"}
        onClick={state === "all" ? pickNone : pickAll}
      />
      <span className="select-count">
        {picked.length} of {pickable.length} repos
      </span>
      <button type="button" className="mini" disabled={state === "all"} onClick={pickAll} title="Every repo the filters show, folded groups included">
        all
      </button>
      <button type="button" className="mini" disabled={state === "none"} onClick={pickNone}>
        none
      </button>
      <button type="button" className="mini" disabled={!pickable.length} onClick={pickInvert} title="The repos in view that are not picked, and only those">
        invert
      </button>
      <select
        className="select-wf"
        value=""
        aria-label="Pick just the repos in one state"
        title="Pick just the repos in view in one state"
        onChange={(e) => {
          const facet = PICK_FACETS.find((f) => f === e.target.value);
          if (facet) pickFacet(facet);
        }}
      >
        <option value="">only…</option>
        {PICK_FACETS.map((f) => (
          <option key={f} value={f} disabled={!facetCounts.get(f)}>
            {FILTER_INFO[f].label} ({facetCounts.get(f) ?? 0})
          </option>
        ))}
      </select>
      <span className="select-hint">shift-click for a range · ⌘A for all · esc to leave</span>
      <span className="spacer" />
      <select className="select-wf" value={workflow} onChange={(e) => setWorkflow(e.target.value)} aria-label="Workflow">
        {list.map((e) => e.ok && <option key={e.workflow.name} value={e.workflow.name}>{e.workflow.label}</option>)}
      </select>
      <button type="button" className="mini strong" disabled={!picked.length || !workflow} onClick={() => planFleet(workflow)}>
        run on {picked.length}…
      </button>
      <button type="button" className="mini" onClick={() => setSelecting(false)}>done</button>
    </div>
  );
}

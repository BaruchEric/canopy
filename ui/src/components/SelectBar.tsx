import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore, visibleRepos } from "../store";
import { selectable } from "../flows";
import { api } from "../api";
import type { WorkflowEntry } from "../../../src/core/types";

/** The bar along the bottom in select mode: the count, a workflow picker,
 *  and start. The picker lists the bundled and user workflows, fetched
 *  through the first visible repo since the list is the same for all. */
export function SelectBar() {
  const selecting = useStore((s) => s.selecting);
  const selected = useStore((s) => s.selected);
  const setSelecting = useStore((s) => s.setSelecting);
  const planFleet = useStore((s) => s.planFleet);
  const visible = useStore(useShallow((s) => selectable(visibleRepos(s)).map((r) => r.id)));
  const setSelected = useStore((s) => s.setSelected);
  const [list, setList] = useState<WorkflowEntry[]>([]);
  const [workflow, setWorkflow] = useState("");
  useEffect(() => {
    if (!selecting || !visible[0]) return;
    let live = true;
    void api.workflows(visible[0]).then((l) => {
      if (!live) return;
      const ok = l.filter((e) => e.ok && e.workflow.source !== "repo");
      setList(ok);
      const first = ok[0];
      if (first?.ok && !workflow) setWorkflow(first.workflow.name);
    });
    return () => {
      live = false;
    };
  }, [selecting, visible[0]]);
  if (!selecting) return null;
  return (
    <div className="select-bar" role="toolbar" aria-label="Fleet">
      <span className="select-count">
        {selected.length} of {visible.length} repos
      </span>
      <button type="button" className="mini" onClick={() => setSelected(visible)}>all in view</button>
      <button type="button" className="mini" onClick={() => setSelected([])}>none</button>
      <span className="spacer" />
      <select className="select-wf" value={workflow} onChange={(e) => setWorkflow(e.target.value)} aria-label="Workflow">
        {list.map((e) => e.ok && <option key={e.workflow.name} value={e.workflow.name}>{e.workflow.label}</option>)}
      </select>
      <button type="button" className="mini strong" disabled={!selected.length || !workflow} onClick={() => planFleet(workflow)}>
        run on {selected.length}…
      </button>
      <button type="button" className="mini" onClick={() => setSelecting(false)}>done</button>
    </div>
  );
}

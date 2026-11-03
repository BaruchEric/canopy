/** The run sheet's work block (FR-037): under a branch run's branch line,
 *  the item the branch serves, its two newest lines and the box for a new
 *  one. The item's sheet opens from the title. */

import type { Run } from "../../../src/core/types";
import { backendOf, qual } from "../registry";
import { useStore } from "../store";
import { LastNotes, NoteBox } from "./Work";

export function WorkBlock({ run }: { run: Run }) {
  const work = run.branch?.work;
  const backend = backendOf(run.id);
  const item = useStore((s) => (work ? s.work[backend]?.items.find((i) => i.id === work) : undefined));
  const showWork = useStore((s) => s.showWork);
  if (!work || !item) return null;
  const id = qual(backend, item.id);
  return (
    <div className="run-work">
      <div className="run-work-head">
        <span className="run-work-word">work</span>
        <button type="button" className="work-title" title={`Open ${item.id} with every note`} onClick={() => showWork(id)}>
          {item.title}
        </button>
        <span className={`work-state ${item.state === "working" ? "sky" : item.state === "review" ? "lichen" : item.state === "landed" ? "moss" : ""}`}>{item.state}</span>
      </div>
      <LastNotes item={item} />
      <NoteBox id={id} compact />
    </div>
  );
}

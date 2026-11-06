/** The work view (FR-037): every shown backend's items by state, the ones
 *  that need Eric first, with a repo filter and a search. An item's sheet is
 *  `WorkSheet.tsx`; the model is pure `ui/src/work.ts`. */

import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { qual } from "../registry";
import { useStore } from "../store";
import { ago } from "../util";
import { onRepo, reposOf, searchWork, STATE_TONE, workRows, workSections, type WorkRow } from "../work";
import { Links, useRepoNames, whereWord } from "./WorkSheet";

function Row({ row, nameOf }: { row: WorkRow; nameOf: (id: string) => string }) {
  const showWork = useStore((s) => s.showWork);
  const { backend, item } = row;
  const newest = item.notes.at(-1);
  const tone = row.needs !== null ? "rust" : STATE_TONE[item.state];
  return (
    <li className={`work-row${tone ? ` ${tone}` : ""}`}>
      <div className="work-main">
        <button type="button" className="work-title" title="Open the item with every note" onClick={() => showWork(qual(backend, item.id))}>
          {item.title}
        </button>
        <span className="work-facts">
          <span className={`work-state ${tone}`}>{item.state}</span>
          <span>{item.repos.map((id) => nameOf(qual(backend, id))).join(", ")}</span>
          <Links backend={backend} item={item} />
          <span className="work-id">{whereWord(backend, item.id)}</span>
        </span>
      </div>
      {row.needs !== null && <p className="work-needs">{row.needs}</p>}
      {newest && (
        <p className="work-last">
          <span className="work-note-by">{newest.by}</span> {newest.text} <span className="work-note-when">{ago(newest.at / 1000)}</span>
        </p>
      )}
    </li>
  );
}

/** The work view: items by state across the shown backends, Needs you
 *  first, the landed and dropped of the last 30 days folded at the end. */
export function WorkView() {
  const { work, landing, triggers, order } = useStore(useShallow((s) => ({ work: s.work, landing: s.landing, triggers: s.triggers, order: s.backendOrder })));
  const nameOf = useRepoNames();
  const [repo, setRepo] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => workRows(work, order, { landing, triggers, qual }), [work, order, landing, triggers]);
  const repos = useMemo(() => reposOf(rows, qual), [rows]);
  const shown = useMemo(() => searchWork(onRepo(rows, repos.includes(repo ?? "") ? repo : null, qual), query), [rows, repos, repo, query]);
  const sections = useMemo(() => workSections(shown), [shown]);
  const any = order.some((b) => work[b] !== undefined);
  return (
    <main className="health-view work-view">
      <div className="work-bar">
        <input type="search" className="work-search" value={query} placeholder="search titles and notes" aria-label="Search the work items" onChange={(e) => setQuery(e.target.value)} />
        <select className="work-repo" value={repo ?? ""} aria-label="Only one repo's items" onChange={(e) => setRepo(e.target.value || null)}>
          <option value="">every repo</option>
          {repos.map((id) => (
            <option key={id} value={id}>
              {nameOf(id)}
            </option>
          ))}
        </select>
        <span className="work-count">{shown.length === 1 ? "1 item" : `${shown.length} items`}</span>
      </div>
      {!any && (
        <section className="work-group">
          <h3 className="panel-label">Work</h3>
          <p className="work-empty">No work ledger yet. Every branch run starts an item here, named in its branch and carried on its commits as a <code>Canopy-Work:</code> trailer; the landing queue, PR watch, triggers and the agents' closing handoffs add lines as it moves.</p>
        </section>
      )}
      {any && sections.length === 0 && (
        <section className="work-group">
          <h3 className="panel-label">Work</h3>
          <p className="work-empty">{rows.length === 0 ? "No work items yet; a branch run starts one." : "Nothing matches."}</p>
        </section>
      )}
      {sections.map((s) =>
        s.folded ? (
          <details key={s.key} className="work-group">
            <summary className="panel-label">
              {s.title} <span className="work-count">{s.rows.length}</span>
            </summary>
            <ul>
              {s.rows.map((row) => (
                <Row key={`${row.backend}:${row.item.id}`} row={row} nameOf={nameOf} />
              ))}
            </ul>
          </details>
        ) : (
          <section key={s.key} className="work-group">
            <h3 className="panel-label">
              {s.title} <span className="work-count">{s.rows.length}</span>
            </h3>
            <ul>
              {s.rows.map((row) => (
                <Row key={`${row.backend}:${row.item.id}`} row={row} nameOf={nameOf} />
              ))}
            </ul>
          </section>
        ),
      )}
    </main>
  );
}

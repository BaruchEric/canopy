import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { countFacets, FILTER_INFO, REPO_FILTERS } from "../filters";
import { activeFilterCount, archivedCount, scopedRepos, useStore } from "../store";
import { useFitPop } from "../pop";

/** Toggleable facet chips behind one pill. The pill counts what is lit so a
 *  narrowed grove never looks like a small one. */
export function FilterMenu() {
  const repos = useStore(useShallow(scopedRepos));
  const filters = useStore((s) => s.filters);
  const users = useStore((s) => s.users);
  const toggleFilter = useStore((s) => s.toggleFilter);
  const toggleUser = useStore((s) => s.toggleUser);
  const clearFilters = useStore((s) => s.clearFilters);
  const active = useStore(activeFilterCount);
  const archived = useStore(archivedCount);
  const hideArchived = useStore((s) => s.settings.hideArchived);
  const setSetting = useStore((s) => s.setSetting);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);
  const facets = useMemo(() => countFacets(repos), [repos]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="settings" ref={ref}>
      <button
        id="filters-btn"
        type="button"
        className={active > 0 ? "pill on" : "pill"}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Filter by status or by the identity a repo commits as (f)"
        onClick={() => setOpen(!open)}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 5h18l-7 8v6l-4 2v-8z" />
        </svg>
        {active === 0 ? "filters" : `${active} filter${active === 1 ? "" : "s"}`}
      </button>
      {open && (
        <div className="settings-pop filters-pop" role="dialog" aria-label="Filters">
          <section className="settings-row">
            <h3 className="panel-label">
              status
              {active > 0 && (
                <button type="button" className="mini" onClick={clearFilters}>
                  clear
                </button>
              )}
            </h3>
            <div className="chips" role="group" aria-label="Status filters">
              {REPO_FILTERS.map((f) => {
                const on = filters.includes(f);
                const n = facets.filters[f];
                return (
                  <button
                    key={f}
                    type="button"
                    className={on ? "chip on" : "chip"}
                    aria-pressed={on}
                    title={FILTER_INFO[f].title}
                    disabled={n === 0 && !on}
                    onClick={() => toggleFilter(f)}
                  >
                    {FILTER_INFO[f].label}
                    <span className="chip-n">{n}</span>
                  </button>
                );
              })}
            </div>
            <p className="settings-hint">
              Lit chips add up: a repo shows when it matches any of them.
            </p>
          </section>
          <section className="settings-row">
            <h3 className="panel-label">archived</h3>
            <div className="chips" role="group" aria-label="Archived repos">
              <button
                type="button"
                className={hideArchived ? "chip on" : "chip"}
                aria-pressed={hideArchived}
                title="Leave the repos archived from a card's menu off the board"
                onClick={() => setSetting("hideArchived", !hideArchived)}
              >
                hide archived
                <span className="chip-n">{archived}</span>
              </button>
            </div>
          </section>
          {facets.users.length > 1 && (
            <section className="settings-row">
              <h3 className="panel-label">commits as</h3>
              <div className="chips" role="group" aria-label="Git identity filters">
                {facets.users.map((u) => {
                  const on = users.includes(u.key);
                  return (
                    <button
                      key={u.key}
                      type="button"
                      className={on ? "chip on" : "chip"}
                      aria-pressed={on}
                      title={u.email || undefined}
                      onClick={() => toggleUser(u.key)}
                    >
                      {u.label}
                      <span className="chip-n">{u.count}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

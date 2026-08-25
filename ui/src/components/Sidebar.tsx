import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { groupRepos } from "../grouping";
import { useStore, visibleRepos } from "../store";
import { GLYPH, stateOf } from "../util";

export function Sidebar() {
  const repos = useStore(useShallow(visibleRepos));
  const sort = useStore((s) => s.settings.sort);
  const openRepo = useStore((s) => s.openRepo);

  const groups = useMemo(() => groupRepos(repos, sort), [repos, sort]);

  return (
    <aside className="sidebar" aria-label="Repository tree">
      {groups.map(({ key, label, repos: members }) => {
        const dirty = members.filter(
          (r) => (r.status?.files.length ?? 0) > 0,
        ).length;
        return (
          <section key={key} className="tree-group">
            <h2 className="tree-head">
              <span className="head-name">{label}</span>
              <span className="tree-counts">
                {dirty > 0 && <em className="c-dirty">{dirty}●</em>}
                <span>{members.length}</span>
              </span>
            </h2>
            <ul className="tree-list">
              {members.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className={`tree-item s-${stateOf(r)}`}
                    onClick={(e) => openRepo(r.id, e)}
                    onAuxClick={(e) => {
                      if (e.button === 1) openRepo(r.id, { metaKey: true });
                    }}
                    title={r.id}
                  >
                    <span className="glyph">{GLYPH[stateOf(r)]}</span>
                    <span className="tree-name">{r.name}</span>
                    {(r.status?.files.length ?? 0) > 0 && (
                      <span className="tree-n">{r.status?.files.length}</span>
                    )}
                    {(r.status?.ahead ?? 0) > 0 && (
                      <span className="tree-ahead">↑{r.status?.ahead}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {groups.length === 0 && (
        <p className="empty">
          Nothing matches. Clear the filter or turn off "needs attention".
        </p>
      )}
    </aside>
  );
}

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore, visibleRepos } from "../store";
import { GLYPH, stateOf } from "../util";

export function Sidebar() {
  const repos = useStore(useShallow(visibleRepos));
  const openPanel = useStore((s) => s.openPanel);

  const groups = useMemo(() => {
    const m = new Map<string, typeof repos>();
    for (const r of repos) {
      const g = r.group || ".";
      const arr = m.get(g) ?? [];
      arr.push(r);
      m.set(g, arr);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [repos]);

  return (
    <aside className="sidebar" aria-label="Repository tree">
      {groups.map(([group, members]) => {
        const dirty = members.filter(
          (r) => (r.status?.files.length ?? 0) > 0,
        ).length;
        return (
          <section key={group} className="tree-group">
            <h2 className="tree-head">
              {group}
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
                    onClick={() => openPanel(r.id)}
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

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { groupRepos, sectionKey } from "../grouping";
import { useStore, visibleRepos } from "../store";
import { GLYPH, stateOf } from "../util";
import { GroupHead } from "./GroupHead";

export function Sidebar() {
  const repos = useStore(useShallow(visibleRepos));
  const sort = useStore((s) => s.settings.sort);
  const openRepo = useStore((s) => s.openRepo);
  const collapsed = useStore((s) => s.collapsed);
  const toggleGroup = useStore((s) => s.toggleGroup);

  const groups = useMemo(() => groupRepos(repos, sort), [repos, sort]);

  return (
    <aside id="sidebar" className="sidebar" aria-label="Repository tree">
      {groups.map(({ key, label, hint, repos: members }) => {
        const dirty = members.filter(
          (r) => (r.status?.files.length ?? 0) > 0,
        ).length;
        const id = sectionKey(sort, key);
        const open = !collapsed.includes(id);
        return (
          <section key={key} className="tree-group">
            <GroupHead
              className="tree-head"
              label={label}
              hint={hint}
              open={open}
              onToggle={() => toggleGroup(id)}
            >
              <span className="tree-counts">
                {dirty > 0 && <em className="c-dirty">{dirty}●</em>}
                <span>{members.length}</span>
              </span>
            </GroupHead>
            {open && (
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
                      {r.host && <span className="host-tag">{r.host}</span>}
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
            )}
          </section>
        );
      })}
      {groups.length === 0 && (
        <p className="empty">
          Nothing matches. Clear the filters or turn off "needs attention".
        </p>
      )}
    </aside>
  );
}

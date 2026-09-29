import { memo, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { pickable } from "../flows";
import { peerWipCounts } from "../peers";
import { groupRepos, sectionKey } from "../grouping";
import { pickCount, pickState } from "../select";
import { boardChangedAt, boardFavorite, cardOf, isFavorite, idText, multi, useStore, visibleCards, visibleRepos } from "../store";
import { backendOf } from "../registry";
import { GLYPH, stateOf } from "../util";
import { GroupHead } from "./GroupHead";
import { Tick } from "./SelectBar";
import type { Repo } from "../../../src/core/types";

/** One row of the tree. In select mode it picks the repo like the card
 *  does, shift included, instead of opening it. */
const TreeItem = memo(function TreeItem({ repo }: { repo: Repo }) {
  const openRepo = useStore((s) => s.openRepo);
  const selecting = useStore((s) => s.selecting);
  const picked = useStore((s) => s.selected.includes(repo.id));
  const toggleSelected = useStore((s) => s.toggleSelected);
  const card = useStore((s) => (multi(s) ? cardOf(s, repo.id) : undefined));
  const favorite = useStore((s) => isFavorite(s, repo.id));
  const canPick = pickable(repo);
  const state = stateOf(repo);
  return (
    <button
      type="button"
      className={`tree-item s-${state}${selecting && picked ? " picked" : ""}${selecting && !canPick ? " unpickable" : ""}`}
      role={selecting ? "checkbox" : undefined}
      aria-checked={selecting ? picked : undefined}
      aria-disabled={selecting && !canPick ? true : undefined}
      onClick={(e) => {
        if (selecting) toggleSelected(repo.id, e.shiftKey);
        else openRepo(repo.id, e);
      }}
      onAuxClick={(e) => {
        if (!selecting && e.button === 1) openRepo(repo.id, { metaKey: true });
      }}
      title={selecting && !canPick ? `${repo.name} cannot join a fleet` : idText(repo.id)}
    >
      {selecting && (
        <span className={`tick${picked ? " on" : ""}`} aria-hidden="true">
          {picked ? "✓" : ""}
        </span>
      )}
      <span className="glyph">{GLYPH[state]}</span>
      <span className="tree-name">{repo.name}</span>
      {favorite && (
        <span className="tree-star" title="A favorite">
          ★
        </span>
      )}
      {repo.host && <span className="host-tag">{repo.host}</span>}
      {repo.archived && (
        <span className="host-tag archived" title={repo.archived === "github" ? "archived on GitHub" : "archived in canopy"}>
          archived
        </span>
      )}
      {(repo.status?.files.length ?? 0) > 0 && (
        <span className="tree-n">{repo.status?.files.length}</span>
      )}
      {peerWipCounts(repo.peers).map((c) => (
        <span key={c.peer} className="tree-peer" title={c.title}>
          {c.text}
        </span>
      ))}
      {(repo.status?.ahead ?? 0) > 0 && (
        <span className="tree-ahead">↑{repo.status?.ahead}</span>
      )}
      {card && (
        <span className="tree-machines" title={`checked out on ${card.checkouts.map((c) => backendOf(c.id)).join(", ")}`}>
          {card.checkouts.map((c) => backendOf(c.id)).join(" ")}
        </span>
      )}
    </button>
  );
});

/** A tree heading's tick and count in select mode, the same `picked/total`
 *  the grid heading says. */
function TreePick({ label, ids, total }: { label: string; ids: string[]; total: number }) {
  const state = useStore((s) => pickState(s.selected, ids));
  const n = useStore((s) => pickCount(s.selected, ids));
  const pickGroup = useStore((s) => s.pickGroup);
  return (
    <>
      {ids.length > 0 && (
        <Tick
          state={state}
          label={state === "all" ? `Unpick every repo in ${label}` : `Pick every repo in ${label}`}
          onClick={() => pickGroup(ids)}
        />
      )}
      <span className="c-picked" title={`${n} of ${ids.length} picked`}>
        {n}/{total}
      </span>
    </>
  );
}

/** The repo tree: a column beside the cards, or with `drawer` the same tree
 *  sliding over the page where there is no room for the column. */
export function Sidebar({ drawer = false }: { drawer?: boolean }) {
  const repos = useStore(useShallow(visibleRepos));
  const setDrawer = useStore((s) => s.setDrawer);
  const cards = useStore(useShallow(visibleCards));
  const many = useStore(multi);
  const sort = useStore((s) => s.settings.sort);
  const collapsed = useStore((s) => s.collapsed);
  const toggleGroup = useStore((s) => s.toggleGroup);
  const selecting = useStore((s) => s.selecting);

  // the same `at` the grid groups by, so a heading means the same in both
  const groups = useMemo(
    () => groupRepos(
        repos,
        sort,
        undefined,
        many && cards.length > 0 ? boardChangedAt(useStore.getState()) : undefined,
        many && cards.length > 0 ? boardFavorite(useStore.getState()) : undefined,
      ),
    [repos, cards, many, sort],
  );

  return (
    <aside
      id="sidebar"
      className={`sidebar${drawer ? " drawer" : ""}${selecting ? " selecting" : ""}`}
      aria-label="Repository tree"
    >
      {drawer && (
        <div className="drawer-head">
          <span className="eyebrow">repos · {repos.length}</span>
          <button type="button" className="icon-btn" aria-label="Close the repo tree" title="Close (Esc)" onClick={() => setDrawer(false)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      )}
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
                {selecting ? (
                  <TreePick label={label} ids={members.filter(pickable).map((r) => r.id)} total={members.length} />
                ) : (
                  <>
                    {dirty > 0 && <em className="c-dirty">{dirty}●</em>}
                    <span>{members.length}</span>
                  </>
                )}
              </span>
            </GroupHead>
            {open && (
              <ul className="tree-list">
                {members.map((r) => (
                  <li key={r.id}>
                    <TreeItem repo={r} />
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

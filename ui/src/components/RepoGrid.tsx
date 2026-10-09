import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { keepKeys } from "../surface";
import { useShallow } from "zustand/react/shallow";
import { pickable } from "../flows";
import { changedAt, groupRepos, newestEdit, sectionKey } from "../grouping";
import { cardChangedAt } from "../checkouts";
import { ElsewhereChips, PeerChips, Pulls, RemoteTipChip, whenTitle } from "./RemoteTip";
import { pickCount, pickState } from "../select";
import {
  activeFlowFor,
  boardChangedAt,
  boardFavorite,
  cardOf,
  flowFor,
  isOnline,
  multi,
  runFor,
  useStore,
  visibleCards,
  visibleRepos,
} from "../store";
import { backendOf, isHome } from "../registry";
import { isPrimary, wsOf } from "../workspaces";
import type { RepoCard as Card } from "../checkouts";
import { ago, GLYPH, stateOf } from "../util";
import { GroupHead } from "./GroupHead";
import { WidgetGear, shareEntries, useGroupFolds, useZoom, zoomStyle } from "./Surface";
import { Tick } from "./SelectBar";
import { RepoLink } from "./RepoLink";
import { Star } from "./Star";
import { RepoMenu } from "./RepoMenu";
import { Rings } from "./Rings";
import { FlowChip, RunChip } from "./RunChip";
import { TaskChip } from "./Tasks";
import { AgentChip } from "./Registry";
import { historyFor, type Repo } from "../../../src/core/types";

/** What a machine chip's tooltip says about its backend. */
function machineTitle(backend: string, state: string, reason: string | undefined, repo: Repo): string {
  switch (state) {
    case "online":
      return `${repo.name} on ${backend}${repo.status ? `, on ${repo.status.branch}` : ""}`;
    case "signin":
      return `sign in to ${backend}; showing what it last said`;
    case "connecting":
      return `waiting for ${backend}`;
    default:
      return `${backend} is offline${reason ? `: ${reason}` : ""}; showing what it last said`;
  }
}

/** One chip per machine that has the repo checked out, in the registry's
 *  order: its name, its changed count, how far it is ahead or behind. The
 *  lead is lit; a click opens that machine's checkout and makes it the
 *  card's lead. In select mode the chips only say, since a click picks. */
function MachineStrip({ card, lead, selecting }: { card: Card; lead: string; selecting: boolean }) {
  const conns = useStore((s) => s.conns);
  const openRepo = useStore((s) => s.openRepo);
  const setPref = useStore((s) => s.setCheckoutPref);
  return (
    <div className="machines" role="group" aria-label={`${card.name} on each machine`}>
      {card.checkouts.map((c) => {
        const b = backendOf(c.id);
        const status = conns[b]?.status;
        const state = status?.state ?? "connecting";
        const on = c.id === lead;
        const dirty = c.status?.files.length ?? 0;
        const ahead = c.status?.ahead ?? 0;
        const behind = c.status?.behind ?? 0;
        const inner = (
          <>
            <span className="machine-name">{b}</span>
            {dirty > 0 && <span className="machine-dirty">{dirty}●</span>}
            {ahead > 0 && <span className="ahead">↑{ahead}</span>}
            {behind > 0 && <span className="behind">↓{behind}</span>}
          </>
        );
        const cls = `machine${on ? " on" : ""}${state === "online" ? "" : " away"}`;
        const title = machineTitle(b, state, status?.reason, c);
        if (selecting) {
          return (
            <span key={c.id} className={cls} title={title}>
              {inner}
            </span>
          );
        }
        return (
          <button
            key={c.id}
            type="button"
            className={cls}
            title={title}
            aria-pressed={on}
            onClick={(e) => {
              e.stopPropagation();
              setPref(card.key, b);
              openRepo(c.id, e);
            }}
            onAuxClick={(e) => {
              e.stopPropagation();
              if (e.button === 1) openRepo(c.id, { metaKey: true });
            }}
            // the card opens its lead on Enter; this chip opens its own
            onKeyDown={keepKeys}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}

const RepoCard = memo(function RepoCard({ repo, i }: { repo: Repo; i: number }) {
  const openRepo = useStore((s) => s.openRepo);
  const many = useStore(multi);
  const card = useStore((s) => (multi(s) ? cardOf(s, repo.id) : undefined));
  // a card none of whose machines answers is shown as it last was, dimmed
  const away = useStore((s) => card !== undefined && !card.checkouts.some((c) => isOnline(s, backendOf(c.id))));
  const updatedAt = useStore((s) => s.updatedAt[repo.id]);
  const run = useStore((s) => runFor(s, repo.id));
  const flow = useStore((s) => flowFor(s, repo.id));
  const activeFlow = useStore((s) => activeFlowFor(s, repo.id));
  const overview = useStore((s) => s.history);
  const history = historyFor(overview, repo.id);
  const selecting = useStore((s) => s.selecting);
  const picked = useStore((s) => s.selected.includes(repo.id));
  const toggleSelected = useStore((s) => s.toggleSelected);
  const canPick = pickable(repo);
  // the active workspace tab, when it holds this card: a workspace holds
  // home's checkouts, so another backend's card at the same path is not in it
  const ws = useStore((s) =>
    s.activeWs && isHome(repo.id) ? wsOf(s.workspaces, repo.path).find((w) => w.name === s.activeWs) : undefined,
  );
  const [pulse, setPulse] = useState(false);
  // what the ⋯ menu last failed at, shown on the card for a few seconds
  const [menuErr, setMenuErr] = useState<string | null>(null);
  const first = useRef(true);

  useEffect(() => {
    if (!menuErr) return;
    const t = setTimeout(() => setMenuErr(null), 8000);
    return () => clearTimeout(t);
  }, [menuErr]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!updatedAt) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 1200);
    return () => clearTimeout(t);
  }, [updatedAt]);

  const st = repo.status;
  const forge = repo.forge;
  const state = stateOf(repo);
  // The time is the last change of any kind, what "recent" sorts on; the
  // tooltip says which kind when it is not the commit.
  const title = forge ? "last push to the forge" : whenTitle(st, newestEdit(repo));
  const live = activeFlow
    ? activeFlow.status === "working"
      ? " run-working"
      : " run-waiting"
    : run?.status === "working" || run?.status === "waiting"
      ? ` run-${run.status}`
      : "";
  return (
    <article
      className={`card s-${state}${pulse ? " pulse" : ""}${live}${selecting && picked ? " picked" : ""}${selecting && !canPick ? " unpickable" : ""}${away ? " away" : ""}${repo.archived ? " archived" : ""}`}
      onClick={(e) => {
        if (selecting) {
          toggleSelected(repo.id, e.shiftKey);
          return;
        }
        openRepo(repo.id, e);
      }}
      onAuxClick={(e) => {
        if (selecting) return;
        // middle click behaves like it does on a link
        if (e.button === 1) openRepo(repo.id, { metaKey: true });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || (selecting && e.key === " ")) {
          if (selecting) {
            e.preventDefault();
            toggleSelected(repo.id, e.shiftKey);
            return;
          }
          openRepo(repo.id, e);
        }
      }}
      data-ws-color={ws?.color}
      tabIndex={0}
      // its place in the group, which sets how late it rises in
      style={{ "--i": i } as CSSProperties}
      role={selecting ? "checkbox" : "button"}
      aria-checked={selecting ? picked : undefined}
      aria-disabled={selecting && !canPick ? true : undefined}
      aria-label={
        selecting
          ? canPick
            ? `Pick ${repo.name}`
            : `${repo.name} cannot join a fleet`
          : forge
            ? `Open ${repo.name} on the forge`
            : `Open ${repo.name}`
      }
    >
      <div className="card-top">
        {selecting && (
          <span className={`tick${picked ? " on" : ""}`} aria-hidden="true">
            {picked ? "✓" : ""}
          </span>
        )}
        <span className="glyph">{GLYPH[state]}</span>
        <span className="card-name">{repo.name}</span>
        <Star repoId={repo.id} name={repo.name} onError={setMenuErr} />
        {ws && isPrimary(ws, repo.path) && (
          <span className="chip primary" title={`New code for the ${ws.name} workspace goes here`}>
            primary
          </span>
        )}
        {repo.host && (
          <span className="host-tag" title={`on ${repo.host}, over ssh`}>
            {repo.host}
          </span>
        )}
        {forge && (
          <span
            className="host-tag forge"
            title={`${forge.slug} on the forge${forge.private ? ", private" : ""}`}
          >
            forgejo
          </span>
        )}
        {repo.archived && (
          <span
            className="host-tag archived"
            title={
              repo.archived === "github"
                ? "Archived on GitHub, read-only there"
                : "Archived in canopy; unarchive it from the ⋯ menu"
            }
          >
            archived
          </span>
        )}
        {repo.link && <RepoLink url={repo.link} name={repo.name} />}
        <span className="card-more">
          <RepoMenu repo={repo} onError={setMenuErr} />
        </span>
      </div>
      {many && card && <MachineStrip card={card} lead={repo.id} selecting={selecting} />}
      {repo.description && (
        <p className="card-desc" title={repo.description}>
          {repo.description}
        </p>
      )}
      {/* one line: where the checkout stands on the left, what it holds
          and when it last moved on the right; it wraps when a card carries
          more chips than fit */}
      <div className="card-meta">
        <span className="branch" title={st?.branch ?? forge?.branch}>
          {st?.branch ?? forge?.branch ?? "—"}
        </span>
        {(st?.ahead ?? 0) > 0 && <span className="ahead">↑{st?.ahead}</span>}
        {(st?.behind ?? 0) > 0 && <span className="behind">↓{st?.behind}</span>}
        {st?.tip && <RemoteTipChip tip={st.tip} upstream={st.upstream} />}
        <ElsewhereChips st={st} />
        <PeerChips st={repo.peers} />
        {repo.pulls && <Pulls pulls={repo.pulls} name={repo.name} />}
        {repo.error && <span className="err">not a readable repo</span>}
        {menuErr && (
          <span className="err" role="alert" title={menuErr}>
            {menuErr}
          </span>
        )}
        <span className="card-state">
          {activeFlow ? <FlowChip flow={activeFlow} /> : run ? <RunChip run={run} /> : flow && <FlowChip flow={flow} />}
          <TaskChip repoId={repo.id} />
          <AgentChip repoId={repo.id} />
          {forge ? (
            <span className="clean" title={forge.clone}>
              {forge.empty
                ? "empty on the forge"
                : forge.clonedAs
                  ? "cloned here"
                  : "not cloned here"}
            </span>
          ) : st?.files.length ? (
            <span className="changes">{st.files.length} changed</span>
          ) : (
            !repo.error && <span className="clean">clean</span>
          )}
          <span className="when" title={title}>
            {ago(card ? cardChangedAt(card) : changedAt(repo))}
          </span>
        </span>
      </div>
      {history && overview?.available && (
        <Rings history={history} days={overview.days} maxDay={overview.maxDay} />
      )}
    </article>
  );
});

/** A group heading's tick and count in select mode: the tick fills or
 *  clears the group's pickable members, the count says how many are in. */
function GroupPick({ label, ids, total }: { label: string; ids: string[]; total: number }) {
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
      <span className="grid-count" title={`${n} of ${ids.length} picked`}>
        {n}/{total}
      </span>
    </>
  );
}

export function RepoGrid() {
  const repos = useStore(useShallow(visibleRepos));
  // a card moves in time when any of its checkouts changes, not only its lead
  const cards = useStore(useShallow(visibleCards));
  const many = useStore(multi);
  const sort = useStore((s) => s.settings.sort);
  const collapsed = useStore((s) => s.collapsed);
  const toggleGroup = useStore((s) => s.toggleGroup);
  const selecting = useStore((s) => s.selecting);
  const box = useRef<HTMLElement>(null);
  const { zoom, entry: zoomEntry } = useZoom("board");
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
  // the groups showing, which the gear's and Alt+click's folds act on
  const shownKeys = groups.map((g) => sectionKey(sort, g.key));
  const folds = useGroupFolds(shownKeys);
  const foldGroups = useStore((s) => s.foldGroups);

  if (repos.length === 0) {
    return (
      <main className="main">
        <p className="empty">
          No repos to show. Point canopy at a folder that contains git repos,
          or clear the active filters.
        </p>
      </main>
    );
  }
  return (
    <main ref={box} className={selecting ? "main selecting" : "main"}>
      {groups.map(({ key, label, hint, repos: members }, i) => {
        const id = sectionKey(sort, key);
        const open = !collapsed.includes(id);
        return (
          <section key={key} className="grid-group">
            <GroupHead
              className="grid-head"
              label={label}
              hint={hint}
              open={open}
              onToggle={() => toggleGroup(id)}
              onToggleAll={() => foldGroups(shownKeys, open)}
            >
              {i === 0 && (
                <WidgetGear
                  label="the board"
                  what="board"
                  zoom={zoomEntry}
                  extra={folds}
                  share={shareEntries({ el: () => box.current, label: "board" })}
                />
              )}
              {selecting ? (
                <GroupPick label={label} ids={members.filter(pickable).map((r) => r.id)} total={members.length} />
              ) : (
                <span className="grid-count">{members.length}</span>
              )}
            </GroupHead>
            {open && (
              <div className="grid" style={zoomStyle(zoom)}>
                {members.map((r, i) => (
                  <RepoCard key={r.id} repo={r} i={i} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { pickable } from "../flows";
import { changedAt, groupRepos, newestEdit, sectionKey } from "../grouping";
import { pickCount, pickState } from "../select";
import { activeFlowFor, flowFor, runFor, useStore, visibleRepos } from "../store";
import { ago, GLYPH, stateOf } from "../util";
import { GroupHead } from "./GroupHead";
import { Tick } from "./SelectBar";
import { RepoLink } from "./RepoLink";
import { RepoMenu } from "./RepoMenu";
import { Rings } from "./Rings";
import { FlowChip, RunChip } from "./RunChip";
import { historyFor, type Repo } from "../../../src/core/types";

const RepoCard = memo(function RepoCard({ repo }: { repo: Repo }) {
  const openRepo = useStore((s) => s.openRepo);
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
  const [pulse, setPulse] = useState(false);
  const first = useRef(true);

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
  // The time is the last change of any kind, what "recent" sorts on. When
  // that is an edit rather than the commit, the tooltip says which file and
  // keeps the commit too.
  const commit = st?.lastCommit;
  const edit = newestEdit(repo);
  const whenTitle = forge
    ? "last push to the forge"
    : edit && commit && edit.at > commit.at
      ? `${edit.path} edited ${ago(edit.at)} · committed ${ago(commit.at)}: ${commit.subject}`
      : edit && !commit
        ? `${edit.path} edited ${ago(edit.at)}`
        : commit?.subject;
  const live = activeFlow
    ? activeFlow.status === "working"
      ? " run-working"
      : " run-waiting"
    : run?.status === "working" || run?.status === "waiting"
      ? ` run-${run.status}`
      : "";
  return (
    <article
      className={`card s-${state}${pulse ? " pulse" : ""}${live}${selecting && picked ? " picked" : ""}${selecting && !canPick ? " unpickable" : ""}`}
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
      tabIndex={0}
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
        {repo.link && <RepoLink url={repo.link} name={repo.name} />}
        <span className="card-more">
          <RepoMenu repo={repo} />
        </span>
      </div>
      {repo.description && (
        <p className="card-desc" title={repo.description}>
          {repo.description}
        </p>
      )}
      <div className="card-mid">
        <span className="branch" title={st?.branch ?? forge?.branch}>
          {st?.branch ?? forge?.branch ?? "—"}
        </span>
        {(st?.ahead ?? 0) > 0 && <span className="ahead">↑{st?.ahead}</span>}
        {(st?.behind ?? 0) > 0 && <span className="behind">↓{st?.behind}</span>}
        {repo.error && <span className="err">not a readable repo</span>}
      </div>
      <div className="card-bot">
        {activeFlow ? <FlowChip flow={activeFlow} /> : run ? <RunChip run={run} /> : flow && <FlowChip flow={flow} />}
        {forge ? (
          <span className="clean" title={forge.clone}>
            {forge.empty
              ? "empty on the forge"
              : forge.clonedAs
                ? "cloned here"
                : "not cloned here"}
          </span>
        ) : (
          <span className={st?.files.length ? "changes" : "clean"}>
            {st?.files.length
              ? `${st.files.length} changed`
              : repo.error
                ? ""
                : "clean"}
          </span>
        )}
        <span className="when" title={whenTitle}>
          {ago(changedAt(repo))}
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
  const sort = useStore((s) => s.settings.sort);
  const collapsed = useStore((s) => s.collapsed);
  const toggleGroup = useStore((s) => s.toggleGroup);
  const selecting = useStore((s) => s.selecting);
  const groups = useMemo(() => groupRepos(repos, sort), [repos, sort]);

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
    <main className={selecting ? "main selecting" : "main"}>
      {groups.map(({ key, label, hint, repos: members }) => {
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
            >
              {selecting ? (
                <GroupPick label={label} ids={members.filter(pickable).map((r) => r.id)} total={members.length} />
              ) : (
                <span className="grid-count">{members.length}</span>
              )}
            </GroupHead>
            {open && (
              <div className="grid">
                {members.map((r) => (
                  <RepoCard key={r.id} repo={r} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}

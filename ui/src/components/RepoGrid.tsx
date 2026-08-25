import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { groupRepos } from "../grouping";
import { runFor, useStore, visibleRepos } from "../store";
import { ago, GLYPH, stateOf } from "../util";
import { RepoMenu } from "./RepoMenu";
import { RunChip } from "./RunChip";
import type { Repo } from "../../../src/core/types";

const RepoCard = memo(function RepoCard({ repo }: { repo: Repo }) {
  const openRepo = useStore((s) => s.openRepo);
  const updatedAt = useStore((s) => s.updatedAt[repo.id]);
  const run = useStore((s) => runFor(s, repo.id));
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
  const state = stateOf(repo);
  const live = run?.status === "working" || run?.status === "waiting" ? ` run-${run.status}` : "";
  return (
    <article
      className={`card s-${state}${pulse ? " pulse" : ""}${live}`}
      onClick={(e) => openRepo(repo.id, e)}
      onAuxClick={(e) => {
        // middle click behaves like it does on a link
        if (e.button === 1) openRepo(repo.id, { metaKey: true });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") openRepo(repo.id, e);
      }}
      tabIndex={0}
      role="button"
      aria-label={`Open ${repo.name}`}
    >
      <div className="card-top">
        <span className="glyph">{GLYPH[state]}</span>
        <span className="card-name">{repo.name}</span>
        <span className="card-more">
          <RepoMenu repo={repo} />
        </span>
      </div>
      <div className="card-mid">
        <span className="branch" title={st?.branch}>
          {st?.branch ?? "—"}
        </span>
        {(st?.ahead ?? 0) > 0 && <span className="ahead">↑{st?.ahead}</span>}
        {(st?.behind ?? 0) > 0 && <span className="behind">↓{st?.behind}</span>}
        {repo.error && <span className="err">not a readable repo</span>}
      </div>
      <div className="card-bot">
        {run && <RunChip run={run} />}
        <span className={st?.files.length ? "changes" : "clean"}>
          {st?.files.length
            ? `${st.files.length} changed`
            : repo.error
              ? ""
              : "clean"}
        </span>
        <span className="when" title={st?.lastCommit?.subject}>
          {ago(st?.lastCommit?.at)}
        </span>
      </div>
    </article>
  );
});

export function RepoGrid() {
  const repos = useStore(useShallow(visibleRepos));
  const sort = useStore((s) => s.settings.sort);
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
    <main className="main">
      {groups.map(({ key, label, repos: members }) => (
        <section key={key} className="grid-group">
          <h2 className="grid-head">
            <span className="head-name">{label}</span>
            <span className="grid-count">{members.length}</span>
          </h2>
          <div className="grid">
            {members.map((r) => (
              <RepoCard key={r.id} repo={r} />
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

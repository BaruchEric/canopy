import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { useStore, visibleRepos } from "../store";
import { ago, GLYPH, stateOf } from "../util";
import type { Repo } from "../../../src/core/types";

const RepoCard = memo(function RepoCard({ repo }: { repo: Repo }) {
  const openPanel = useStore((s) => s.openPanel);
  const updatedAt = useStore((s) => s.updatedAt[repo.id]);
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
  return (
    <article
      className={`card s-${state}${pulse ? " pulse" : ""}`}
      onClick={() => openPanel(repo.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") openPanel(repo.id);
      }}
      tabIndex={0}
      role="button"
      aria-label={`Open ${repo.name}`}
    >
      <div className="card-top">
        <span className="glyph">{GLYPH[state]}</span>
        <span className="card-name">{repo.name}</span>
        <span className="card-openers">
          {(["kitty", "code", "finder"] as const).map((app) => (
            <button
              key={app}
              type="button"
              className="mini"
              title={`Open in ${app}`}
              onClick={(e) => {
                e.stopPropagation();
                void api.open(repo.id, app);
              }}
            >
              {app}
            </button>
          ))}
        </span>
      </div>
      <div className="card-mid">
        <span className="branch">{st?.branch ?? "—"}</span>
        {(st?.ahead ?? 0) > 0 && <span className="ahead">↑{st?.ahead}</span>}
        {(st?.behind ?? 0) > 0 && <span className="behind">↓{st?.behind}</span>}
        {repo.error && <span className="err">not a readable repo</span>}
      </div>
      <div className="card-bot">
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
  const groups = useMemo(() => {
    const m = new Map<string, Repo[]>();
    for (const r of repos) {
      const g = r.group || ".";
      const arr = m.get(g) ?? [];
      arr.push(r);
      m.set(g, arr);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [repos]);

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
      {groups.map(([group, members]) => (
        <section key={group} className="grid-group">
          <h2 className="grid-head">
            {group}
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

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, KeyboardEvent } from "react";
import { api } from "../api";
import {
  FILE_COL_INFO,
  defaultDir,
  filterFiles,
  groupByFolder,
  markOf,
  moveCol,
  sortFiles,
  stagingOf,
  type FileCol,
  type FileView,
} from "../files";
import { peerable } from "../peers";
import { useShallow } from "zustand/react/shallow";
import { DOCK, PANEL, activeFlowFor, capsFor, closedIn, flowFor, runFor, useStore } from "../store";
import { ago, GLYPH, stateOf } from "../util";
import { ClaudeSection } from "./Claude";
import { LaunchSection } from "./Launch";
import { CommitRow } from "./Commit";
import { DiffView } from "./DiffView";
import { PeerChips, Pulls, RemoteTipChip } from "./RemoteTip";
import { RepoLink } from "./RepoLink";
import { RepoMenu } from "./RepoMenu";
import { Resizer } from "./Resizer";
import { FlowChip, RunChip } from "./RunChip";
import { SearchSection } from "./Search";
import { Seg, type SegOption } from "./Seg";
import { PanelShells } from "./TermDock";
import {
  OPENER_IDS,
  type LogEntry,
  type PushAccess,
  type Repo,
  type RepoFile,
} from "../../../src/core/types";

/** The width of each column, in the order the settings put them. The
 *  checkbox is always the first track. */
function colTemplate(cols: FileCol[]): string {
  const width: Record<FileCol, string> = {
    mark: "auto",
    file: "minmax(6em, 1fr)",
    time: "auto",
  };
  return ["auto", ...cols.map((c) => width[c])].join(" ");
}

function FileRow({
  repo,
  file,
  cols,
  label,
  onError,
}: {
  repo: Repo;
  file: RepoFile;
  cols: FileCol[];
  /** what the file cell says: the whole path, or the name under a folder heading */
  label: string;
  onError: (message: string) => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const { staged, split } = stagingOf(file);
  const marker = markOf(file);

  // Re-fetch on every open: the cached text goes stale as soon as the file is
  // edited or its staged/untracked state changes.
  const toggleDiff = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    try {
      const [r, rest] = await Promise.all([
        api.diff(repo.id, file.path, staged, file.untracked),
        split ? api.diff(repo.id, file.path, false, false) : null,
      ]);
      setDiff(rest ? [r.diff, rest.diff].filter((d) => d.trim()).join("\n") : r.diff);
      setOpen(true);
    } catch (err) {
      onError(String(err instanceof Error ? err.message : err));
    }
  };

  const toggleStage = async () => {
    try {
      // a rename's old path goes on or off the index with it; a copy's
      // source is a file of its own and stays as it is
      const renamed = file.index === "R" || file.worktree === "R";
      await api.stage(repo.id, file.path, staged, renamed ? file.orig : undefined);
    } catch (err) {
      onError(String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <li className={`file${file.conflicted ? " conflicted" : ""}`}>
      <div className="file-row">
        <input
          type="checkbox"
          title={staged ? "Unstage" : "Stage"}
          checked={staged}
          disabled={file.conflicted}
          onChange={() => void toggleStage()}
        />
        {cols.map((col) => {
          switch (col) {
            case "mark":
              return (
                <span key={col} className={`mark m-${marker}`}>
                  {marker}
                </span>
              );
            case "file":
              return (
                <button
                  key={col}
                  type="button"
                  className="file-name"
                  onClick={() => void toggleDiff()}
                  title={file.orig ? `${file.orig} → ${file.path}` : file.path}
                >
                  {label}
                </button>
              );
            case "time":
              return (
                <span
                  key={col}
                  className="file-time"
                  title={
                    file.mtime === undefined
                      ? "not on disk"
                      : new Date(file.mtime * 1000).toLocaleString()
                  }
                >
                  {ago(file.mtime)}
                </span>
              );
          }
        })}
      </div>
      {open && diff !== null && <DiffView diff={diff} />}
    </li>
  );
}

const VIEWS: readonly SegOption<FileView>[] = [
  { value: "list", label: "list", title: "Every file in one list" },
  {
    value: "folders",
    label: "folders",
    title: "Files under a heading per folder",
  },
];

/** The changes list: a filter box, a header row whose buttons sort (click)
 *  and reorder (drag, or Alt with an arrow key), then the rows. Column order
 *  and sort are per-browser settings, so every panel agrees. */
function ChangesList({
  repo,
  files,
  onError,
}: {
  repo: Repo;
  files: RepoFile[];
  onError: (message: string) => void;
}) {
  const cols = useStore((s) => s.settings.fileCols);
  const sort = useStore((s) => s.settings.fileSort);
  const setSetting = useStore((s) => s.setSetting);
  const view = useStore((s) => s.settings.fileView);
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState<FileCol | null>(null);

  const shown = useMemo(
    () => sortFiles(filterFiles(files, query), sort),
    [files, query, sort],
  );
  const groups = useMemo(
    () => (view === "folders" ? groupByFolder(shown) : null),
    [view, shown],
  );

  const sortBy = (col: FileCol) =>
    setSetting(
      "fileSort",
      sort.col === col
        ? { col, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { col, dir: defaultDir(col) },
    );

  const move = (from: FileCol, to: FileCol) => {
    const next = moveCol(cols, from, to);
    if (next !== cols) setSetting("fileCols", next);
  };

  const onDrop = (e: DragEvent, to: FileCol) => {
    e.preventDefault();
    if (dragging) move(dragging, to);
    setDragging(null);
  };

  // Alt+arrow swaps the column with its neighbour, for keyboards and for
  // anyone who would rather not drag.
  const onKey = (e: KeyboardEvent, col: FileCol) => {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const i = cols.indexOf(col);
    const to = cols[e.key === "ArrowLeft" ? i - 1 : i + 1];
    if (to) move(col, to);
  };

  const arrow = sort.dir === "asc" ? "↑" : "↓";

  return (
    <div
      className="changes"
      style={{ "--file-cols": colTemplate(cols) } as CSSProperties}
    >
      <div className="changes-tools">
        <input
          className="file-filter"
          type="search"
          placeholder="filter files"
          aria-label="Filter changed files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <span className="changes-count">
            {shown.length} of {files.length}
          </span>
        )}
        <Seg
          label="Changes view"
          className="changes-view"
          value={view}
          options={VIEWS}
          onChange={(v) => setSetting("fileView", v)}
        />
      </div>
      <div className="file-table">
        <div className="file-head" role="row">
          <span />
          {cols.map((col) => (
            <button
              key={col}
              type="button"
              className={`file-col${sort.col === col ? " sorted" : ""}${dragging === col ? " dragging" : ""}`}
              title={`${FILE_COL_INFO[col].title}. Click to sort, drag or Alt+arrow to move.`}
              aria-sort={
                sort.col === col
                  ? sort.dir === "asc"
                    ? "ascending"
                    : "descending"
                  : undefined
              }
              draggable
              onClick={() => sortBy(col)}
              onKeyDown={(e) => onKey(e, col)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                setDragging(col);
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => {
                if (dragging) e.preventDefault();
              }}
              onDrop={(e) => onDrop(e, col)}
            >
              {FILE_COL_INFO[col].label || "•"}
              {sort.col === col && <span className="sort-arrow">{arrow}</span>}
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <p className="panel-clean">No file matches.</p>
        ) : (
          <ul className="files">
            {groups
              ? groups.map((g) => (
                  <Fragment key={g.folder}>
                    <li className="file-folder" title={g.folder || "repo root"}>
                      <span className="folder-name">{g.folder || "/"}</span>
                      <span className="folder-count">{g.files.length}</span>
                    </li>
                    {g.files.map((f) => (
                      <FileRow
                        key={f.path}
                        repo={repo}
                        file={f}
                        cols={cols}
                        label={f.path.slice(g.folder ? g.folder.length + 1 : 0)}
                        onError={onError}
                      />
                    ))}
                  </Fragment>
                ))
              : shown.map((f) => (
                  <FileRow
                    key={f.path}
                    repo={repo}
                    file={f}
                    cols={cols}
                    label={f.path}
                    onError={onError}
                  />
                ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function WorkspaceMenu({
  repo,
  onError,
}: {
  repo: Repo;
  onError: (message: string) => void;
}) {
  const workspaces = useStore((s) => s.workspaces);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const report = (err: unknown) =>
    onError(String(err instanceof Error ? err.message : err));

  const add = async (ws: string) => {
    try {
      await api.wsAdd(ws, [repo.id]);
      setOpen(false);
      setName("");
    } catch (err) {
      report(err);
    }
  };
  const remove = async (ws: string) => {
    try {
      await api.wsRemove(ws, repo.id);
    } catch (err) {
      report(err);
    }
  };
  const memberOf = workspaces.filter((w) => w.repos.includes(repo.path));

  return (
    <span className="ws-menu">
      <button
        type="button"
        className="mini"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {memberOf.length > 0
          ? `ws: ${memberOf.map((w) => w.name).join(", ")}`
          : "add to workspace"}
      </button>
      {open && (
        <span className="ws-pop">
          {workspaces.map((w) =>
            w.repos.includes(repo.path) ? (
              <button
                key={w.name}
                type="button"
                className="mini"
                onClick={() => void remove(w.name)}
              >
                − {w.name}
              </button>
            ) : (
              <button
                key={w.name}
                type="button"
                className="mini"
                onClick={() => void add(w.name)}
              >
                + {w.name}
              </button>
            ),
          )}
          <span className="ws-new">
            <input
              type="text"
              placeholder="new workspace"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) void add(name.trim());
              }}
            />
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * What this repo's peers know that this checkout does not: a peer's
 * uncommitted work to take, a branch that diverged, or a branch that
 * exists only on a peer. Folded by default, and only shown at all when
 * the backend has peer sync on (dry or live) — off means nothing here is
 * ever populated. */
function PeersSection({ repo }: { repo: Repo }) {
  const peerSync = useStore((s) => s.peerSync);
  const closed = useStore((s) => closedIn(s, repo.id, "peers"));
  const toggleSection = useStore((s) => s.toggleSection);
  const takeWip = useStore((s) => s.takeWip);
  const trackBranch = useStore((s) => s.trackBranch);
  const seedRepo = useStore((s) => s.seedRepo);
  const syncPeers = useStore((s) => s.syncPeers);
  const openTerm = useStore((s) => s.openTerm);
  const openChat = useStore((s) => s.openChat);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One WIP's commit drill open at a time, by hash, the way History does.
  const [drilled, setDrilled] = useState<string | null>(null);

  if (peerSync === "off" || !peerable(repo)) return null;

  const st = repo.peers;
  const wip = st?.wip ?? [];
  const diverged = st?.diverged ?? [];
  const peerOnly = st?.peerOnly ?? [];
  const count = wip.length + diverged.length + peerOnly.length;

  const run = (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    fn()
      .catch((err: unknown) => setError(String(err instanceof Error ? err.message : err)))
      .finally(() => setBusy(null));
  };

  return (
    <section className="peers" aria-label="Peers">
      <button
        type="button"
        className={`panel-label fold${closed ? "" : " open"}`}
        aria-expanded={!closed}
        onClick={() => toggleSection(repo.id, "peers")}
        title="What this repo's peers have that this checkout does not"
      >
        peers <span>{count}</span>
      </button>
      {!closed && (
        <div className="peers-body">
          {error && <p className="panel-error">{error}</p>}
          {st === undefined ? (
            <p className="panel-clean">Not synced yet.</p>
          ) : count === 0 ? (
            <p className="panel-clean">In step with every peer.</p>
          ) : (
            <>
              {wip.map((w) => (
                <Fragment key={`wip:${w.peer}:${w.branch}:${w.hash}`}>
                  <div className="peers-row">
                    <span className="peers-text">
                      WIP on {w.peer} · {w.branch} · {w.files} files
                    </span>
                    <button
                      type="button"
                      className="mini"
                      disabled={busy !== null}
                      onClick={() => run(`take:${w.hash}`, () => takeWip(repo.id, w.peer, w.branch))}
                    >
                      {busy === `take:${w.hash}` ? "taking…" : "take"}
                    </button>
                    <button
                      type="button"
                      className="mini"
                      onClick={() => setDrilled(drilled === w.hash ? null : w.hash)}
                    >
                      {drilled === w.hash ? "hide" : "view"}
                    </button>
                  </div>
                  {drilled === w.hash && (
                    <ul className="log peers-drill">
                      <CommitRow
                        repo={repo}
                        hash={w.hash}
                        subject={`WIP on ${w.branch}`}
                        meta={`${w.peer} · ${ago(w.at / 1000)}`}
                        open
                        onToggle={() => setDrilled(null)}
                      />
                    </ul>
                  )}
                </Fragment>
              ))}
              {diverged.map((d) => (
                <div key={`div:${d.peer}:${d.branch}`} className="peers-row">
                  <span className="peers-text peer-diverged">
                    {d.branch} diverged from {d.peer}
                  </span>
                  <button type="button" className="mini" onClick={() => openTerm(repo.id)}>
                    shell
                  </button>
                  <button
                    type="button"
                    className="mini"
                    disabled={busy !== null}
                    onClick={() =>
                      run(`merge:${d.peer}:${d.branch}`, () =>
                        openChat(
                          repo.id,
                          `Merge ${d.peer}/${d.branch} into ${d.branch}. It diverged: resolve conflicts, run the tests, and commit the merge. Do not push.`,
                        ),
                      )
                    }
                  >
                    {busy === `merge:${d.peer}:${d.branch}` ? "starting…" : "merge with claude"}
                  </button>
                </div>
              ))}
              {peerOnly.map((po) => (
                <div key={`only:${po.peer}:${po.branch}`} className="peers-row">
                  <span className="peers-text">
                    {po.peer}/{po.branch}
                  </span>
                  <button
                    type="button"
                    className="mini"
                    disabled={busy !== null}
                    onClick={() => run(`track:${po.peer}:${po.branch}`, () => trackBranch(repo.id, po.peer, po.branch))}
                  >
                    {busy === `track:${po.peer}:${po.branch}` ? "tracking…" : "track"}
                  </button>
                </div>
              ))}
            </>
          )}
          <div className="peers-foot">
            <button
              type="button"
              className="mini"
              disabled={busy !== null}
              onClick={() => run("sync", () => syncPeers(repo.id))}
            >
              {busy === "sync" ? "syncing…" : "sync now"}
            </button>
            <button
              type="button"
              className="mini"
              disabled={busy !== null}
              onClick={() => run("seed", () => seedRepo(repo.id))}
            >
              {busy === "seed" ? "seeding…" : "seed .env"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function History({ repo }: { repo: Repo }) {
  // Bumped by the repo SSE event, so a commit made in a terminal refreshes
  // this list too — not just one made from the panel.
  const updatedAt = useStore((s) => s.updatedAt[repo.id]);
  const closed = useStore((s) => closedIn(s, repo.id, "history"));
  const toggleSection = useStore((s) => s.toggleSection);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One commit open at a time, by hash, so it survives the log refreshing
  // underneath it and closes itself if the commit is rewritten away.
  const [drilled, setDrilled] = useState<string | null>(null);

  useEffect(() => {
    if (closed) return;
    let live = true;
    setError(null);
    api
      .log(repo.id)
      .then((entries) => {
        if (live) setLog(entries);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [closed, repo.id, updatedAt]);

  return (
    <details
      className="history"
      open={!closed}
      onToggle={(e) => {
        if (!e.currentTarget.open !== closed) toggleSection(repo.id, "history");
      }}
    >
      <summary className="panel-label">
        history <span>{log ? log.length : "…"}</span>
      </summary>
      {error ? (
        <p className="panel-error">Could not read the log: {error}</p>
      ) : log === null ? (
        <p className="panel-clean">Reading log…</p>
      ) : log.length === 0 ? (
        <p className="panel-clean">No commits yet.</p>
      ) : (
        <ul className="log">
          {log.map((c) => (
            <CommitRow
              key={c.hash}
              repo={repo}
              hash={c.hash}
              subject={c.subject}
              meta={`${c.author} · ${c.when}`}
              open={drilled === c.hash}
              onToggle={() => setDrilled(drilled === c.hash ? null : c.hash)}
            />
          ))}
        </ul>
      )}
    </details>
  );
}

export function RepoPanel({
  id,
  width,
  onClose,
  hidden,
}: {
  id: string;
  width: number;
  /** replaces "unpin from the dock", for a panel that owns its window */
  onClose?: () => void;
  /** a tab that is not showing: the panel stays mounted (its shell keeps
   *  its pty, its commit box its draft) but takes no room */
  hidden?: boolean;
}) {
  const repo = useStore((s) => s.repos.find((r) => r.id === id));
  const repoRun = useStore((s) => runFor(s, id));
  const repoFlow = useStore((s) => flowFor(s, id));
  const repoActiveFlow = useStore((s) => activeFlowFor(s, id));
  const unpin = useStore((s) => s.closePanel);
  const openApp = useStore((s) => s.openApp);
  // Only the openers this browser can reach, as in RepoMenu: a headless
  // backend with no helper picked has none, and VS Code falls back to the
  // Remote-SSH link.
  const backend = useStore((s) => s.backend);
  const openers = useStore(useShallow(capsFor)).openers;
  const changesClosed = useStore((s) => closedIn(s, id, "changes"));
  const toggleSection = useStore((s) => s.toggleSection);
  const closePanel = onClose ? (_id: string) => onClose() : unpin;
  const [message, setMessage] = useState("");
  // Off by default: on, it runs `git add -A` and silently commits everything
  // the per-file checkboxes were used to exclude.
  const [stageAll, setStageAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const [access, setAccess] = useState<PushAccess>("unknown");

  useEffect(() => setNote(null), [id]);

  // Answered from remote URLs alone for repos you own, so this costs nothing
  // for almost every panel. Failures stay "unknown" and render nothing.
  useEffect(() => {
    let live = true;
    setAccess("unknown");
    api
      .access(id)
      .then((r) => {
        if (live) setAccess(r.access);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);

  if (!repo) return null;
  const st = repo.status;
  const files = st?.files ?? [];
  const hasStaged = files.some((f) => f.index !== "." && !f.untracked);

  const showError = (text: string) => setNote({ kind: "err", text });

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setNote(null);
    try {
      const out = await fn();
      if (typeof out === "string" && out) setNote({ kind: "ok", text: out });
    } catch (err) {
      setNote({
        kind: "err",
        text: String(err instanceof Error ? err.message : err),
      });
    } finally {
      setBusy(null);
    }
  };

  const suggest = () =>
    run("suggest", async () => {
      const s = await api.suggest(id);
      setMessage(s.message);
      return s.source === "heuristic"
        ? "claude CLI not reachable — heuristic message used"
        : undefined;
    });

  // commit + push is the one-click path: it fills in a blank message and an
  // empty stage instead of refusing. Plain commit stays strict, so the
  // checkboxes remain a way to commit exactly one thing.
  const doCommit = (thenPush: boolean) =>
    run(thenPush ? "commit+push" : "commit", async () => {
      if (files.length === 0) throw new Error("nothing to commit");

      let msg = message.trim();
      let heuristic = false;
      if (!msg) {
        if (!thenPush) throw new Error("write or suggest a message first");
        const s = await api.suggest(id);
        msg = s.message.trim();
        heuristic = s.source === "heuristic";
        if (!msg) throw new Error("could not generate a commit message");
        setMessage(msg);
      }

      // Only auto-stage when nothing is staged at all — an explicit checkbox
      // selection must never be widened into `git add -A`.
      const autoStage = !hasStaged && !stageAll;
      if (autoStage && !thenPush)
        throw new Error("nothing staged — tick “stage everything”");

      await api.commit(id, msg, stageAll || autoStage);
      setMessage("");
      if (thenPush) await api.push(id);

      const done = thenPush ? "committed and pushed" : "committed";
      const extras = [
        autoStage ? "staged everything" : null,
        heuristic ? "heuristic message — claude CLI unreachable" : null,
      ].filter(Boolean);
      return extras.length ? `${done} (${extras.join("; ")})` : done;
    });

  return (
    <section
      className={`panel s-${stateOf(repo)}`}
      aria-label={repo.name}
      hidden={hidden}
      style={{ "--panel-w": `${width}px` } as CSSProperties}
    >
      {/* Everything but the shells scrolls in here; the shells sit below it,
          along the panel's bottom edge, whatever the scroll position. */}
      <div className="panel-body">
      <header className="panel-head">
        <span className="glyph">{GLYPH[stateOf(repo)]}</span>
        <span className="panel-name" title={repo.path}>
          {repo.id}
        </span>
        {repo.link && <RepoLink url={repo.link} name={repo.name} labeled />}
        <span className="spacer" />
        <RepoMenu repo={repo} onError={showError} />
        <button
          type="button"
          className="mini close"
          onClick={() => closePanel(id)}
          aria-label={`Close ${repo.name}`}
        >
          ✕
        </button>
      </header>

      {!repo.host && !repo.forge && (
        <a
          className="panel-library"
          href={`?view=library&project=${encodeURIComponent(repo.path)}`}
        >
          Library · tags, notes, links & dev server →
        </a>
      )}
      {repo.description && (
        <p className="panel-desc" title={repo.description}>
          {repo.description}
        </p>
      )}

      <div className="panel-sub">
        <span className="branch">{st?.branch ?? "—"}</span>
        {st?.upstream && <span className="upstream">⇢ {st.upstream}</span>}
        {(st?.ahead ?? 0) > 0 && <span className="ahead">↑{st?.ahead}</span>}
        {(st?.behind ?? 0) > 0 && <span className="behind">↓{st?.behind}</span>}
        {st?.tip && <RemoteTipChip tip={st.tip} upstream={st.upstream} />}
        <PeerChips st={repo.peers} />
        {repo.pulls && <Pulls pulls={repo.pulls} name={repo.name} />}
        <span className="when">{ago(st?.lastCommit?.at)}</span>
        {st?.user && (
          <span
            className="who"
            title={`commits as ${st.user.name} <${st.user.email}>`}
          >
            {st.user.name || st.user.email}
          </span>
        )}
      </div>

      {(repoFlow || repoRun) && (
        <div className="panel-run">
          {repoActiveFlow ? (
            <FlowChip flow={repoActiveFlow} long />
          ) : repoRun ? (
            <RunChip run={repoRun} long />
          ) : (
            repoFlow && <FlowChip flow={repoFlow} long />
          )}
        </div>
      )}

      <div className="panel-actions">
        {OPENER_IDS.filter((app) => openers.includes(app)).map((app) => (
          <button
            key={app}
            type="button"
            className="mini"
            title={
              app === "agent"
                ? "Start an interactive Claude Code session in a terminal here"
                : app === "herdr"
                  ? "Open this repo as a herdr workspace with Claude Code running in it"
                  : undefined
            }
            onClick={() =>
              void run(`open-${app}`, async () => {
                await openApp(id, app);
              })
            }
          >
            {app}
          </button>
        ))}
        {!openers.includes("code") && !repo.host && !repo.forge && backend.sshHost && (
          <a
            className="mini"
            href={`vscode-remote://ssh-remote+${backend.sshHost}${repo.path}`}
            title="Open this repo in VS Code over Remote-SSH on your own machine"
          >
            code ↗
          </a>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="mini"
          disabled={busy !== null}
          onClick={() => void run("pull", async () => (await api.pull(id)).out)}
        >
          pull
        </button>
        <button
          type="button"
          className="mini"
          // A branch with no upstream reports ahead: 0 but still needs its
          // first push, so only a tracked-and-level branch disables this.
          disabled={busy !== null || ((st?.ahead ?? 0) === 0 && !!st?.upstream)}
          onClick={() => void run("push", async () => (await api.push(id)).out)}
        >
          {busy === "push"
            ? "pushing…"
            : `push${st?.ahead ? ` ↑${st.ahead}` : ""}`}
        </button>
      </div>

      {access === "denied" && (
        <p className="panel-hint">
          No remote accepts your pushes. Fork the repo, then add your copy as a
          remote to push this branch.
        </p>
      )}

      <div className="panel-ws">
        <WorkspaceMenu repo={repo} onError={showError} />
      </div>

      {repo.error ? (
        <p className="panel-error">Could not read this repo: {repo.error}</p>
      ) : (
        <>
          <button
            type="button"
            className={`panel-label fold${changesClosed ? "" : " open"}`}
            aria-expanded={!changesClosed}
            onClick={() => toggleSection(id, "changes")}
          >
            changes <span>{files.length}</span>
          </button>
          {!changesClosed &&
            (files.length === 0 ? (
              <p className="panel-clean">Working tree clean.</p>
            ) : (
              <ChangesList repo={repo} files={files} onError={showError} />
            ))}

          {!changesClosed && files.length > 0 && (
            <div className="commit-box">
              <textarea
                placeholder="commit message"
                value={message}
                rows={3}
                onChange={(e) => setMessage(e.target.value)}
              />
              <div className="commit-row">
                <button
                  type="button"
                  className="mini"
                  disabled={busy !== null}
                  onClick={() => void suggest()}
                >
                  {busy === "suggest" ? "thinking…" : "suggest"}
                </button>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={stageAll}
                    onChange={(e) => setStageAll(e.target.checked)}
                  />
                  stage everything
                </label>
                <span className="spacer" />
                <button
                  type="button"
                  className="mini strong"
                  disabled={busy !== null}
                  onClick={() => void doCommit(false)}
                >
                  {busy === "commit" ? "committing…" : "commit"}
                </button>
                <button
                  type="button"
                  className="mini strong"
                  disabled={busy !== null}
                  title="Suggests a message and stages everything if you left either blank"
                  onClick={() => void doCommit(true)}
                >
                  {busy === "commit+push" ? "working…" : "commit + push"}
                </button>
              </div>
            </div>
          )}

          <SearchSection repo={repo} />
          <History repo={repo} />
          <PeersSection repo={repo} />
          <LaunchSection repo={repo} />
          <ClaudeSection repo={repo} />
        </>
      )}
      {note && <p className={`note ${note.kind}`}>{note.text}</p>}
      </div>
      {!repo.error && <PanelShells repo={repo} />}
    </section>
  );
}

/** The tab strip of a tabbed dock: one tab per open panel, the showing one
 *  lit, each with the repo's state glyph and its own close. Arrow keys move
 *  along the strip, wrapping at either end, and take the focus with them. */
function DockTabs({ panels, active }: { panels: string[]; active: string | null }) {
  const repos = useStore((s) => s.repos);
  const showPanel = useStore((s) => s.showPanel);
  const closePanel = useStore((s) => s.closePanel);
  const strip = useRef<HTMLDivElement>(null);
  // the strip scrolls without a scrollbar, so the showing tab must be kept
  // in sight itself: a card click far down the list opens a tab far right
  useEffect(() => {
    strip.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  const step = (from: HTMLElement, by: 1 | -1) => {
    const row = from.parentElement;
    if (!row) return;
    const next =
      by === 1
        ? (from.nextElementSibling ?? row.firstElementChild)
        : (from.previousElementSibling ?? row.lastElementChild);
    const id = next instanceof HTMLElement ? next.dataset.id : undefined;
    if (id === undefined || !(next instanceof HTMLElement)) return;
    showPanel(id);
    next.focus();
  };
  return (
    <div className="dock-tabs" role="tablist" aria-label="Open repos" ref={strip}>
      {panels.map((id) => {
        const repo = repos.find((r) => r.id === id);
        if (!repo) return null;
        const on = id === active;
        const state = stateOf(repo);
        return (
          <div
            key={id}
            role="tab"
            tabIndex={on ? 0 : -1}
            aria-selected={on}
            data-id={id}
            className={`dock-tab s-${state}${on ? " on" : ""}`}
            title={repo.path}
            onClick={() => showPanel(id)}
            // middle click closes, as browser tabs do
            onAuxClick={(e) => {
              if (e.button === 1) closePanel(id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                showPanel(id);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                step(e.currentTarget, 1);
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                step(e.currentTarget, -1);
              }
            }}
          >
            <span className="glyph" aria-hidden="true">
              {GLYPH[state]}
            </span>
            <span className="dock-tab-name">{repo.id}</span>
            <button
              type="button"
              className="term-x"
              aria-label={`Close the ${repo.name} tab`}
              title="close"
              onClick={(e) => {
                e.stopPropagation();
                closePanel(id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The panels pinned open on the right. Side by side by default, each with a
 * handle on its left edge; with `openIn: "tabs"` one panel's width with a
 * tab strip across the top, the open panels behind it, one showing. The
 * panels are the same keyed children of the same element in both layouts,
 * so flipping the setting moves them rather than remounting them: a shell in
 * a panel keeps its pty across the switch.
 */
export function Dock() {
  const panels = useStore((s) => s.panels);
  const panelWidths = useStore((s) => s.panelWidths);
  const setPanelWidth = useStore((s) => s.setPanelWidth);
  const tabbed = useStore((s) => s.settings.openIn === "tabs");
  const active = useStore((s) => s.activePanel);
  const dockWidth = useStore((s) => s.dockWidth);
  const setDockWidth = useStore((s) => s.setDockWidth);
  if (panels.length === 0) return null;
  // a stale active (never set, or pruned) shows the first tab rather than
  // an empty dock with a strip of tabs above it
  const showing = !tabbed
    ? null
    : active !== null && panels.includes(active)
      ? active
      : (panels[0] ?? null);
  return (
    <div
      className={tabbed ? "dock tabbed" : "dock"}
      // the tabbed dock's one width lives on the dock itself, where the grid
      // columns read it and the handle writes it live
      style={tabbed ? ({ "--panel-w": `${dockWidth}px` } as CSSProperties) : undefined}
    >
      {tabbed && (
        <>
          <Resizer
            className="panel-resizer"
            label="Width of the dock"
            value={dockWidth}
            min={DOCK.min}
            max={DOCK.max}
            initial={DOCK.initial}
            dir={-1}
            cssVar="--panel-w"
            target={(h) => h.parentElement}
            onCommit={setDockWidth}
          />
          <DockTabs panels={panels} active={showing} />
        </>
      )}
      {panels.flatMap((id) => {
        if (tabbed) {
          return [<RepoPanel key={id} id={id} width={dockWidth} hidden={id !== showing} />];
        }
        const width = panelWidths[id] ?? PANEL.initial;
        return [
          <Resizer
            key={`edge:${id}`}
            className="panel-resizer"
            label={`Width of the ${id} panel`}
            value={width}
            min={PANEL.min}
            max={PANEL.max}
            initial={PANEL.initial}
            // the handle sits on the panel's left edge, so rightwards shrinks it
            dir={-1}
            cssVar="--panel-w"
            target={(h) => h.nextElementSibling as HTMLElement | null}
            onCommit={(px) => setPanelWidth(id, px)}
          />,
          <RepoPanel key={id} id={id} width={width} />,
        ];
      })}
    </div>
  );
}

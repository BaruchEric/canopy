import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import { closedIn, useStore } from "../store";
import { duration, fmtTokens, toolLine, usd, when } from "../util";
import { CommitRow } from "./Commit";
import { Rings } from "./Rings";
import { Seg } from "./Seg";
import {
  HISTORY_WINDOWS,
  historyFor,
  type HistoryHit,
  type HistoryOverview,
  type HistorySession,
  type HistorySessionDetail,
  type HistoryWindow,
  type Repo,
  type RepoHistory,
} from "../../../src/core/types";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

const WINDOWS = HISTORY_WINDOWS.map((w) => ({
  value: w,
  label: w === "all" ? "all" : w,
  title:
    w === "all"
      ? "Every session in the archive"
      : `Sessions started in the last ${w.slice(0, -1)} days`,
}));

/** How much of a reply shows before "more" is needed. */
const REPLY_CLAMP = 480;

/* ---------- the section on the panel ---------- */

export function ClaudeSection({ repo }: { repo: Repo }) {
  const overview = useStore((s) => s.history);
  const history = historyFor(overview, repo.id);
  const closed = useStore((s) => closedIn(s, repo.id, "claude"));
  const toggleSection = useStore((s) => s.toggleSection);

  const summary =
    overview === null
      ? "…"
      : !overview.available
        ? "—"
        : history
          ? `${history.sessions} · ${usd(history.costUsd)}`
          : "none";

  return (
    <section className="claude" aria-label="Claude sessions">
      <button
        type="button"
        className={`panel-label fold${closed ? "" : " open"}`}
        aria-expanded={!closed}
        onClick={() => toggleSection(repo.id, "claude")}
        title={
          history
            ? `${history.sessions} sessions in the archive, ${usd(history.costUsd)} API-equivalent all time`
            : undefined
        }
      >
        claude <span>{summary}</span>
      </button>
      {history && overview?.available && (
        <Rings tall history={history} days={overview.days} maxDay={overview.maxDay} />
      )}
      {!closed && <Body repo={repo} overview={overview} history={history} />}
    </section>
  );
}

function Body({
  repo,
  overview,
  history,
}: {
  repo: Repo;
  overview: HistoryOverview | null;
  history: RepoHistory | undefined;
}) {
  if (overview === null) return <p className="panel-clean">Reading the archive…</p>;
  if (!overview.available) {
    return (
      <p className="panel-hint">
        The archive is out of reach: {overview.reason}
      </p>
    );
  }
  if (!history) {
    return (
      <p className="panel-clean">
        No Claude sessions recorded for this repo. claude-history picks up new
        transcripts on its hourly sync.
      </p>
    );
  }
  return <Sessions repo={repo} />;
}

/* ---------- the list, or the search that replaces it ---------- */

/** A search hit folded into a session row: bm25 order, one row per session,
 *  the best snippet kept. */
interface Found {
  id: string;
  started_at: string | null;
  title: string | null;
  role: string;
  snippet: string;
}

function foldHits(hits: HistoryHit[]): Found[] {
  const out: Found[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.session_id)) continue;
    seen.add(h.session_id);
    out.push({
      id: h.session_id,
      started_at: h.started_at,
      title: h.title,
      role: h.role,
      snippet: h.snippet,
    });
  }
  return out;
}

function Sessions({ repo }: { repo: Repo }) {
  const [window, setWindow] = useState<HistoryWindow>("30d");
  const [list, setList] = useState<HistorySession[] | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setList(null);
    setError(null);
    api
      .sessions(repo.id, window)
      .then((rows) => {
        if (live) setList(rows);
      })
      .catch((err: unknown) => {
        if (live) setError(errText(err));
      });
    return () => {
      live = false;
    };
  }, [repo.id, window]);

  const search = async () => {
    const q = query.trim();
    if (!q) {
      setFound(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setFound(foldHits(await api.search(repo.id, q)));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const clearSearch = () => {
    setQuery("");
    setFound(null);
    setError(null);
  };

  const toggle = (id: string) => setExpanded(expanded === id ? null : id);

  return (
    <>
      <div className="sess-tools">
        <input
          type="search"
          className="sess-search"
          placeholder="search these sessions"
          aria-label="Search this repo's Claude sessions"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value.trim()) setFound(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
            if (e.key === "Escape") clearSearch();
          }}
        />
        {found ? (
          <button type="button" className="mini" onClick={clearSearch}>
            clear
          </button>
        ) : (
          <Seg
            label="How far back to list"
            className="seg-window"
            value={window}
            options={WINDOWS}
            onChange={setWindow}
          />
        )}
      </div>

      {error && <p className="panel-error">{error}</p>}

      {found ? (
        found.length === 0 ? (
          <p className="panel-clean">No matches for “{query.trim()}”.</p>
        ) : (
          <ul className="sess-list">
            {found.map((f) => (
              <li key={f.id} className={`sess${expanded === f.id ? " open" : ""}`}>
                <button
                  type="button"
                  className="sess-row"
                  aria-expanded={expanded === f.id}
                  onClick={() => toggle(f.id)}
                >
                  <span className="sess-when">{when(f.started_at)}</span>
                  <span className="sess-title">{f.title ?? "untitled"}</span>
                  <span className="sess-cost">{f.role === "user" ? "you" : "claude"}</span>
                </button>
                <p className="sess-snip">
                  <Snippet text={f.snippet} />
                </p>
                {expanded === f.id && <Detail repo={repo} id={f.id} />}
              </li>
            ))}
          </ul>
        )
      ) : busy ? (
        <p className="panel-clean">Searching…</p>
      ) : list === null ? (
        error ? null : <p className="panel-clean">Reading sessions…</p>
      ) : list.length === 0 ? (
        <p className="panel-clean">
          {window === "all"
            ? "No sessions with any turns in the archive."
            : `Nothing in the last ${window.slice(0, -1)} days.`}
        </p>
      ) : (
        <ul className="sess-list">
          {list.map((s) => (
            <li key={s.id} className={`sess${expanded === s.id ? " open" : ""}`}>
              <button
                type="button"
                className="sess-row"
                aria-expanded={expanded === s.id}
                onClick={() => toggle(s.id)}
                title={s.first_prompt ?? undefined}
              >
                <span className="sess-when">{when(s.started_at)}</span>
                <span className="sess-title">
                  {s.title ?? s.first_prompt ?? "untitled"}
                </span>
                {s.host !== "mac" && <span className="host">{s.host}</span>}
                <span className="sess-cost">{usd(s.cost)}</span>
              </button>
              {expanded === s.id && <Detail repo={repo} id={s.id} />}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** claude-history marks matches with square brackets; they become <mark>s. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[([^\]]+)\]/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>,
      )}
    </>
  );
}

/* ---------- one session, turn by turn ---------- */

function Detail({ repo, id }: { repo: Repo; id: string }) {
  const [detail, setDetail] = useState<HistorySessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [drilled, setDrilled] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    api
      .session(repo.id, id)
      .then((d) => {
        if (live) setDetail(d);
      })
      .catch((err: unknown) => {
        if (live) setError(errText(err));
      });
    return () => {
      live = false;
    };
  }, [repo.id, id]);

  const openNote = async () => {
    setNote(null);
    try {
      await api.openNote(repo.id, id);
    } catch (err) {
      setNote(errText(err));
    }
  };

  if (error) return <p className="panel-error">{error}</p>;
  if (!detail) return <p className="panel-clean sess-loading">Reading the transcript…</p>;

  const s = detail.session;
  const models = modelsOf(s.models);
  const ms =
    s.started_at && s.ended_at ? Date.parse(s.ended_at) - Date.parse(s.started_at) : null;
  const tokens = s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens;
  const facts = [
    s.host !== "mac" ? `on ${s.host}` : null,
    s.git_branch,
    ...models,
    ms !== null ? duration(ms) : null,
    `${s.turns} ${s.turns === 1 ? "turn" : "turns"}`,
    `${s.tool_calls} tools`,
    `${fmtTokens(tokens)} tokens`,
    usd(s.cost_usd),
    detail.subagents.length
      ? `${detail.subagents.length} ${detail.subagents.length === 1 ? "subagent" : "subagents"}`
      : null,
    detail.commits.length
      ? `${detail.commits.length} ${detail.commits.length === 1 ? "commit" : "commits"}`
      : null,
    s.source_present ? null : "transcript gone, mirror kept",
  ].filter((f): f is string => Boolean(f));

  return (
    <div className="sess-detail">
      <div className="facts">
        {facts.map((f) => (
          <span key={f} className="branch">
            {f}
          </span>
        ))}
        <span className="spacer" />
        <button type="button" className="mini" onClick={() => void openNote()}>
          open note
        </button>
      </div>
      {note && <p className="note err">{note}</p>}

      <ol className="steps turns">
        {detail.turns.map((t) => {
          const tools = detail.tools.filter((x) => x.turn_idx === t.idx);
          const cost = t.cost_usd ?? 0;
          return (
            <li key={t.idx} className="step k-text">
              <span className="node" />
              <div className="step-body">
                <span className="step-title">
                  {t.prompt_kind === "command" && <span className="cmd">/ </span>}
                  {t.prompt}
                </span>
                {t.reply && <Reply text={t.reply} />}
                {(tools.length > 0 || cost > 0) && (
                  <details className="step-out">
                    <summary>
                      {tools.length} {tools.length === 1 ? "tool" : "tools"} · {usd(cost)}
                      {t.thinking_tokens > 0 && ` · ${fmtTokens(t.thinking_tokens)} thinking`}
                    </summary>
                    {tools.length > 0 && (
                      <ul className="tool-list">
                        {tools.map((tc, i) => (
                          <li key={i} className={tc.is_error ? "st-error" : undefined}>
                            <b>{tc.name}</b>
                            <span>{toolLine(tc.name, tc.input)}</span>
                            {tc.duration_ms !== null && (
                              <em>{duration(tc.duration_ms)}</em>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {detail.commits.length > 0 && (
        <ul className="log sess-commits">
          {detail.commits.map((c) => (
            <CommitRow
              key={c.hash}
              repo={repo}
              hash={c.hash}
              subject={c.subject}
              meta={when(c.ts)}
              open={drilled === c.hash}
              onToggle={() => setDrilled(drilled === c.hash ? null : c.hash)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Reply({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const long = text.length > REPLY_CLAMP;
  return (
    <p className="step-text reply">
      {full || !long ? text : `${text.slice(0, REPLY_CLAMP).trimEnd()}…`}
      {long && (
        <>
          {" "}
          <button type="button" className="more-link" onClick={() => setFull(!full)}>
            {full ? "less" : "more"}
          </button>
        </>
      )}
    </p>
  );
}

/** The session's models, from the JSON object claude-history keeps. */
function modelsOf(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v).filter((k) => !k.startsWith("<"));
    }
  } catch {
    // an older row, or nothing recorded
  }
  return [];
}

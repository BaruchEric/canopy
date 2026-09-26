import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { groupHits, markHit } from "../hits";
import { helperFor, useStore, visibleRepos } from "../store";
import { Section } from "./Surface";
import type { GrepHit, GrepRepoResult, GrepResult, Repo } from "../../../src/core/types";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/* ---------- the hits of one repo, by file ---------- */

/** One matched line: the number, the text with the match lit, and a click
 *  that opens the file there in VS Code. */
function HitRow({
  repo,
  hit,
  len,
  onError,
}: {
  repo: Repo;
  hit: GrepHit;
  len: number;
  onError: (msg: string) => void;
}) {
  const { before, match, after } = markHit(hit.text, hit.col, len);
  return (
    <li>
      <button
        type="button"
        className="grep-hit"
        title={`Open ${hit.file}:${hit.line} in VS Code`}
        onClick={() => api.openFile(repo.id, hit.file, hit.line, helperFor(useStore.getState())).catch((e: unknown) => onError(errText(e)))}
      >
        <span className="grep-line">{hit.line}</span>
        <span className="grep-text">
          {before}
          <mark>{match}</mark>
          {after}
        </span>
      </button>
    </li>
  );
}

function RepoHits({
  repo,
  result,
  len,
  onError,
}: {
  repo: Repo;
  result: GrepResult;
  len: number;
  onError: (msg: string) => void;
}) {
  return (
    <>
      {groupHits(result.hits).map((g) => (
        <div key={g.file} className="grep-file">
          <div className="grep-path" title={g.file}>
            {g.file} <span>{g.hits.length}</span>
          </div>
          <ul className="grep-hits">
            {g.hits.map((h) => (
              <HitRow key={`${h.line}:${h.col}`} repo={repo} hit={h} len={len} onError={onError} />
            ))}
          </ul>
        </div>
      ))}
      {result.truncated && (
        <p className="panel-clean grep-more">More matches than shown. Narrow the search.</p>
      )}
    </>
  );
}

/** The box both surfaces share: Enter searches, Escape clears. */
function SearchBox({
  value,
  placeholder,
  label,
  busy,
  onChange,
  onSearch,
  onClear,
  inputRef,
}: {
  value: string;
  placeholder: string;
  label: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSearch: () => void;
  onClear: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="grep-tools">
      <input
        ref={inputRef}
        type="search"
        className="sess-search"
        placeholder={placeholder}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSearch();
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onClear();
          }
        }}
      />
      <button type="button" className="mini" disabled={busy || !value.trim()} onClick={onSearch}>
        {busy ? "searching…" : "search"}
      </button>
    </div>
  );
}

/* ---------- the panel section: one repo ---------- */

export function SearchSection({ repo }: { repo: Repo }) {
  const pending = useStore((s) => s.pendingSearch);
  const takePending = useStore((s) => s.takePendingSearch);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string; result: GrepResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (q: string) => {
    const term = q.trim();
    if (!term) {
      setFound(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setFound({ q: term, result: await api.grep(repo.id, term) });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  // A term handed over from the sheet runs the moment it lands here.
  useEffect(() => {
    if (!pending || pending.repoId !== repo.id) return;
    takePending();
    setQuery(pending.q);
    void run(pending.q);
  }, [pending, repo.id]);

  const clear = () => {
    setQuery("");
    setFound(null);
    setError(null);
  };

  const count = found ? found.result.hits.length : null;
  // a pasted term is searched at once; grep takes one line
  const paste = (text: string) => {
    const q = (text.split("\n")[0] ?? "").trim();
    setQuery(q);
    void run(q);
  };

  return (
    <Section
      repo={repo}
      k="search"
      className="grep"
      label="Search this repo's files"
      head={count === null ? "" : `${count}${found?.result.truncated ? "+" : ""}`}
      paste={paste}
    >
      <SearchBox
        value={query}
        placeholder="search this repo's files"
        label="Search this repo's files"
        busy={busy}
        onChange={(v) => {
          setQuery(v);
          if (!v.trim()) setFound(null);
        }}
        onSearch={() => void run(query)}
        onClear={clear}
      />
      {error && <p className="panel-error">{error}</p>}
      {found &&
        (found.result.hits.length === 0 ? (
          <p className="panel-clean">No matches for “{found.q}”.</p>
        ) : (
          <RepoHits repo={repo} result={found.result} len={found.q.length} onError={setError} />
        ))}
    </Section>
  );
}

/* ---------- the sheet: every repo in view ---------- */

export function SearchSheet() {
  const close = useStore((s) => s.closeSheet);
  const query = useStore((s) => s.searchQuery);
  const setQuery = useStore((s) => s.setSearchQuery);
  const searchIn = useStore((s) => s.searchIn);
  const repos = useStore(useShallow(visibleRepos));
  const byId = useStore((s) => s.repos);
  const [found, setFound] = useState<{ q: string; rows: GrepRepoResult[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = async () => {
    const term = query.trim();
    if (!term) return;
    // Forge listings have nothing to grep; the server would only say so.
    const ids = repos.filter((r) => !r.forge && !r.error).map((r) => r.id);
    setBusy(true);
    setError(null);
    try {
      const rows = (await api.grepAll(term, ids)).filter((r) => r.hits.length > 0 || r.error);
      setFound({ q: term, rows });
      setOpen(rows[0]?.repo ?? null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    setQuery("");
    setFound(null);
    setError(null);
  };

  const total = found ? found.rows.reduce((n, r) => n + r.hits.length, 0) : 0;
  const any = found ? found.rows.some((r) => r.truncated) : false;
  const scope = `${repos.length} repo${repos.length === 1 ? "" : "s"} in view`;

  return (
    <>
      <header className="sheet-head">
        <div>
          <h2 className="sheet-title">search files</h2>
          <p className="sheet-hint">{scope}</p>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="sheet-body grep-sheet">
        <SearchBox
          value={query}
          placeholder="a word, a name, a string…"
          label="Search file contents"
          busy={busy}
          onChange={setQuery}
          onSearch={() => void run()}
          onClear={clear}
          inputRef={inputRef}
        />
        {error && <p className="panel-error">{error}</p>}
        {found &&
          (found.rows.length === 0 ? (
            <p className="panel-clean">No matches for “{found.q}” in {scope}.</p>
          ) : (
            <>
              <p className="grep-sum">
                {total}
                {any ? "+" : ""} match{total === 1 ? "" : "es"} in {found.rows.length} repo
                {found.rows.length === 1 ? "" : "s"}
              </p>
              {found.rows.map((row) => {
                const repo = byId.find((r) => r.id === row.repo);
                if (!repo) return null;
                const isOpen = open === row.repo;
                return (
                  <div key={row.repo} className={isOpen ? "grep-repo open" : "grep-repo"}>
                    <div className="grep-repo-head">
                      <button
                        type="button"
                        className="grep-repo-name"
                        aria-expanded={isOpen}
                        onClick={() => setOpen(isOpen ? null : row.repo)}
                      >
                        {row.repo}
                        <span>{row.error ? "—" : `${row.hits.length}${row.truncated ? "+" : ""}`}</span>
                      </button>
                      {!row.error && (
                        <button
                          type="button"
                          className="mini"
                          title="Open this repo's panel with the search there"
                          onClick={() => searchIn(row.repo, found.q)}
                        >
                          panel
                        </button>
                      )}
                    </div>
                    {row.error ? (
                      <p className="panel-error">{row.error}</p>
                    ) : (
                      isOpen && (
                        <RepoHits repo={repo} result={row} len={found.q.length} onError={setError} />
                      )
                    )}
                  </div>
                );
              })}
            </>
          ))}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">Enter searches · a click opens the line in VS Code</span>
        <span className="spacer" />
        <button type="button" className="mini" onClick={close}>
          close
        </button>
      </footer>
    </>
  );
}

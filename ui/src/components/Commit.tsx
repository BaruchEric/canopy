import { useEffect, useState } from "react";
import { api } from "../api";
import { when } from "../util";
import { DiffView } from "./DiffView";
import type { CommitDetail, CommitFile, Repo } from "../../../src/core/types";

/** A commit never changes once it has a hash, so one read serves the whole
 *  session; reopening a row is instant. */
const details = new Map<string, CommitDetail>();

/** One commit in a log: the row, and the drill beneath it when open. */
export function CommitRow({
  repo,
  hash,
  subject,
  meta,
  open,
  onToggle,
}: {
  repo: Repo;
  hash: string;
  subject: string;
  /** the row's right-hand words: who and when */
  meta: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className={`rev${open ? " open" : ""}`}>
      <button
        type="button"
        className="log-row"
        aria-expanded={open}
        onClick={onToggle}
        title={open ? undefined : subject}
      >
        <code className="log-hash">{hash.slice(0, 7)}</code>
        <span className="log-subject">{subject}</span>
        <span className="log-meta">{meta}</span>
      </button>
      {open && <Detail repo={repo} hash={hash} />}
    </li>
  );
}

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

function Detail({ repo, hash }: { repo: Repo; hash: string }) {
  const key = `${repo.id}\0${hash}`;
  const [detail, setDetail] = useState<CommitDetail | null>(
    () => details.get(key) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (details.has(key)) return;
    let live = true;
    api
      .show(repo.id, hash)
      .then((d) => {
        details.set(key, d);
        if (live) setDetail(d);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [key, repo.id, hash]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  if (error) return <p className="panel-error rev-error">{error}</p>;
  if (!detail) return <p className="panel-clean rev-loading">Reading the commit…</p>;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(detail.hash);
      setCopied(true);
    } catch {
      // no clipboard here; the hash is still on screen to select
    }
  };

  let added = 0;
  let deleted = 0;
  let binary = 0;
  let max = 0;
  for (const f of detail.files) {
    if (f.added === null || f.deleted === null) {
      binary++;
      continue;
    }
    added += f.added;
    deleted += f.deleted;
    max = Math.max(max, f.added + f.deleted);
  }

  return (
    <div className="rev-detail">
      <div className="rev-head">
        <button
          type="button"
          className="rev-hash"
          onClick={() => void copy()}
          title="Copy the full hash"
        >
          {detail.hash}
        </button>
        {copied && <span className="rev-copied">copied</span>}
        <span className="rev-who" title={detail.email}>
          {detail.author}
        </span>
        <span className="rev-when">
          {when(new Date(detail.at * 1000).toISOString())}
        </span>
      </div>
      {detail.body && <pre className="rev-body">{detail.body}</pre>}

      <div className="rev-sum">
        <span>{plural(detail.files.length, "file")}</span>
        {added > 0 && <span className="n-add">+{added}</span>}
        {deleted > 0 && <span className="n-del">−{deleted}</span>}
        {binary > 0 && <span>{plural(binary, "binary")}</span>}
        {detail.parents.length > 1 && (
          <span title="Shown against the first parent">
            merge of {detail.parents.length}
          </span>
        )}
      </div>
      {detail.files.length === 0 ? (
        <p className="rev-empty">No files changed.</p>
      ) : (
        <ul className="rev-files">
          {detail.files.map((f) => (
            <FileLine
              key={f.path}
              repo={repo}
              commit={detail.hash}
              file={f}
              max={max}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The widest a file's bar gets, in px: the file with the most changed lines
 *  in this commit fills it, every other file scales against that one on a
 *  square-root ramp, so one big file does not flatten the rest to dots. */
const BAR = 48;

function FileLine({
  repo,
  commit,
  file,
  max,
}: {
  repo: Repo;
  commit: string;
  file: CommitFile;
  max: number;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetched once: a commit's diff of a file is as fixed as the commit.
  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    if (diff === null) {
      try {
        const r = await api.commitDiff(repo.id, commit, file.path, file.orig);
        setDiff(r.diff);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setError(null);
    setOpen(true);
  };

  // Binary files have no line counts and get no bar.
  const lines =
    file.added !== null && file.deleted !== null
      ? { added: file.added, deleted: file.deleted }
      : null;
  const total = lines ? lines.added + lines.deleted : 0;
  // At least a sliver, so a one-line change is still a mark and not a gap.
  const width =
    lines && max > 0 ? Math.max(2, Math.sqrt(total / max) * BAR) : 0;
  const addW = lines && total > 0 ? (width * lines.added) / total : 0;
  const delW = width - addW;

  return (
    <li className="rev-file">
      <div className="rev-file-row">
        <span className={`mark m-${file.status}`}>{file.status}</span>
        <button
          type="button"
          className="file-name"
          aria-expanded={open}
          onClick={() => void toggle()}
          title={file.orig ? `${file.orig} → ${file.path}` : file.path}
        >
          {file.orig && (
            <>
              <span className="rev-orig">{file.orig}</span>
              <span className="rev-arrow"> → </span>
            </>
          )}
          {file.path}
        </button>
        <span className="rev-bar" aria-hidden="true">
          {addW > 0 && <i className="add" style={{ width: addW }} />}
          {delW > 0 && <i className="del" style={{ width: delW }} />}
        </span>
        <span className="rev-n">
          {lines ? (
            <>
              {lines.added > 0 && <span className="n-add">+{lines.added}</span>}
              {lines.deleted > 0 && (
                <span className="n-del">−{lines.deleted}</span>
              )}
            </>
          ) : (
            <span className="n-bin">bin</span>
          )}
        </span>
      </div>
      {error && <p className="panel-error rev-error">{error}</p>}
      {open && diff !== null && <DiffView diff={diff} />}
    </li>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import {
  baseName,
  crumbs,
  dirExists,
  dirOf,
  entriesAt,
  findFiles,
  isHtml,
  isMarkdown,
  isRelative,
  linesOf,
  loadPlace,
  looksBinary,
  MEDIA_MAX,
  resolveRel,
  sandboxedPage,
  savePlace,
  sizeWord,
  stepOf,
  TEXT_MAX,
  withIgnored,
  type Entry,
  type FinderPlace,
} from "../finder";
import { backendOf } from "../registry";
import { loadRich, type Rich } from "../rich";
import { helperFor, useStore } from "../store";
import { Section } from "./Surface";
import { fileKind, type FileKind } from "../../../src/core/filekind";
import type { DirEntry, Repo, RepoFiles } from "../../../src/core/types";
import { CENTERED } from "../pop";
import { PopGear, PopGrip } from "./PopGrip";

/** the file viewer as a popup, for its grip and its gear */
const VIEWER_POP = { name: "sheet viewer", anchor: CENTERED, gap: 24 };

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** the most the download button asks for, the server's own cap */
const DOWNLOAD_MAX = 200 * 1024 * 1024;

const KIND_GLYPH: Record<FileKind, string> = {
  text: "≡",
  image: "▣",
  video: "▶",
  audio: "♪",
  pdf: "▤",
  binary: "◇",
};

/* ---------- one file's contents ---------- */

type Loaded =
  | { state: "loading" }
  | { state: "error"; text: string }
  | { state: "text"; text: string; size: number }
  | { state: "media"; url: string; size: number }
  | { state: "binary"; size: number | null };

/** A file's bytes as the viewer needs them: decoded text, or an object URL
 *  for an image, a player or a PDF that lives as long as the caller does.
 *  `stamp` changes when the file does, which reads it again. */
function useFile(repoId: string, path: string, stamp: string): Loaded {
  const kind = fileKind(path);
  // what was read, tagged with the file and stamp it was read for: on the
  // render that names a new file, the old one's bytes must not show under
  // its name (a markdown page would fetch its images against the new path)
  const key = `${repoId}\0${path}\0${stamp}`;
  const [read, setRead] = useState<{ key: string; got: Loaded }>({ key: "", got: { state: "loading" } });
  useEffect(() => {
    const setGot = (got: Loaded) => setRead({ key, got });
    if (kind === "binary") {
      setGot({ state: "binary", size: null });
      return;
    }
    let live = true;
    let url: string | null = null;
    setGot({ state: "loading" });
    api
      .rawFile(repoId, path, kind === "text" ? TEXT_MAX : MEDIA_MAX)
      .then(async (blob) => {
        if (!live) return;
        if (kind !== "text") {
          url = URL.createObjectURL(blob);
          setGot({ state: "media", url, size: blob.size });
          return;
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!live) return;
        if (looksBinary(bytes)) setGot({ state: "binary", size: blob.size });
        else setGot({ state: "text", text: new TextDecoder().decode(bytes), size: blob.size });
      })
      .catch((err: unknown) => live && setGot({ state: "error", text: errText(err) }));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [repoId, path, kind, stamp, key]);
  return read.key === key ? read.got : { state: "loading" };
}

/** the rich half (colours, markdown), once it has loaded; null until then
 *  and if it fails, when text is drawn plain */
function useRich(): Rich | null {
  const [rich, setRich] = useState<Rich | null>(null);
  useEffect(() => {
    let live = true;
    loadRich()
      .then((r) => live && setRich(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return rich;
}

/** Text with its line numbers in a gutter of their own, so a selection
 *  takes only the text, coloured by its language where it has one. */
function CodeView({ text, path }: { text: string; path: string }) {
  const rich = useRich();
  const { lines, total } = useMemo(() => linesOf(text), [text]);
  const gutter = useMemo(() => lines.map((_, i) => i + 1).join("\n"), [lines]);
  const plain = useMemo(() => lines.join("\n"), [lines]);
  // highlight.js escapes every character of the text it hands back
  const html = useMemo(() => rich?.highlight(plain, path) ?? null, [rich, plain, path]);
  return (
    <div className="finder-text">
      <div className="finder-code">
        <pre className="finder-gutter" aria-hidden="true">
          {gutter}
        </pre>
        {html === null ? <pre className="finder-lines">{plain}</pre> : <pre className="finder-lines hljs" dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
      {total > lines.length && (
        <p className="panel-clean finder-more">
          The first {lines.length} of {total} lines. Open it in the editor for the rest.
        </p>
      )}
    </div>
  );
}

/** Markdown drawn as a page. Its images come from the repo, fetched the way
 *  any file is; a link to another file in the repo opens that file here, and
 *  one off the page opens in a new tab. */
function MarkdownView({ repoId, text, path, onOpen }: { repoId: string; text: string; path: string; onOpen: (path: string) => void }) {
  const rich = useRich();
  const box = useRef<HTMLDivElement>(null);
  // sanitized by DOMPurify inside markdown()
  const html = useMemo(() => rich?.markdown(text) ?? null, [rich, text]);
  useEffect(() => {
    const el = box.current;
    if (!el || html === null) return;
    let live = true;
    const urls: string[] = [];
    for (const img of el.querySelectorAll<HTMLImageElement>("img[data-src]")) {
      const at = resolveRel(path, img.dataset["src"] ?? "");
      if (at === null) continue;
      api
        .rawFile(repoId, at, MEDIA_MAX)
        .then((blob) => {
          if (!live) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          img.src = url;
        })
        .catch(() => img.setAttribute("data-missing", ""));
    }
    return () => {
      live = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [html, repoId, path]);
  const click = (e: React.MouseEvent) => {
    const a = e.target instanceof Element ? e.target.closest("a") : null;
    const href = a?.getAttribute("href");
    if (!href) return;
    e.preventDefault();
    if (href.startsWith("#")) return;
    if (!isRelative(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    const at = resolveRel(path, href);
    if (at !== null) onOpen(at);
  };
  if (html === null) return <p className="panel-clean finder-note">Drawing {baseName(path)}…</p>;
  return <div ref={box} className="finder-md" onClick={click} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A repo's HTML drawn in a frame with every sandbox flag off, so no script
 *  runs and the page has no origin of its own, behind a policy that lets it
 *  fetch nothing. Its own images and styles from other files do not load. */
function HtmlView({ text, path }: { text: string; path: string }) {
  const doc = useMemo(() => sandboxedPage(text), [text]);
  return <iframe className="finder-html" sandbox="" srcDoc={doc} title={baseName(path)} />;
}

/** A text file: markdown and HTML as a page with a switch to the source,
 *  the rest as source. */
function TextView({ repoId, text, path, onOpen }: { repoId: string; text: string; path: string; onOpen: (path: string) => void }) {
  const [source, setSource] = useState(false);
  const md = isMarkdown(path);
  if (!md && !isHtml(path)) return <CodeView text={text} path={path} />;
  return (
    <div className="finder-text-wrap">
      <div className="finder-text-bar" role="group" aria-label="Show as">
        <button type="button" className={`mini${source ? "" : " on"}`} aria-pressed={!source} onClick={() => setSource(false)}>
          page
        </button>
        <button type="button" className={`mini${source ? " on" : ""}`} aria-pressed={source} onClick={() => setSource(true)}>
          source
        </button>
      </div>
      {source ? (
        <CodeView text={text} path={path} />
      ) : md ? (
        <MarkdownView repoId={repoId} text={text} path={path} onOpen={onOpen} />
      ) : (
        <HtmlView text={text} path={path} />
      )}
    </div>
  );
}

function FileBody({ repoId, path, stamp, big, onOpen }: { repoId: string; path: string; stamp: string; big: boolean; onOpen: (path: string) => void }) {
  const kind = fileKind(path);
  const got = useFile(repoId, path, stamp);
  const [actual, setActual] = useState(false);
  if (got.state === "loading") return <p className="panel-clean finder-note">Reading {baseName(path)}…</p>;
  if (got.state === "error") return <p className="panel-error finder-note">{got.text}</p>;
  if (got.state === "binary") {
    return (
      <p className="panel-clean finder-note">
        No preview for this kind of file{got.size === null ? "" : ` (${sizeWord(got.size)})`}.
      </p>
    );
  }
  if (got.state === "text") return <TextView repoId={repoId} text={got.text} path={path} onOpen={onOpen} />;
  if (kind === "image") {
    return (
      <div className={`finder-image${actual ? " actual" : ""}`}>
        <img
          src={got.url}
          alt={baseName(path)}
          title={big ? (actual ? "Fit to the window" : "Show at its own size") : undefined}
          onClick={big ? () => setActual((a) => !a) : undefined}
        />
      </div>
    );
  }
  if (kind === "video") return <video className="finder-media" src={got.url} controls preload="metadata" />;
  if (kind === "audio") return <audio className="finder-audio" src={got.url} controls preload="metadata" />;
  // a blob URL of a PDF only: the browser's own viewer runs it, and nothing
  // the repo wrote can run as this page
  return <iframe className="finder-pdf" src={got.url} title={baseName(path)} />;
}

/* ---------- the actions every view of a file has ---------- */

function FileActions({ repo, path, onError, onView }: { repo: Repo; path: string; onError: (msg: string) => void; onView?: () => void }) {
  const [busy, setBusy] = useState(false);
  const download = () => {
    setBusy(true);
    api
      .rawFile(repo.id, path, DOWNLOAD_MAX)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = baseName(path);
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })
      .catch((err: unknown) => onError(errText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <span className="finder-acts">
      {onView && (
        <button type="button" className="mini strong" onClick={onView} title="Open in the viewer (Space)">
          view
        </button>
      )}
      <button
        type="button"
        className="mini"
        title="Open the file in VS Code"
        onClick={() => api.openFile(repo.id, path, 1, helperFor(useStore.getState(), backendOf(repo.id))).catch((err: unknown) => onError(errText(err)))}
      >
        editor
      </button>
      <button type="button" className="mini" disabled={busy} onClick={download} title="Save a copy of the file">
        {busy ? "saving…" : "download"}
      </button>
    </span>
  );
}

/* ---------- the viewer ---------- */

/** One file large, over the page, stepping through the files of its folder
 *  (or of the search) with the arrow keys. */
function Viewer({
  repo,
  path,
  list,
  stamp,
  onPick,
  onOpen,
  onClose,
}: {
  repo: Repo;
  path: string;
  list: string[];
  stamp: (path: string) => string;
  onPick: (path: string) => void;
  /** a link in a markdown file to another file of the repo */
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const { prev, next, at } = stepOf(list, path);
  useEffect(() => setError(null), [path]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]");
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (!typing && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        // the list under the viewer must not take them and walk away
        e.preventDefault();
        e.stopPropagation();
        const to = e.key === "ArrowLeft" ? prev : next;
        if (to) onPick(to);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [prev, next, onPick, onClose]);
  return createPortal(
    <div className="sheet-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet finder-viewer" role="dialog" aria-modal="true" aria-label={`View ${path}`}>
        <header className="sheet-head">
          <div className="finder-viewer-title">
            <div className="eyebrow">
              {repo.name}
              {at >= 0 && list.length > 1 ? ` · ${at + 1} of ${list.length}` : ""}
            </div>
            <h2 className="sheet-title" title={path}>
              {path}
            </h2>
          </div>
          <button type="button" className="mini" disabled={!prev} onClick={() => prev && onPick(prev)} title="The file before (←)" aria-label="Previous file">
            ‹
          </button>
          <button type="button" className="mini" disabled={!next} onClick={() => next && onPick(next)} title="The file after (→)" aria-label="Next file">
            ›
          </button>
          <FileActions repo={repo} path={path} onError={setError} />
          <PopGear spec={VIEWER_POP} />
          <button type="button" className="mini close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {error && <p className="panel-error">{error}</p>}
        <div className="finder-viewer-body">
          <FileBody repoId={repo.id} path={path} stamp={stamp(path)} big onOpen={onOpen} />
        </div>
        <PopGrip {...VIEWER_POP} />
      </div>
    </div>,
    document.body,
  );
}

/* ---------- the panel section ---------- */

function Row({ entry, picked, onClick, onOpen }: { entry: Entry; picked: boolean; onClick: () => void; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (picked) ref.current?.scrollIntoView({ block: "nearest" });
  }, [picked]);
  return (
    <li>
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        className={`finder-row${entry.dir ? " dir" : ""}${entry.ignored ? " ignored" : ""}${picked ? " picked" : ""}`}
        title={entry.ignored ? `${entry.path} (git ignores it, or it holds no files)` : entry.path}
        onClick={onClick}
        onDoubleClick={onOpen}
      >
        <span className="finder-glyph" aria-hidden="true">
          {entry.dir ? "▸" : KIND_GLYPH[fileKind(entry.name)]}
        </span>
        <span className="finder-name">{entry.name}</span>
        {entry.dir && entry.count !== null && <span className="finder-count">{entry.count}</span>}
      </button>
    </li>
  );
}

/** A repo's files: the folders to walk, a search over every name, a quick
 *  look at the picked file, and the viewer for it at full size. */
export function FinderSection({ repo }: { repo: Repo }) {
  const [listing, setListing] = useState<RepoFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [place, setPlace] = useState(() => loadPlace(repo.id));
  const [query, setQuery] = useState("");
  /** the folder as the disk has it, for "show ignored": null until read */
  const [disk, setDisk] = useState<{ dir: string; entries: DirEntry[] } | null>(null);
  const [viewing, setViewing] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const { dir, file, hidden, ignored } = place;

  // a commit, or a file coming or going, lists the tree again
  const status = repo.status;
  const treeKey = `${status?.lastCommit?.hash ?? ""}|${(status?.files ?? []).map((f) => f.path).join("\0")}`;
  const load = useCallback(() => {
    setBusy(true);
    api
      .files(repo.id)
      .then((got) => {
        setListing(got);
        setError(null);
      })
      .catch((err: unknown) => setError(errText(err)))
      .finally(() => setBusy(false));
  }, [repo.id]);
  useEffect(load, [load, treeKey]);

  // "show ignored" reads the folder off the disk as well, each time it moves
  const [diskTick, setDiskTick] = useState(0);
  useEffect(() => {
    if (!ignored) return;
    let live = true;
    api
      .dir(repo.id, dir)
      .then((entries) => live && setDisk({ dir, entries }))
      .catch((err: unknown) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [ignored, repo.id, dir, treeKey, diskTick]);
  const refresh = () => {
    load();
    setDiskTick((t) => t + 1);
  };

  /** where the section is, kept per repo in this browser */
  const go = (patch: Partial<FinderPlace>) =>
    setPlace((prev) => {
      const next = { ...prev, ...patch };
      savePlace(repo.id, next);
      return next;
    });

  const files = listing?.files ?? [];
  // a folder that emptied out since it was left
  useEffect(() => {
    // an ignored folder is not in the listing at all
    if (listing && !ignored && !dirExists(listing.files, dir)) go({ dir: "", file: null });
  }, [listing, dir, ignored]);

  const found = useMemo(() => findFiles(files, query, hidden), [files, query, hidden]);
  const searching = query.trim() !== "";
  const entries: Entry[] = useMemo(
    () => {
      if (searching) return found.hits.map((p) => ({ name: p, path: p, dir: false, count: 0 }));
      const listed = entriesAt(files, dir, hidden);
      return ignored && disk?.dir === dir ? withIgnored(listed, disk.entries, dir, hidden) : listed;
    },
    [searching, found, files, dir, hidden, ignored, disk],
  );
  // the files the viewer steps through: the search's, or the folder's
  const steps = useMemo(() => entries.filter((e) => !e.dir).map((e) => e.path), [entries]);

  // a changed file's preview reads it again when it changes on disk
  const stamp = useCallback((p: string) => String(status?.files.find((f) => f.path === p)?.mtime ?? ""), [status]);

  const open = (e: Entry) => {
    if (e.dir) {
      go({ dir: e.path, file: null });
      setQuery("");
    } else {
      go({ dir: searching ? dir : dirOf(e.path), file: e.path });
      setViewing(true);
    }
  };
  /** a file named by a link: its folder, with it picked */
  const openPath = (p: string) => {
    setQuery("");
    go({ dir: dirOf(p), file: p });
  };
  const pick = (e: Entry) => (e.dir ? open(e) : go({ dir, file: e.path }));
  const up = () => dir !== "" && go({ dir: dirOf(dir), file: dir });

  const keys = (ev: React.KeyboardEvent) => {
    if (ev.target instanceof HTMLInputElement) return;
    const at = entries.findIndex((e) => e.path === file);
    const move = (to: number) => {
      const e = entries[Math.max(0, Math.min(entries.length - 1, to))];
      if (e) go({ dir, file: e.path });
    };
    const here = entries[at];
    if (ev.key === "ArrowDown") move(at + 1);
    else if (ev.key === "ArrowUp") move(at < 0 ? entries.length - 1 : at - 1);
    else if ((ev.key === "Enter" || ev.key === "ArrowRight") && here) open(here);
    else if (ev.key === " " && here && !here.dir) setViewing(true);
    else if ((ev.key === "Backspace" || ev.key === "ArrowLeft") && !searching) up();
    else return;
    ev.preventDefault();
  };

  const picked = file !== null && !entries.find((e) => e.path === file)?.dir ? file : null;
  useEffect(() => {
    if (!picked) setViewing(false);
  }, [picked]);
  const head = listing ? `${files.length}${listing.truncated ? "+" : ""}` : "";

  return (
    <Section repo={repo} k="files" className="finder" label="This repo's files" head={head} title="Walk, search and preview the files of this checkout">
      <div className="finder-tools">
        <nav className="finder-crumbs" aria-label="Folder">
          {crumbs(dir, repo.name).map((c, i, all) => (
            <span key={c.path}>
              <button type="button" className="finder-crumb" disabled={i === all.length - 1 && !searching} onClick={() => {
                  setQuery("");
                  go({ dir: c.path, file: null });
                }}>
                {c.name}
              </button>
              {i < all.length - 1 && <span className="finder-sep">/</span>}
            </span>
          ))}
        </nav>
        <input
          type="search"
          className="sess-search finder-find"
          placeholder="find a file"
          aria-label="Find a file by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              listRef.current?.focus();
              const first = entries[0];
              if (first) go({ dir, file: first.path });
            } else if (e.key === "Enter" && entries[0]) {
              open(entries[0]);
            }
          }}
        />
        <button type="button" className={`mini${hidden ? " on" : ""}`} onClick={() => go({ hidden: !hidden })} title={hidden ? "Hide dotfiles" : "Show dotfiles"} aria-pressed={hidden}>
          .*
        </button>
        <button
          type="button"
          className={`mini${ignored ? " on" : ""}`}
          onClick={() => go({ ignored: !ignored })}
          title={ignored ? "Hide what git ignores" : "Show what git ignores too (node_modules, dist, .env), read off the disk folder by folder"}
          aria-pressed={ignored}
        >
          ignored
        </button>
        <button type="button" className="mini" disabled={busy} onClick={refresh} title="List the files again" aria-label="Refresh">
          ↻
        </button>
      </div>
      {error && <p className="panel-error">{error}</p>}
      <div className="finder-split">
        <ul ref={listRef} className="finder-list" tabIndex={0} onKeyDown={keys} aria-label="Files">
          {!searching && dir !== "" && (
            <li>
              <button type="button" tabIndex={-1} className="finder-row dir" onClick={up} title="The folder above (←)">
                <span className="finder-glyph" aria-hidden="true">
                  ‹
                </span>
                <span className="finder-name">..</span>
              </button>
            </li>
          )}
          {entries.map((e) => (
            <Row key={e.path} entry={e} picked={e.path === file} onClick={() => pick(e)} onOpen={() => open(e)} />
          ))}
          {listing && entries.length === 0 && <li className="panel-clean finder-note">{searching ? "No file by that name." : "Nothing here."}</li>}
          {searching && found.more && <li className="panel-clean finder-note">More files match than shown. Narrow the search.</li>}
        </ul>
        <div className="finder-look">
          {picked ? (
            <>
              <div className="finder-look-head">
                <span className="finder-look-name" title={picked}>
                  {baseName(picked)}
                </span>
                <FileActions repo={repo} path={picked} onError={setError} onView={() => setViewing(true)} />
              </div>
              <div className="finder-look-body">
                <FileBody repoId={repo.id} path={picked} stamp={stamp(picked)} big={false} onOpen={openPath} />
              </div>
            </>
          ) : (
            <p className="panel-clean finder-note">Pick a file to see it here. Double-click or press Space to open it large.</p>
          )}
        </div>
      </div>
      {viewing && picked && (
        <Viewer
          repo={repo}
          path={picked}
          list={steps}
          stamp={stamp}
          onPick={(p) => go({ dir, file: p })}
          onOpen={openPath}
          onClose={() => {
            setViewing(false);
            listRef.current?.focus();
          }}
        />
      )}
    </Section>
  );
}

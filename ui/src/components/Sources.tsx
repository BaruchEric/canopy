import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Listing, SourceState } from "../../../src/core/types";
import { Seg } from "./Seg";

const WHERE = [
  { value: "local", label: "this machine", title: "A folder on this Mac" },
  {
    value: "ssh",
    label: "over ssh",
    title: "A folder on a host from ~/.ssh/config; needs key login and git there",
  },
] as const;

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

function SourceRow({ src }: { src: SourceState }) {
  const rescanSource = useStore((s) => s.rescanSource);
  const removeSource = useStore((s) => s.removeSource);
  const [busy, setBusy] = useState<"rescan" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (what: "rescan" | "remove") => {
    setBusy(what);
    setError(null);
    try {
      if (what === "rescan") await rescanSource(src.id);
      else await removeSource(src.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const where = src.kind === "ssh" ? src.host : "here";
  return (
    <li className={src.error ? "src-row broken" : "src-row"}>
      <span className="src-where" title={src.kind === "ssh" ? `over ssh to ${src.host}` : "on this machine"}>
        {where}
      </span>
      <span className="src-main">
        <span className="src-label">
          {src.label}
          {src.launch && <em className="src-launch">launch folder</em>}
        </span>
        <span className="src-path" title={src.path}>
          {src.path}
        </span>
      </span>
      <span className="src-n">
        {src.repos} repo{src.repos === 1 ? "" : "s"}
      </span>
      <span className="src-actions">
        <button
          type="button"
          className="mini"
          disabled={busy !== null}
          title="Walk this folder again for repos"
          onClick={() => void act("rescan")}
        >
          {busy === "rescan" ? "scanning…" : "rescan"}
        </button>
        {!src.launch && (
          <button
            type="button"
            className="mini"
            disabled={busy !== null}
            title="Stop scanning this folder; nothing on disk changes"
            onClick={() => void act("remove")}
          >
            {busy === "remove" ? "removing…" : "remove"}
          </button>
        )}
      </span>
      {(error ?? src.error) && (
        <p className="src-err" role="alert">
          {error ?? src.error}
        </p>
      )}
    </li>
  );
}

/** The folder as breadcrumbs: the root, each ancestor, then the folder,
 *  every one a step back up. */
function crumbs(path: string): { label: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return [
    { label: "/", path: "/" },
    ...parts.map((p, i) => ({ label: p, path: "/" + parts.slice(0, i + 1).join("/") })),
  ];
}

/** Walk folders here or on a host, one level at a time, and pick one. */
function FolderBrowser({
  host,
  start,
  onPick,
  onClose,
}: {
  /** the ssh host, or undefined for this machine */
  host: string | undefined;
  /** where to open: what the path box holds, else home */
  start: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const go = async (path: string) => {
    setLoading(path);
    setError(null);
    try {
      setListing(await api.browse(path, host));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(null);
    }
  };

  // Opens where the box points, so a half-typed path browses from there.
  useEffect(() => {
    void go(start || "~");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const repos = listing?.dirs.filter((d) => d.repo).length ?? 0;
  return (
    <div className="browser" role="group" aria-label="Folder browser">
      <nav className="crumbs" aria-label="Path">
        {listing &&
          crumbs(listing.path).map((c, i, all) => (
            <span key={c.path} className="crumb-wrap">
              {i > 0 && <span className="crumb-sep">/</span>}
              <button
                type="button"
                className={i === all.length - 1 ? "crumb here" : "crumb"}
                disabled={loading !== null}
                onClick={() => void go(c.path)}
              >
                {c.label}
              </button>
            </span>
          ))}
        {!listing && !error && <span className="settings-hint">{loading ? "reading…" : ""}</span>}
      </nav>
      {error && (
        <p className="src-err" role="alert">
          {error}
        </p>
      )}
      {listing && (
        <ul className="browse-list">
          {listing.parent !== null && (
            <li>
              <button
                type="button"
                className="browse-item up"
                disabled={loading !== null}
                onClick={() => void go(listing.parent ?? "/")}
              >
                ..
              </button>
            </li>
          )}
          {listing.dirs.map((d) => (
            <li key={d.name}>
              <button
                type="button"
                className={d.repo ? "browse-item repo" : "browse-item"}
                disabled={loading !== null}
                title={d.repo ? `${d.name} is a git repo` : `open ${d.name}`}
                onClick={() => void go(`${listing.path === "/" ? "" : listing.path}/${d.name}`)}
              >
                <span className="browse-name">{d.name}</span>
                {d.repo && <span className="host-tag">repo</span>}
              </button>
            </li>
          ))}
          {listing.dirs.length === 0 && <li className="settings-hint">no subfolders</li>}
        </ul>
      )}
      <div className="browse-foot">
        <span className="settings-hint">
          {listing
            ? repos > 0
              ? `${repos} of ${listing.dirs.length} subfolder${listing.dirs.length === 1 ? "" : "s"} are repos`
              : "the scan looks a few levels down from here"
            : ""}
        </span>
        <span className="spacer" />
        <button type="button" className="mini" onClick={onClose}>
          cancel
        </button>
        <button
          type="button"
          className="mini strong"
          disabled={!listing || loading !== null}
          onClick={() => {
            if (listing) onPick(listing.path);
          }}
        >
          use this folder
        </button>
      </div>
    </div>
  );
}

function AddSourceForm({ onAdded }: { onAdded: () => void }) {
  const addSource = useStore((s) => s.addSource);
  const [kind, setKind] = useState<"local" | "ssh">("local");
  const [host, setHost] = useState("");
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

  // The host list is read once, when the form first needs it.
  useEffect(() => {
    if (kind !== "ssh" || hosts !== null) return;
    let live = true;
    api
      .hosts()
      .then((h) => {
        if (live) setHosts(h);
      })
      .catch(() => {
        if (live) setHosts([]);
      });
    return () => {
      live = false;
    };
  }, [kind, hosts]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmed = label.trim();
      await addSource(
        kind === "ssh"
          ? { kind, host: host.trim(), path: path.trim(), ...(trimmed ? { label: trimmed } : {}) }
          : { kind, path: path.trim(), ...(trimmed ? { label: trimmed } : {}) },
      );
      setPath("");
      setLabel("");
      onAdded();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const ready = path.trim() !== "" && (kind === "local" || host.trim() !== "");
  const canBrowse = kind === "local" || host.trim() !== "";
  return (
    <form className="src-form" onSubmit={(e) => void submit(e)}>
      <Seg
        label="Where the folder is"
        value={kind}
        options={WHERE}
        onChange={(k) => {
          setKind(k);
          setBrowsing(false);
        }}
      />
      <div className="src-fields">
        {kind === "ssh" && (
          <>
            <input
              className="src-host"
              list="ssh-hosts"
              placeholder="host"
              aria-label="ssh host"
              value={host}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setHost(e.target.value)}
            />
            <datalist id="ssh-hosts">
              {(hosts ?? []).map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          </>
        )}
        <input
          className="src-input"
          placeholder={kind === "ssh" ? "~/dev on that host" : "/path/to/folder or ~/folder"}
          aria-label="folder path"
          value={path}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setPath(e.target.value)}
        />
        <button
          type="button"
          className={browsing ? "mini on" : "mini"}
          disabled={!canBrowse}
          title={canBrowse ? "Pick the folder from a list" : "Name the host first"}
          onClick={() => setBrowsing(!browsing)}
        >
          browse
        </button>
        <input
          className="src-label-input"
          placeholder="label"
          aria-label="label, optional"
          value={label}
          autoComplete="off"
          onChange={(e) => setLabel(e.target.value)}
        />
        <button type="submit" className="mini strong" disabled={busy || !ready}>
          {busy ? "scanning…" : "add"}
        </button>
      </div>
      {browsing && (
        <FolderBrowser
          host={kind === "ssh" ? host.trim() : undefined}
          start={path.trim()}
          onPick={(p) => {
            setPath(p);
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
      {error && (
        <p className="src-err" role="alert">
          {error}
        </p>
      )}
      <p className="settings-hint">
        {kind === "ssh"
          ? "Repos there show up like local ones: status, log, diffs, commit and push run through ssh. Claude runs stay on this machine."
          : "Changes in the folder show up live. A folder inside one already listed is refused."}
      </p>
    </form>
  );
}

/** The folders canopy scans, behind the root path in the top bar: each
 *  with its repo count, a rescan, and a remove; and a form to add another
 *  from this machine or over ssh. */
export function SourcesMenu() {
  const root = useStore((s) => s.root);
  const sources = useStore((s) => s.sources);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const extra = sources.length - 1;
  const broken = sources.filter((s) => s.error).length;
  return (
    <div className="settings sources" ref={ref}>
      <button
        type="button"
        className={open ? "root-btn on" : "root-btn"}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`Folders canopy scans (${sources.length}); click to add or remove`}
        onClick={() => setOpen(!open)}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span className="root-path">{root}</span>
        {extra > 0 && (
          <span className={broken > 0 ? "tab-count rust" : "tab-count"}>+{extra}</span>
        )}
      </button>
      {open && (
        <div className="settings-pop sources-pop" role="dialog" aria-label="Scanned folders">
          <section className="settings-row">
            <h3 className="panel-label">folders</h3>
            <ul className="src-list">
              {sources.map((s) => (
                <SourceRow key={s.id} src={s} />
              ))}
            </ul>
          </section>
          <section className="settings-row">
            <h3 className="panel-label">add a folder</h3>
            <AddSourceForm onAdded={() => {}} />
          </section>
        </div>
      )}
    </div>
  );
}

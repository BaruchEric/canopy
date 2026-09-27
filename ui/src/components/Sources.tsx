import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api";
import { backendOf } from "../registry";
import { multi, useStore } from "../store";
import { useFitPop } from "../pop";
import type { Listing, SourceState } from "../../../src/core/types";
import { Seg } from "./Seg";

const WHERE = [
  { value: "local", label: "this machine", title: "A folder on this Mac" },
  {
    value: "ssh",
    label: "over ssh",
    title: "A folder on a host from ~/.ssh/config; needs key login and git there",
  },
  {
    value: "forgejo",
    label: "self-hosted git",
    title: "A Forgejo or Gitea server; its API lists the repos it holds",
  },
] as const;

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

function SourceRow({ src }: { src: SourceState }) {
  const rescanSource = useStore((s) => s.rescanSource);
  const removeSource = useStore((s) => s.removeSource);
  // How many of a forge's repos have no clone here: the half the folder
  // scans cannot show, and what the card grid holds when the view is
  // "missing".
  const missing = useStore((s) =>
    src.kind === "forgejo"
      ? s.repos.filter((r) => r.source === src.id && r.forge?.clonedAs === undefined).length
      : 0,
  );
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

  const forge = src.kind === "forgejo";
  const where = src.kind === "ssh" ? src.host : forge ? "forge" : "here";
  const at = src.kind === "forgejo" ? src.url : src.path;
  const title =
    src.kind === "ssh"
      ? `over ssh to ${src.host}`
      : forge
        ? "a self-hosted git server, over its API"
        : "on this machine";
  return (
    <li className={src.error ? "src-row broken" : "src-row"}>
      <span className="src-where" title={title}>
        {where}
      </span>
      <span className="src-main">
        <span className="src-label">
          {src.label}
          {src.launch && <em className="src-launch">launch folder</em>}
        </span>
        <span className="src-path" title={at}>
          {at}
        </span>
      </span>
      <span className="src-n">
        {forge
          ? `${missing} of ${src.repos} not cloned`
          : `${src.repos} repo${src.repos === 1 ? "" : "s"}`}
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
  backend,
  start,
  onPick,
  onClose,
}: {
  /** the ssh host, or undefined for this machine */
  host: string | undefined;
  /** which backend browses: its own folders, its own ssh hosts */
  backend: string;
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
      setListing(await api.browse(path, host, backend));
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
  }, [host, backend]);

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

function AddSourceForm({ onAdded, backendOrder, isMulti }: { onAdded: () => void; backendOrder: string[]; isMulti: boolean }) {
  const addSource = useStore((s) => s.addSource);
  const [kind, setKind] = useState<"local" | "ssh" | "forgejo">("local");
  const [backend, setBackend] = useState(backendOrder[0] ?? "");
  const [host, setHost] = useState("");
  const [path, setPath] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

  // The host list is read once per backend, when the form first needs it.
  useEffect(() => {
    if (kind !== "ssh" || hosts !== null) return;
    let live = true;
    api
      .hosts(backend)
      .then((h) => {
        if (live) setHosts(h);
      })
      .catch(() => {
        if (live) setHosts([]);
      });
    return () => {
      live = false;
    };
  }, [kind, hosts, backend]);

  // Switching backends browses and lists ssh hosts fresh: a stale answer
  // from the old one would be read as the new one's.
  useEffect(() => {
    setHosts(null);
    setBrowsing(false);
  }, [backend]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmed = label.trim();
      const named = trimmed ? { label: trimmed } : {};
      await addSource(
        kind === "ssh"
          ? { kind, host: host.trim(), path: path.trim(), ...named }
          : kind === "forgejo"
            ? {
                kind,
                url: path.trim(),
                ...(token.trim() ? { tokenFile: token.trim() } : {}),
                ...named,
              }
            : { kind, path: path.trim(), ...named },
        backend,
      );
      setPath("");
      setToken("");
      setLabel("");
      onAdded();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const ready = path.trim() !== "" && (kind !== "ssh" || host.trim() !== "");
  const canBrowse = kind === "local" || (kind === "ssh" && host.trim() !== "");
  return (
    <form className="src-form" onSubmit={(e) => void submit(e)}>
      {isMulti && (
        <Seg
          label="Which backend the folder is added to"
          value={backend}
          options={backendOrder.map((n) => ({ value: n, label: n }))}
          onChange={setBackend}
        />
      )}
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
          placeholder={
            kind === "forgejo"
              ? "https://git.example.com"
              : kind === "ssh"
                ? "~/dev on that host"
                : "/path/to/folder or ~/folder"
          }
          aria-label={kind === "forgejo" ? "the forge's address" : "folder path"}
          value={path}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setPath(e.target.value)}
        />
        {kind === "forgejo" ? (
          <input
            className="src-input"
            placeholder="token file, or $CANOPY_FORGEJO_TOKEN"
            aria-label="path to a file holding the API token, optional"
            value={token}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setToken(e.target.value)}
          />
        ) : (
          <button
            type="button"
            className={browsing ? "mini on" : "mini"}
            disabled={!canBrowse}
            title={canBrowse ? "Pick the folder from a list" : "Name the host first"}
            onClick={() => setBrowsing(!browsing)}
          >
            browse
          </button>
        )}
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
      {browsing && kind !== "forgejo" && (
        <FolderBrowser
          host={kind === "ssh" ? host.trim() : undefined}
          backend={backend}
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
          : kind === "forgejo"
            ? "The forge's own repos, read through its API: a card each, no working copy, so nothing git-driven runs on them. The token file holds a token with read access; only its path is stored."
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
  const forgeView = useStore((s) => s.settings.forge);
  const setSetting = useStore((s) => s.setSetting);
  const isMulti = useStore(multi);
  const backendOrder = useStore((s) => s.backendOrder);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

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

  // Each backend has its own launch root, so what a source count past the
  // root path badges is every source that is not one, on any backend: with
  // one backend that is the same as sources.length - 1.
  const extra = sources.filter((s) => !s.launch).length;
  const broken = sources.filter((s) => s.error).length;
  const groups = isMulti
    ? backendOrder
        .map((name) => ({ name, list: sources.filter((s) => backendOf(s.id) === name) }))
        .filter((g) => g.list.length > 0)
    : null;
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
            <div className="src-head">
              <h3 className="panel-label">folders</h3>
              {sources.some((s) => s.kind === "forgejo") && (
                <button
                  type="button"
                  className="mini"
                  title={
                    forgeView === "all"
                      ? "Show only the forge repos with no clone on this machine"
                      : "Show every repo the forge holds, the ones cloned here included"
                  }
                  onClick={() => setSetting("forge", forgeView === "all" ? "missing" : "all")}
                >
                  {forgeView === "all" ? "forge: everything" : "forge: missing only"}
                </button>
              )}
            </div>
            {groups ? (
              groups.map((g) => (
                <div key={g.name} className="src-group">
                  <h4 className="panel-label">{g.name}</h4>
                  <ul className="src-list">
                    {g.list.map((s) => (
                      <SourceRow key={s.id} src={s} />
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              <ul className="src-list">
                {sources.map((s) => (
                  <SourceRow key={s.id} src={s} />
                ))}
              </ul>
            )}
          </section>
          <section className="settings-row">
            <h3 className="panel-label">add a folder</h3>
            <AddSourceForm onAdded={() => {}} backendOrder={backendOrder} isMulti={isMulti} />
          </section>
        </div>
      )}
    </div>
  );
}

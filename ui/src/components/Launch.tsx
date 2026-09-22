import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { closedIn, jobsFor, launchFor, useStore } from "../store";
import { ago } from "../util";
import { Seg } from "./Seg";
import { fmtBytes } from "../../../src/core/launch";
import { isJobActive, type Build, type Job, type Pull, type Release, type Repo } from "../../../src/core/types";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

type Tab = "builds" | "releases" | "pulls";

const TABS = [
  { value: "builds", label: "builds", title: "What is installed or built here, ready to launch" },
  { value: "releases", label: "releases", title: "The repo's releases on GitHub, one asset each for this machine" },
  { value: "pulls", label: "pull requests", title: "Open pull requests, checked out and built here on request" },
] as const satisfies readonly { value: Tab; label: string; title: string }[];

/** how many output lines a job block shows */
const TAIL = 14;

/* ---------- the section on the panel ---------- */

/**
 * The launcher: a repo's released builds downloaded here, its pull requests
 * checked out and built, and the checkout itself, each launched with one
 * click. Folded by default. The list of builds re-reads whenever the server
 * says they changed; releases and pull requests are read when their tab
 * opens and on the refresh button.
 */
export function LaunchSection({ repo }: { repo: Repo }) {
  const closed = useStore((s) => closedIn(s, repo.id, "launch"));
  const toggleSection = useStore((s) => s.toggleSection);
  const editLaunch = useStore((s) => s.editLaunch);
  const buildsAt = useStore((s) => s.buildsAt[repo.id]);
  const jobs = useStore(useShallow((s) => jobsFor(s, repo.id)));
  const settings = useStore((s) => launchFor(s, repo));
  const [tab, setTab] = useState<Tab>("builds");
  const [builds, setBuilds] = useState<Build[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = jobs.filter(isJobActive).length;

  useEffect(() => {
    if (closed) return;
    let live = true;
    api
      .builds(repo.id)
      .then((b) => {
        if (live) {
          setBuilds(b);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (live) setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [closed, repo.id, buildsAt, settings]);

  const summary = active ? `${active} going` : builds ? String(builds.length) : "…";

  return (
    <section className="launch" aria-label="Launcher">
      <button
        type="button"
        className={`panel-label fold${closed ? "" : " open"}`}
        aria-expanded={!closed}
        onClick={() => toggleSection(repo.id, "launch")}
        title="Released builds, pull requests and this checkout, launched from here"
      >
        launch <span>{summary}</span>
      </button>
      {!closed && (
        <div className="launch-body">
          <div className="launch-bar">
            <Seg label="What to show" value={tab} options={TABS} onChange={setTab} className="seg-window" />
            <span className="spacer" />
            <button
              type="button"
              className="mini"
              title="Build and run lines, and which release asset is for this machine"
              onClick={() => editLaunch(repo.id)}
            >
              settings…
            </button>
          </div>
          {error && <p className="panel-error">{error}</p>}
          {jobs.length > 0 && (
            <ul className="job-list">
              {jobs.slice(0, 3).map((j) => (
                <JobBlock key={j.id} job={j} />
              ))}
            </ul>
          )}
          {tab === "builds" && <Builds repo={repo} builds={builds} onError={setError} />}
          {tab === "releases" && <Releases repo={repo} builds={builds} onError={setError} />}
          {tab === "pulls" && <Pulls repo={repo} builds={builds} onError={setError} />}
        </div>
      )}
    </section>
  );
}

/* ---------- one job: a download or a build going, or just ended ---------- */

function JobBlock({ job }: { job: Job }) {
  const stopJob = useStore((s) => s.stopJob);
  const dismissJob = useStore((s) => s.dismissJob);
  const tail = useRef<HTMLPreElement>(null);
  const live = isJobActive(job);
  const pct =
    job.progress && job.progress.total > 0
      ? Math.min(100, Math.round((job.progress.done / job.progress.total) * 100))
      : null;

  useEffect(() => {
    const el = tail.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job.lines.length]);

  return (
    <li className={`job s-${job.status}`}>
      <div className="job-head">
        <span className={`dot ${live ? "sky" : job.status === "done" ? "moss" : job.status === "failed" ? "rust" : "faint"}`} />
        <span className="job-title">{job.title}</span>
        <span className="job-state">
          {live
            ? pct !== null
              ? `${pct}% · ${fmtBytes(job.progress?.done ?? 0)}`
              : "working"
            : job.status}
        </span>
        <span className="spacer" />
        {live ? (
          <button type="button" className="mini" onClick={() => void stopJob(job.id)}>
            stop
          </button>
        ) : (
          <button type="button" className="mini" onClick={() => void dismissJob(job.id)}>
            dismiss
          </button>
        )}
      </div>
      {pct !== null && live && (
        <div className="job-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {job.lines.length > 0 && (
        <pre ref={tail} className="job-tail">
          {job.lines.slice(-TAIL).join("\n")}
        </pre>
      )}
    </li>
  );
}

/* ---------- builds: what is here ---------- */

function Builds({
  repo,
  builds,
  onError,
}: {
  repo: Repo;
  builds: Build[] | null;
  onError: (msg: string | null) => void;
}) {
  const settings = useStore((s) => launchFor(s, repo));
  const [busy, setBusy] = useState<string | null>(null);
  // A build never launched before asks once: a first run of something just
  // downloaded is the one worth a second look.
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    if (confirm === null) return;
    const t = setTimeout(() => setConfirm(null), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  const act = async (key: string, what: string, fn: () => Promise<unknown>) => {
    setBusy(`${what}:${key}`);
    onError(null);
    try {
      await fn();
    } catch (err) {
      onError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const launch = (b: Build) => {
    if (b.launches === 0 && confirm !== b.key) {
      setConfirm(b.key);
      return;
    }
    setConfirm(null);
    void act(b.key, "launch", () => api.launch(repo.id, b.key));
  };

  if (builds === null) return <p className="panel-clean">Reading builds…</p>;
  if (builds.length === 0) {
    return (
      <p className="panel-clean">
        Nothing to launch yet. Install a release, build a pull request, or set a run line in the
        settings to launch this checkout.
      </p>
    );
  }
  return (
    <ul className="build-list">
      {builds.map((b) => {
        const here = busy?.endsWith(`:${b.key}`) ?? false;
        return (
          <li key={b.key} className={`build k-${b.kind}${b.running ? " running" : ""}`}>
            <span className="build-label" title={b.dir}>
              {b.label}
            </span>
            {b.head && (
              <span className="build-head" title={b.head}>
                {b.head.slice(0, 7)}
              </span>
            )}
            <span className="build-what" title={b.what ?? undefined}>
              {b.what ? shortWhat(b.what) : b.kind === "release" ? "nothing launchable" : "no run line"}
            </span>
            <span className="build-meta" title={b.at ? `installed ${ago(b.at / 1000)}` : undefined}>
              {b.launches
                ? `${b.launches}× · ${b.lastLaunch ? ago(b.lastLaunch / 1000) : ""}`
                : b.at
                  ? ago(b.at / 1000)
                  : ""}
            </span>
            {b.running && <span className="pill on">running</span>}
            <span className="spacer" />
            {b.kind !== "release" && (
              <button
                type="button"
                className="mini"
                disabled={here}
                title={b.kind === "pr" ? "Fetch the pull request again and rebuild" : "Run the build line here"}
                onClick={() =>
                  void act(b.key, "build", () => api.build(repo.id, b.kind === "pr" ? Number(b.key.slice(3)) : undefined))
                }
              >
                {b.kind === "pr" ? "rebuild" : settings.build ? "build" : ""}
              </button>
            )}
            {b.running ? (
              <button
                type="button"
                className="mini"
                disabled={here}
                onClick={() => void act(b.key, "halt", () => api.halt(repo.id, b.key))}
              >
                stop
              </button>
            ) : (
              <button
                type="button"
                className={`mini strong${confirm === b.key ? " confirm" : ""}`}
                disabled={here || b.what === null}
                title={b.what ?? "nothing here can be launched"}
                onClick={() => launch(b)}
              >
                {here && busy?.startsWith("launch") ? "launching…" : confirm === b.key ? "run it?" : "launch"}
              </button>
            )}
            {b.kind !== "local" && (
              <button
                type="button"
                className="mini"
                disabled={here}
                title={b.kind === "pr" ? "Remove the worktree" : "Delete the installed files"}
                onClick={() => void act(b.key, "remove", () => api.uninstall(repo.id, b.key))}
                aria-label={`Remove ${b.label}`}
              >
                ✕
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A run line or a path, short enough for a row. */
function shortWhat(what: string): string {
  const base = what.startsWith("/") ? what.split("/").slice(-1)[0] ?? what : what;
  return base.length > 40 ? `${base.slice(0, 39)}…` : base;
}

/* ---------- releases: what GitHub has ---------- */

/** A list read from the forge when `key` changes and on `reload`. The loader
 *  is read fresh each time, so it may close over whatever it likes. */
function useRemote<T>(load: () => Promise<T>, key: string): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let live = true;
    setError(null);
    loader
      .current()
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e: unknown) => {
        if (live) setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [key, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

function Releases({
  repo,
  builds,
  onError,
}: {
  repo: Repo;
  builds: Build[] | null;
  onError: (msg: string | null) => void;
}) {
  const settings = useStore((s) => launchFor(s, repo));
  const { data, error, reload } = useRemote(() => api.releases(repo.id), `${repo.id}\0${settings.asset}`);
  const [busy, setBusy] = useState<string | null>(null);
  const installed = new Set((builds ?? []).filter((b) => b.kind === "release").map((b) => b.key.slice("release:".length)));

  const install = async (r: Release) => {
    setBusy(r.tag);
    onError(null);
    try {
      await api.install(repo.id, r.tag);
    } catch (err) {
      onError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  if (error) return <p className="panel-hint">{error}</p>;
  if (data === null) return <p className="panel-clean">Reading releases…</p>;
  return (
    <>
      <div className="launch-hint">
        <span>
          {data.length} release{data.length === 1 ? "" : "s"}
          {settings.asset ? ` · asset ${settings.asset}` : ""}
        </span>
        <span className="spacer" />
        <button type="button" className="mini" onClick={reload}>
          refresh
        </button>
      </div>
      {data.length === 0 ? (
        <p className="panel-clean">No releases on GitHub.</p>
      ) : (
        <ul className="build-list">
          {data.map((r) => {
            const asset = r.assets.find((a) => a.name === r.pick);
            const have = installed.has(r.tag);
            return (
              <li key={r.tag} className={`build k-release${have ? " have" : ""}`}>
                <a className="build-label" href={r.url} target="_blank" rel="noreferrer noopener" title={r.name}>
                  {r.tag}
                </a>
                {r.prerelease && <span className="pill">pre</span>}
                <span className="build-what" title={asset ? `${asset.name} (${fmtBytes(asset.size)})` : undefined}>
                  {asset ? asset.name : r.assets.length ? "no asset for this machine" : "no assets"}
                </span>
                <span className="build-meta">{r.publishedAt ? ago(r.publishedAt / 1000) : ""}</span>
                <span className="spacer" />
                {have ? (
                  <span className="build-note">installed</span>
                ) : (
                  <button
                    type="button"
                    className="mini strong"
                    disabled={!asset || busy === r.tag}
                    title={asset ? `Download ${asset.name} (${fmtBytes(asset.size)}) and unpack it` : "Set an asset glob in the settings to pick one"}
                    onClick={() => void install(r)}
                  >
                    {busy === r.tag ? "starting…" : "install"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/* ---------- pull requests ---------- */

function Pulls({
  repo,
  builds,
  onError,
}: {
  repo: Repo;
  builds: Build[] | null;
  onError: (msg: string | null) => void;
}) {
  const settings = useStore((s) => launchFor(s, repo));
  const { data, error, reload } = useRemote(() => api.pulls(repo.id), repo.id);
  const [busy, setBusy] = useState<number | null>(null);
  const built = new Map((builds ?? []).filter((b) => b.kind === "pr").map((b) => [Number(b.key.slice(3)), b]));

  const build = async (p: Pull) => {
    setBusy(p.number);
    onError(null);
    try {
      await api.build(repo.id, p.number);
    } catch (err) {
      onError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  if (repo.host) return <p className="panel-hint">Pull requests are built on this machine only; {repo.name} is on {repo.host}.</p>;
  if (error) return <p className="panel-hint">{error}</p>;
  if (data === null) return <p className="panel-clean">Reading pull requests…</p>;
  return (
    <>
      <div className="launch-hint">
        <span>
          {data.length} open
          {settings.build ? "" : " · no build line set, a checkout is all a build does"}
        </span>
        <span className="spacer" />
        <button type="button" className="mini" onClick={reload}>
          refresh
        </button>
      </div>
      {data.length === 0 ? (
        <p className="panel-clean">No open pull requests.</p>
      ) : (
        <ul className="build-list">
          {data.map((p) => {
            const have = built.get(p.number);
            return (
              <li key={p.number} className={`build k-pr${have ? " have" : ""}`}>
                <a className="build-label" href={p.url} target="_blank" rel="noreferrer noopener" title={p.branch}>
                  #{p.number}
                </a>
                {p.draft && <span className="pill">draft</span>}
                <span className="build-what" title={p.title}>
                  {p.title}
                </span>
                <span className="build-meta" title={p.author}>
                  {p.author} · {p.updatedAt ? ago(p.updatedAt / 1000) : ""}
                </span>
                <span className="spacer" />
                {have && <span className="build-note">built {have.head?.slice(0, 7)}</span>}
                <button
                  type="button"
                  className={`mini${have ? "" : " strong"}`}
                  disabled={busy === p.number}
                  title={`Fetch pull/${p.number}/head into a worktree${settings.build ? " and run the build line" : ""}`}
                  onClick={() => void build(p)}
                >
                  {busy === p.number ? "starting…" : have ? "rebuild" : "build"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

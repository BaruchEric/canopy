import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { backendOf, isHome } from "../registry";
import { useStore } from "../store";
import { previewBlocked, previewUrl } from "../preview";
import { flipMode, type SurfaceMode } from "../surface";
import { ago } from "../util";
import { Section, useSectionClosed } from "./Surface";
import { floorplanHead, floorplanLine, isUpdate, startWord, type FloorplanInfo } from "../../../src/core/floorplan";
import { isRunActive, type Repo } from "../../../src/core/types";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** an ISO time in the page's own words ("3h ago") */
const agoIso = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : ago(t / 1000);
};

/** how often the status is read again while a map run goes, so the head
 *  and the line keep up with what the run has written */
const RUN_EVERY = 8000;

/** The head's switch: the map (or a diagram) takes the whole panel, or
 *  gives it back. */
export function FullButton({ mode, setMode, what = "map" }: { mode: SurfaceMode; setMode: (m: SurfaceMode) => void; what?: string }) {
  const full = mode === "full";
  return (
    <button
      type="button"
      className={`term-new term-full preview-mode-btn${full ? " on" : ""}`}
      title={full ? "Give the panel back" : `The ${what} takes the whole panel`}
      aria-label={full ? `Restore the ${what}'s size` : `Maximize the ${what}`}
      aria-pressed={full}
      onClick={() => setMode(flipMode(mode, "full"))}
    >
      {full ? "⤡" : "⤢"}
    </button>
  );
}

/**
 * The map of the checkout (FR-070): canopy's copy of Floorplan, drawn by a
 * Claude run into the repo's own `floorplan/` and shown here through a
 * preview slot, so its Ask bar talks to its own server on another origin.
 * The section reads the map's state, starts the run that makes or updates
 * it, and starts, frames and stops the map's server. `kinds` is the
 * map's kind switch (Map.tsx), at the top of the body.
 */
export function FloorplanMap({ repo, kinds }: { repo: Repo; kinds: ReactNode }) {
  const closed = useSectionClosed(repo.id, "map");
  const backend = backendOf(repo.id);
  const home = isHome(repo.id);
  const [info, setInfo] = useState<FloorplanInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"make" | "open" | "stop" | null>(null);
  const [note, setNote] = useState("");
  const [developers, setDevelopers] = useState(false);
  // the frame: the slot the map's server sits on, and the backend's public
  // preview names and tailnet IP, which say where that slot is reached
  const [frame, setFrame] = useState<{ slot: number; pub: string | null; host: string | null } | null>(null);
  // bumped when a run ends, so the frame loads the map it wrote
  const [nonce, setNonce] = useState(0);
  const showRun = useStore((s) => s.showRun);
  const runId = info?.run ?? null;
  const run = useStore((s) => (runId ? s.runs[runId] : undefined));
  const going = runId !== null && (run === undefined || isRunActive(run));

  const load = useCallback(
    () =>
      api.floorplan(repo.id).then(
        (got) => {
          setInfo(got);
          setError(null);
          if (!got.server) setFrame(null);
        },
        (e: unknown) => setError(errText(e)),
      ),
    [repo.id],
  );
  useEffect(() => {
    if (!closed) void load();
  }, [closed, load]);

  // while a run goes, read again now and then; when it ends, once more, and
  // the frame loads what it wrote
  useEffect(() => {
    if (closed || !going) return;
    const timer = setInterval(() => void load(), RUN_EVERY);
    return () => {
      clearInterval(timer);
      void load();
      setNonce((n) => n + 1);
    };
  }, [closed, going, load]);

  /** starts (or finds) the map's server and puts it on a preview slot */
  const show = useCallback(async () => {
    setBusy("open");
    setError(null);
    try {
      const ports = await api.ports(backend);
      const pub = ports.public ?? null;
      const host = ports.host ?? null;
      const blocked = previewBlocked(window.location, pub, home, host);
      if (blocked) throw new Error(blocked);
      if (ports.slots.length === 0) throw new Error("previews are off on this backend (CANOPY_PREVIEW_PORTS), and the map is shown through one");
      const { port } = await api.floorplanOpen(repo.id);
      const { slot } = await api.preview(port, backend);
      setFrame({ slot, pub, host });
      setInfo((i) => (i ? { ...i, server: { port } } : i));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }, [backend, home, repo.id]);

  // a server already up for this checkout is framed as soon as the section
  // opens: the map stays one click away only while nothing serves it
  const serving = info?.server !== null && info?.server !== undefined;
  useEffect(() => {
    if (!closed && serving && frame === null && busy === null && error === null) void show();
  }, [closed, serving, frame, busy, error, show]);

  const make = () => {
    setBusy("make");
    setError(null);
    api
      .floorplanMake(repo.id, note.trim(), developers)
      .then((r) => {
        setNote("");
        setInfo((i) => (i ? { ...i, run: r.id } : i));
        showRun(r.id);
      })
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(null));
  };

  const stop = () => {
    setBusy("stop");
    api
      .floorplanStop(repo.id)
      .then(() => {
        setFrame(null);
        return load();
      })
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(null));
  };

  const url = frame ? previewUrl(window.location, frame.slot, "/", frame.pub, home, frame.host) : null;
  const state = info?.state ?? "none";
  const built = state === "map" || state === "blueprint";
  const line = info ? floorplanLine(info, agoIso) : "reading the map…";
  return (
    <Section
      repo={repo}
      k="map"
      className="map"
      label="Map"
      head={floorplanHead(info ? { ...info, run: going ? runId : null } : null)}
      title="A plain-English map of the code's parts, files and endpoints, drawn by Claude with Floorplan"
      noCapture={url ? "The map is another origin, which a capture cannot see into" : undefined}
      tools={(m, setM) => (url ? <FullButton mode={m} setMode={setM} /> : null)}
    >
      <div className="map-body">
        {kinds}
        <p className="map-line">
          <span>{line}</span>
          {going && runId && (
            <button type="button" className={`mini${run?.status === "waiting" ? " strong" : ""}`} onClick={() => showRun(runId)} title="The run drawing the map, where its questions wait">
              {run?.status === "waiting" ? "the run is waiting on you" : "mapping now: see the run"}
            </button>
          )}
        </p>
        {!going && (
          <div className="map-start">
            <input
              className="map-note"
              type="text"
              value={note}
              placeholder="anything the map should know (optional)"
              aria-label="A note for the map run"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && busy === null) make();
              }}
            />
            <label className="map-dev" title="Names and descriptions for developers, not for the app's owner">
              <input type="checkbox" checked={developers} onChange={(e) => setDevelopers(e.target.checked)} /> for developers
            </label>
            <button
              type="button"
              className={built ? "mini" : "mini strong"}
              disabled={busy !== null}
              onClick={make}
              title={isUpdate(state) ? "Claude refreshes the map: it reads what changed since the build and describes only that" : "Claude reads the code with Floorplan's scripts and draws the map into floorplan/, which stays out of git"}
            >
              {busy === "make" ? "starting…" : startWord(state)}
            </button>
          </div>
        )}
        {built && (
          <div className="map-acts">
            {!url && (
              <button type="button" className="mini strong" disabled={busy !== null} onClick={() => void show()} title="Start the map's own server on the backend and show it here">
                {busy === "open" ? "opening…" : "show the map"}
              </button>
            )}
            {url && (
              <a className="mini" href={url} target="_blank" rel="noopener noreferrer" title="The map in a tab of its own">
                open in a tab
              </a>
            )}
            {serving && (
              <button type="button" className="mini" disabled={busy !== null} onClick={stop} title="Stop the map's server; it also stops by itself two hours after its last tab closes">
                {busy === "stop" ? "stopping…" : "stop its server"}
              </button>
            )}
          </div>
        )}
        {error && (
          <p className="map-error" role="alert">
            {error}
          </p>
        )}
        {url && (
          <div className="map-frame-wrap">
            <iframe key={`${url}#${nonce}`} className="map-frame" src={url} title={`Map of ${repo.name}`} />
          </div>
        )}
      </div>
    </Section>
  );
}

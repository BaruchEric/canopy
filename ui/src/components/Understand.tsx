import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { backendOf, isHome } from "../registry";
import { useStore } from "../store";
import { previewBlocked, previewUrl } from "../preview";
import { ago } from "../util";
import { Section, useSectionClosed } from "./Surface";
import { FullButton } from "./Floorplan";
import { PREPARING_WORDS, graphRun, isWait, startWord, understandHead, understandLine, type UnderstandInfo } from "../../../src/core/understand";
import { isRunActive, type Repo } from "../../../src/core/types";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** an ISO time in the page's own words ("3h ago") */
const agoIso = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : ago(t / 1000);
};

/** how often the status is read again while a graph run goes */
const RUN_EVERY = 8000;
/** and while the backend prepares the plugin */
const PREPARE_EVERY = 3000;

/** what waits on the plugin's prepare: a start with its words, or an open */
type Pending = { act: "make"; note: string; full: boolean } | { act: "open" };

/**
 * The map section's knowledge graph (FR-072): canopy's copy of
 * Understand-Anything, made by a Claude run into the repo's own `.ua/` and
 * shown here through a preview slot, where its dashboard reads the graph
 * from the plugin's own viewer on another origin. The first start or open
 * on a backend prepares the plugin there; the section says so and carries
 * on by itself once it is ready. `kinds` is the map's switch, at the top of
 * the body.
 */
export function UnderstandMap({ repo, kinds }: { repo: Repo; kinds: ReactNode }) {
  const closed = useSectionClosed(repo.id, "map");
  const backend = backendOf(repo.id);
  const home = isHome(repo.id);
  const [info, setInfo] = useState<UnderstandInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"make" | "open" | "stop" | null>(null);
  const [note, setNote] = useState("");
  const [full, setFull] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  // the frame: the slot the viewer sits on, its token, and the backend's
  // public preview names and tailnet IP, which say where that slot is reached
  const [frame, setFrame] = useState<{ slot: number; token: string; pub: string | null; host: string | null } | null>(null);
  // bumped when a run ends, so the frame loads the graph it wrote
  const [nonce, setNonce] = useState(0);
  const showRun = useStore((s) => s.showRun);
  const runId = info?.run ?? null;
  const run = useStore((s) => (runId ? s.runs[runId] : undefined));
  const going = runId !== null && (run === undefined || isRunActive(run));
  const preparing = info?.plugin.state === "preparing";

  const load = useCallback(
    () =>
      api.understand(repo.id).then(
        (got) => {
          setInfo(got);
          setError(null);
          if (!got.server) setFrame(null);
          return got;
        },
        (e: unknown) => {
          setError(errText(e));
          return null;
        },
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

  // while the backend prepares the plugin, read often, so what waits on it
  // goes as soon as it is ready
  useEffect(() => {
    if (closed || !preparing) return;
    const timer = setInterval(() => void load(), PREPARE_EVERY);
    return () => clearInterval(timer);
  }, [closed, preparing, load]);

  /** a 202 from the route: the plugin is being prepared, and `then` goes once it is */
  const wait = useCallback((then: Pending, plugin: UnderstandInfo["plugin"]) => {
    setPending(then);
    setInfo((i) => (i ? { ...i, plugin } : i));
  }, []);

  /** starts (or finds) the viewer and puts it on a preview slot */
  const show = useCallback(async () => {
    setBusy("open");
    setError(null);
    try {
      const ports = await api.ports(backend);
      const pub = ports.public ?? null;
      const host = ports.host ?? null;
      const blocked = previewBlocked(window.location, pub, home, host);
      if (blocked) throw new Error(blocked);
      if (ports.slots.length === 0) throw new Error("previews are off on this backend (CANOPY_PREVIEW_PORTS), and the graph is shown through one");
      const got = await api.understandOpen(repo.id);
      if (isWait(got)) return wait({ act: "open" }, got.plugin);
      const { slot } = await api.preview(got.port, backend);
      setFrame({ slot, token: got.token, pub, host });
      setInfo((i) => (i ? { ...i, server: { port: got.port } } : i));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }, [backend, home, repo.id, wait]);

  const make = useCallback(
    (words: string, rebuild: boolean) => {
      setBusy("make");
      setError(null);
      api
        .understandMake(repo.id, words, rebuild)
        .then((r) => {
          if (isWait(r)) return wait({ act: "make", note: words, full: rebuild }, r.plugin);
          setNote("");
          setFull(false);
          setInfo((i) => (i ? { ...i, run: r.id } : i));
          showRun(r.id);
        })
        .catch((e: unknown) => setError(errText(e)))
        .finally(() => setBusy(null));
    },
    [repo.id, showRun, wait],
  );

  // what waited on the prepare goes once the plugin is ready, and is
  // dropped with the reason when the prepare failed
  const plugin = info?.plugin.state;
  useEffect(() => {
    if (!pending || busy !== null) return;
    if (plugin === "failed") {
      setPending(null);
      return;
    }
    if (plugin !== "ready") return;
    setPending(null);
    if (pending.act === "open") void show();
    else make(pending.note, pending.full);
  }, [pending, plugin, busy, show, make]);

  // a viewer already up for this checkout is framed as soon as the section
  // opens: the graph stays one click away only while nothing serves it
  const serving = info?.server !== null && info?.server !== undefined;
  useEffect(() => {
    if (!closed && serving && frame === null && busy === null && error === null && pending === null) void show();
  }, [closed, serving, frame, busy, error, pending, show]);

  const stop = () => {
    setBusy("stop");
    api
      .understandStop(repo.id)
      .then(() => {
        setFrame(null);
        return load();
      })
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(null));
  };

  const url = frame ? previewUrl(window.location, frame.slot, `/?token=${frame.token}`, frame.pub, home, frame.host) : null;
  const state = info?.state ?? "none";
  const built = state === "graph";
  const how = graphRun(state, full);
  const line = info ? understandLine(info, agoIso) : "reading the graph…";
  const failed = info?.plugin.state === "failed" ? info.plugin.error : null;
  // what happens once the prepare is done, in the notice's words
  const then = pending ? (pending.act === "open" ? "shows the graph" : pending.full ? "rebuilds the graph" : built ? "updates the graph" : "makes the graph") : null;
  return (
    <Section
      repo={repo}
      k="map"
      className="map"
      label="Map"
      head={understandHead(info ? { ...info, run: going ? runId : null } : null)}
      title="A knowledge graph of the code's files, functions, classes and layers, made by Claude with Understand-Anything"
      noCapture={url ? "The graph is another origin, which a capture cannot see into" : undefined}
      tools={(m, setM) => (url ? <FullButton mode={m} setMode={setM} what="graph" /> : null)}
    >
      <div className="map-body">
        {kinds}
        <p className="map-line">
          <span>{line}</span>
          {going && runId && (
            <button type="button" className={`mini${run?.status === "waiting" ? " strong" : ""}`} onClick={() => showRun(runId)} title="The run making the graph, where its questions wait">
              {run?.status === "waiting" ? "the run is waiting on you" : "understanding now: see the run"}
            </button>
          )}
        </p>
        {(preparing || pending) && !failed && (
          <p className="map-line ua-prep" role="status">
            {PREPARING_WORDS}.{then ? ` Then it ${then}.` : ""}
          </p>
        )}
        {failed && (
          <p className="map-error" role="alert">
            preparing Understand-Anything failed: {failed}. Starting or showing again tries once more.
          </p>
        )}
        {!going && (
          <div className="map-start">
            <input
              className="map-note"
              type="text"
              value={note}
              placeholder="anything the graph should know (optional)"
              aria-label="A note for the graph run"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && busy === null && pending === null) make(note.trim(), full);
              }}
            />
            {built && (
              <label className="map-dev" title="Analyze every file again rather than only what changed since the graph was made">
                <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> from nothing
              </label>
            )}
            <button
              type="button"
              className={built ? "mini" : "mini strong"}
              disabled={busy !== null || pending !== null}
              onClick={() => make(note.trim(), full)}
              title={
                how === "make"
                  ? "Claude reads the code with Understand-Anything's scripts and subagents and writes the graph into .ua/, which stays out of git. Its subagents read every file, so it takes longer and costs more than a map."
                  : how === "update"
                    ? "Claude refreshes the graph: it analyzes only the files that changed since it was made"
                    : "Claude analyzes every file again and writes the graph anew"
              }
            >
              {busy === "make" ? "starting…" : startWord(how)}
            </button>
          </div>
        )}
        {built && (
          <div className="map-acts">
            {!url && (
              <button type="button" className="mini strong" disabled={busy !== null || pending !== null} onClick={() => void show()} title="Start the graph's viewer on the backend and show it here">
                {busy === "open" ? "opening…" : "show the graph"}
              </button>
            )}
            {url && (
              <a className="mini" href={url} target="_blank" rel="noopener noreferrer" title="The graph in a tab of its own">
                open in a tab
              </a>
            )}
            {serving && (
              <button type="button" className="mini" disabled={busy !== null} onClick={stop} title="Stop the graph's viewer; it also stops by itself two hours after its last request">
                {busy === "stop" ? "stopping…" : "stop its viewer"}
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
            <iframe key={`${url}#${nonce}`} className="map-frame" src={url} title={`Knowledge graph of ${repo.name}`} />
          </div>
        )}
      </div>
    </Section>
  );
}

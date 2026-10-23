import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { backendOf, isHome } from "../registry";
import { tasksOf, useStore } from "../store";
import { devTask, quietPreview } from "../tasks";
import { Section, useSectionClosed } from "./Surface";
import { TermGrip } from "./TermDock";
import { flipMode, type SurfaceMode } from "../surface";
import { benchIs, benchSolo } from "../front";
import {
  PREVIEW_H,
  loadChoice,
  portsFor,
  defaultPort,
  previewBlocked,
  previewHeightOf,
  previewPath,
  previewUrl,
  saveChoice,
  type PreviewChoice,
} from "../preview";
import { devUrl, pickPrompt, pickSignal, readPick, type Pick } from "../designmode";
import type { ListeningPort, Repo } from "../../../src/core/types";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** how long an enable waits for the page's ack before the picker is called
 *  blocked: a CSP without 'self' in script-src keeps the script out */
const PICK_ACK_MS = 2000;
const PICK_BLOCKED = "this page blocked the picker (CSP?)";
const PICK_SAID = {
  said: "Sent to the agent's chat.",
  pasted: "Pasted into the agent's shell: press Enter there to send it.",
  started: "Started a chat with the agent.",
} as const;

/** The design mode's switch, in the bar and in the bench's float. */
function PickButton({ on, disabled, toggle }: { on: boolean; disabled?: boolean; toggle: () => void }) {
  const word = on ? "Stop picking" : "Pick an element on the page to tell the agent about";
  return (
    <button
      type="button"
      className={`mini${on ? " on" : ""}`}
      onClick={toggle}
      disabled={disabled}
      title={word}
      aria-label={word}
      aria-pressed={on}
    >
      ⌖
    </button>
  );
}

/** how often the port list is re-read while the section is open with
 *  nothing showing, so a dev server started in a shell turns up on its own */
const PORTS_EVERY = 4000;

const portLabel = (p: ListeningPort) => (p.command ? `${p.port} · ${p.command}` : String(p.port));

/** The head's switches, the same pair a shell row has: bring the project to
 *  the front with the preview as its main pane, and have the preview fill
 *  the panel. Either again puts it back. In the bench there is one: the
 *  preview takes the whole bench, or gives it back. */
function ModeButtons({ mode, setMode, inBench }: { mode: SurfaceMode; setMode: (m: SurfaceMode) => void; inBench: boolean }) {
  const focus = mode === "focus";
  const full = mode === "full";
  const word = inBench
    ? focus ? "Give the bench back" : "The preview takes the bench"
    : focus ? "Put the project back" : "Bring the project to the front";
  return (
    <>
      <button
        type="button"
        className={`term-new term-focus preview-mode-btn${focus ? " on" : ""}`}
        title={word}
        aria-label={word}
        aria-pressed={focus}
        onClick={() => setMode(flipMode(mode, "focus"))}
      >
        ⧉
      </button>
      {!focus && !inBench && <button
        type="button"
        className={`term-new term-full preview-mode-btn${full ? " on" : ""}`}
        title={full ? "Give the panel back" : "The preview takes the whole panel"}
        aria-label={full ? "Restore the preview's size" : "Maximize the preview"}
        aria-pressed={full}
        onClick={() => setMode(flipMode(mode, "full"))}
      >
        {full ? "⤡" : "⤢"}
      </button>}
    </>
  );
}

/**
 * The in-app browser: the repo's dev server on the backend, framed in the
 * panel through one of canopy's preview ports, so it works from any device
 * the way the shells do. The ports offered are the ones whose process runs
 * in this repo, then the ones nobody claims; any port can be typed in.
 * What each repo previews (port and path) is kept per browser.
 */
export function PreviewSection({ repo }: { repo: Repo }) {
  const closed = useSectionClosed(repo.id, "preview");
  const [choice, setChoice] = useState<PreviewChoice | null>(() => loadChoice(repo.id));
  const [ports, setPorts] = useState<ListeningPort[] | null>(null);
  const [slots, setSlots] = useState<number[] | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState(choice?.path ?? "/");
  const [portDraft, setPortDraft] = useState("");
  // bumped by reload: a new key remounts the frame at the same address
  const [nonce, setNonce] = useState(0);
  // which frame (url and nonce) has finished loading: a dev server's first
  // page is hundreds of module requests, blank until they land
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  // the backend's public preview names, read with the ports: undefined
  // until then, so an https page is not called blocked before it knows
  const [pub, setPub] = useState<string | null | undefined>(undefined);
  // the backend's tailnet IP, for an http page framing another machine's slots
  const [host, setHost] = useState<string | null>(null);
  // the checkout's own backend proxies its ports, on its own public names
  // when it is not the backend that served this page
  const backend = backendOf(repo.id);
  const home = isHome(repo.id);
  const blocked = pub === undefined ? null : previewBlocked(window.location, pub, home, host);
  const dev = useStore(useShallow((s) => devTask(tasksOf(s, repo.id))));
  const known = useStore((s) => repo.id in s.tasks);
  const loadTasks = useStore((s) => s.loadTasks);
  const taskAct = useStore((s) => s.taskAct);
  const bringTask = useStore((s) => s.bringTask);
  const height = useStore((s) => s.settings.previewHeight);
  const setSetting = useStore((s) => s.setSetting);
  const frameBox = useRef<HTMLDivElement>(null);
  // in the bench the frame takes the main pane, and its grip has no place
  const inBench = useStore((s) => benchIs(s.front, repo.id));
  const soloed = useStore((s) => benchSolo(s.front, repo.id) === "app");
  const soloBench = useStore((s) => s.soloBench);
  const sendToAgent = useStore((s) => s.sendToAgent);
  const frame = useRef<HTMLIFrameElement>(null);
  const noteBox = useRef<HTMLTextAreaElement>(null);
  // counts the frame's loads: a reload inside the page fires load again
  // with the same key, and picking must be turned back on after it
  const [loads, setLoads] = useState(0);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Pick | null>(null);
  const [pickNote, setPickNote] = useState("");
  const [pickBusy, setPickBusy] = useState(false);
  const [pickWarn, setPickWarn] = useState<string | null>(null);
  const [pickStatus, setPickStatus] = useState<{ text: string; bad: boolean } | null>(null);
  useEffect(() => {
    if (!closed && !known) loadTasks(repo.id).catch(() => {});
  }, [closed, known, repo.id, loadTasks]);

  const pick = (next: PreviewChoice | null) => {
    setChoice(next);
    saveChoice(repo.id, next);
    setPathDraft(next?.path ?? "/");
    setError(null);
  };

  // the port list, re-read while nothing shows
  useEffect(() => {
    if (closed || blocked) return;
    let live = true;
    const read = () =>
      api
        .ports(backend)
        .then((r) => {
          if (!live) return;
          setPorts(r.ports);
          setSlots(r.slots);
          setHost(r.host ?? null);
          setPub(r.public ?? null);
        })
        .catch((e: unknown) => {
          if (live) setError(errText(e));
        });
    void read();
    const timer = slot === null ? setInterval(read, PORTS_EVERY) : null;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [closed, blocked, slot, backend]);

  // Nothing chosen yet and a port runs in this repo: its lowest.
  useEffect(() => {
    if (choice || !ports) return;
    const first = defaultPort(portsFor(ports, repo.id).mine);
    if (first !== null) pick({ port: first, path: "/" });
    // pick closes over nothing but repo.id, which is a dependency here
  }, [choice, ports, repo.id]);

  // a preview port for the chosen one, asked for whenever it changes
  const port = choice?.port;
  useEffect(() => {
    if (closed || blocked || port === undefined) {
      setSlot(null);
      return;
    }
    let live = true;
    api
      .preview(port, backend)
      .then((r) => {
        if (live) setSlot(r.slot);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setSlot(null);
        setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [closed, blocked, port, backend]);

  const url = slot !== null && choice ? previewUrl(window.location, slot, choice.path, pub, home, host) : null;
  const off = slots !== null && slots.length === 0;
  const { mine, loose } = ports ? portsFor(ports, repo.id) : { mine: [], loose: [] };
  const quiet = quietPreview(dev);
  const summary = choice ? `:${choice.port}` : mine.length ? String(mine.length) : "";

  // Design mode. The page's picker talks only to its parent and the origin
  // that turned it on; here a message counts only from the frame itself, at
  // the preview's origin, while picking is on. The repo is the prop's.
  const origin = url ? new URL(url).origin : null;
  const frameKey = url ? `${url}#${nonce}` : null;
  const loaded = frameKey !== null && loadedAt === frameKey;
  // the listener reads picking here, so a message never meets a stale closure
  const pickingRef = useRef(picking);
  useEffect(() => {
    pickingRef.current = picking;
  }, [picking]);
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // each load of the frame (an HMR full reload included) starts a fresh
  // script, so picking is turned on again, and the ack is waited for
  useEffect(() => {
    const w = frame.current?.contentWindow;
    if (!picking || !loaded || !origin || !w) return;
    w.postMessage({ canopy: "pick", on: true }, origin);
    const t = setTimeout(() => setPickWarn(PICK_BLOCKED), PICK_ACK_MS);
    ackTimer.current = t;
    return () => clearTimeout(t);
  }, [picking, loaded, loads, origin]);

  useEffect(() => {
    if (!origin) return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow || !pickingRef.current) return;
      const signal = pickSignal(event.data);
      if (signal === "ready") {
        if (ackTimer.current) clearTimeout(ackTimer.current);
        setPickWarn(null);
        return;
      }
      if (signal === "off") {
        setPicking(false);
        return;
      }
      const got = readPick(event.data);
      if (!got) return;
      setPicking(false);
      setPicked(got);
      setPickNote("");
      setPickStatus(null);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [origin]);

  // focus stays in canopy until the pick itself, so Esc is heard here too
  useEffect(() => {
    if (!picking) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPicking(false);
      setPickWarn(null);
      if (origin) frame.current?.contentWindow?.postMessage({ canopy: "pick", on: false }, origin);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [picking, origin]);

  // a pick names a page on one dev server; another port drops it, since
  // the prompt's address is read from the choice when it is sent
  useEffect(() => {
    setPicked(null);
    setPicking(false);
  }, [port]);

  useEffect(() => {
    if (picked) noteBox.current?.focus();
  }, [picked]);

  const togglePick = () => {
    const next = !picking;
    setPicking(next);
    setPickWarn(null);
    if (next) {
      setPicked(null);
      setPickStatus(null);
    } else if (origin) {
      frame.current?.contentWindow?.postMessage({ canopy: "pick", on: false }, origin);
    }
  };
  const sendPick = async () => {
    if (!picked || !choice || !pickNote.trim() || pickBusy) return;
    setPickBusy(true);
    try {
      const how = await sendToAgent(repo.id, pickPrompt(picked, pickNote, devUrl(choice.port, choice.path)));
      setPicked(null);
      setPickNote("");
      setPickStatus({ text: PICK_SAID[how], bad: false });
    } catch (e) {
      setPickStatus({ text: errText(e), bad: true });
    } finally {
      setPickBusy(false);
    }
  };
  const pickLine = pickWarn
    ? { text: pickWarn, bad: true }
    : pickStatus ?? (picking ? { text: "Click an element on the page. Esc stops.", bad: false } : null);

  const go = () => {
    if (!choice) return;
    const path = previewPath(pathDraft);
    if (path === choice.path) setNonce((n) => n + 1);
    else pick({ ...choice, path });
  };
  const typed = () => {
    const n = Number(portDraft.trim());
    if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
      setError("a port is a number from 1 to 65535");
      return;
    }
    setPortDraft("");
    pick({ port: n, path: "/" });
  };

  return (
    <Section
      repo={repo}
      k="preview"
      className="preview"
      label="Preview"
      head={summary}
      title="The repo's dev server, running on the backend, shown here"
      noCapture={url ? "The page in the preview is another origin, which a capture cannot see into" : undefined}
      tools={(mode, setMode) => <ModeButtons mode={mode} setMode={setMode} inBench={inBench} />}
    >
      <div className="preview-body">
        {blocked ? (
          <p className="panel-clean">{blocked}</p>
        ) : off ? (
          <p className="panel-clean">Previews are off on this backend (CANOPY_PREVIEW_PORTS).</p>
        ) : (
          <>
            <div className="preview-ports">
              {mine.map((p) => (
                <button
                  key={p.port}
                  type="button"
                  className={`mini${choice?.port === p.port ? " on" : ""}`}
                  onClick={() => pick({ port: p.port, path: choice?.port === p.port ? choice.path : "/" })}
                  title={`Listening in ${repo.name}`}
                >
                  {portLabel(p)}
                </button>
              ))}
              {loose.length > 0 && (
                <select
                  className="preview-select"
                  aria-label="Another port on the backend"
                  value={choice && !mine.some((p) => p.port === choice.port) ? String(choice.port) : ""}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (n) pick({ port: n, path: "/" });
                  }}
                >
                  <option value="">{mine.length ? "other…" : "a port…"}</option>
                  {loose.map((p) => (
                    <option key={p.port} value={p.port}>
                      {portLabel(p)}
                    </option>
                  ))}
                </select>
              )}
              <input
                className="preview-port"
                inputMode="numeric"
                placeholder="port"
                aria-label="Port to preview"
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") typed();
                }}
              />
              {choice && (
                <button type="button" className="mini" onClick={() => pick(null)} title="Stop previewing here">
                  ✕
                </button>
              )}
            </div>
            {error && <p className="panel-error">{error}</p>}
            {!choice ? (
              <p className="panel-clean">
                {ports === null
                  ? "Looking for dev servers…"
                  : mine.length === 0
                    ? (
                      <>
                        {quiet.text}
                        {dev && quiet.action === "start" && (
                          <>
                            {" "}
                            <button
                              type="button"
                              className="mini"
                              onClick={() => void taskAct(repo.id, "start", dev.name).catch((e: unknown) => setError(errText(e)))}
                            >
                              start {dev.name}
                            </button>
                          </>
                        )}
                        {dev && quiet.action === "log" && (
                          <>
                            {" "}
                            <button type="button" className="mini" onClick={() => bringTask(repo.id, dev.name)}>
                              {dev.name} log
                            </button>
                          </>
                        )}
                      </>
                    )
                    : "Pick a port."}
              </p>
            ) : (
              <>
                <div className="preview-bar">
                  <button
                    type="button"
                    className="mini"
                    onClick={() => setNonce((n) => n + 1)}
                    title="Reload"
                    aria-label="Reload"
                  >
                    ⟳
                  </button>
                  <PickButton on={picking} disabled={!url} toggle={togglePick} />
                  <input
                    className="preview-path"
                    aria-label="Path on the dev server"
                    spellCheck={false}
                    value={pathDraft}
                    onChange={(e) => setPathDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") go();
                    }}
                  />
                  {url && (
                    <a className="mini" href={url} target="_blank" rel="noreferrer" title="Open in a browser tab">
                      ↗
                    </a>
                  )}
                </div>
                <div
                  ref={frameBox}
                  className="preview-frame-wrap"
                  style={{ "--preview-h": `${height}px` } as CSSProperties}
                >
                  {url && loadedAt !== `${url}#${nonce}` && (
                    <p className="preview-loading" role="status">
                      Loading the app… the first load can take a while from outside the tailnet.
                    </p>
                  )}
                  {url ? (
                    <iframe
                      key={`${url}#${nonce}`}
                      ref={frame}
                      className="preview-frame"
                      src={url}
                      onLoad={() => {
                        setLoadedAt(`${url}#${nonce}`);
                        setLoads((n) => n + 1);
                      }}
                      title={`${repo.name} on port ${choice.port}`}
                      // its own origin already (another port); no top navigation
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                    />
                  ) : (
                    <p className="panel-clean">Opening a preview port…</p>
                  )}
                  {/* over the frame, so it shows in place and in the bench
                      alike; whatever the page sent is shown as text only */}
                  {url && (picked || pickLine) && (
                    <div className="preview-pick" role="region" aria-label="Design mode">
                      {picked ? (
                        <form
                          className="preview-pick-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void sendPick();
                          }}
                        >
                          <code className="preview-pick-sel" title={picked.selector}>
                            {picked.selector}
                          </code>
                          {(picked.text || picked.html) && (
                            <pre className="preview-pick-snip">{(picked.text || picked.html).slice(0, 240)}</pre>
                          )}
                          <textarea
                            ref={noteBox}
                            rows={3}
                            required
                            placeholder="what should change here"
                            aria-label="Note for the agent about this element"
                            value={pickNote}
                            onChange={(e) => setPickNote(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault();
                                void sendPick();
                              } else if (e.key === "Escape") setPicked(null);
                            }}
                          />
                          <div className="preview-pick-row">
                            <button type="submit" className="mini" disabled={!pickNote.trim() || pickBusy}>
                              send to the agent
                            </button>
                            <button type="button" className="mini" onClick={() => setPicked(null)}>
                              cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        pickLine && (
                          <p className={`preview-pick-line${pickLine.bad ? " bad" : ""}`} role="status">
                            <span>{pickLine.text}</span>
                            {!picking && (
                              <button
                                type="button"
                                className="mini"
                                onClick={() => {
                                  setPickWarn(null);
                                  setPickStatus(null);
                                }}
                                title="Dismiss"
                                aria-label="Dismiss"
                              >
                                ✕
                              </button>
                            )}
                          </p>
                        )
                      )}
                    </div>
                  )}
                  {/* in the bench the frame goes edge to edge, and these few
                      controls float over its corner instead of a bar above */}
                  {inBench && url && (
                    <div className="preview-float" role="toolbar" aria-label={`Preview of ${repo.name}`}>
                      <button type="button" className="mini" onClick={() => setNonce((n) => n + 1)} title="Reload" aria-label="Reload">
                        ⟳
                      </button>
                      <PickButton on={picking} toggle={togglePick} />
                      {[...mine, ...loose].length > 1 && (
                        <select
                          className="preview-select"
                          aria-label="Port to preview"
                          value={String(choice.port)}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (n) pick({ port: n, path: "/" });
                          }}
                        >
                          {!mine.some((p) => p.port === choice.port) && !loose.some((p) => p.port === choice.port) && (
                            <option value={choice.port}>{choice.port}</option>
                          )}
                          {[...mine, ...loose].map((p) => (
                            <option key={p.port} value={p.port}>
                              {portLabel(p)}
                            </option>
                          ))}
                        </select>
                      )}
                      <a className="mini" href={url} target="_blank" rel="noreferrer" title="Open in a browser tab" aria-label="Open in a browser tab">
                        ↗
                      </a>
                      <button
                        type="button"
                        className={`mini${soloed ? " on" : ""}`}
                        onClick={() => soloBench(repo.id, soloed ? null : "app")}
                        title={soloed ? "Give the bench back" : "The app takes the bench"}
                        aria-label={soloed ? "Give the bench back" : "The app takes the bench"}
                        aria-pressed={soloed}
                      >
                        {soloed ? "⤡" : "⤢"}
                      </button>
                    </div>
                  )}
                </div>
                {!inBench && (
                  <TermGrip
                    box={frameBox}
                    cssVar="--preview-h"
                    label="Preview height"
                    height={height}
                    setHeight={(px) => setSetting("previewHeight", previewHeightOf(px))}
                    bounds={PREVIEW_H}
                    edge="bottom"
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

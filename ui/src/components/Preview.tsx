import { useEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
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
import { annotationsPrompt, devUrl, marksMessage, pickSignal, pickText, readPick, type Annotation, type Clip, type Intent, type Pick, type Rect } from "../designmode";
import { COLORS, markupWords, type Shape, type Tool } from "../markup";
import { copyText } from "../share";
import { NO_SHOTS, Shooter, canShoot, shotError } from "../shots";
import { PICK_SAID, PickNotes } from "./PickNotes";
import { ClipLayer, DrawBar, DrawLayer } from "./PreviewLayers";
import type { ListeningPort, Repo } from "../../../src/core/types";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** how long an enable waits for the page's ack before the picker is called
 *  blocked: a CSP without 'self' in script-src keeps the script out */
const PICK_ACK_MS = 2000;
const PICK_BLOCKED = "this page blocked the picker (CSP?)";

/** what design mode is doing over the frame: picking elements, clipping a
 *  box for a picture, or drawing marks; null when nothing */
type Mode = "pick" | "clip" | "draw" | null;

/** a note being written, on an element, a picture, or both */
interface Pending {
  pick: Pick | null;
  clip: Clip | null;
}

const MODES: { mode: Exclude<Mode, null>; glyph: string; word: string; doing: string; on: string; off: string }[] = [
  { mode: "pick", glyph: "⌖", word: "pick", doing: "picking", on: "Stop picking", off: "Pick an element on the page to tell the agent about" },
  { mode: "clip", glyph: "⬚", word: "clip", doing: "clipping", on: "Stop clipping", off: "Drag a box on the page for a picture to tell the agent about" },
  { mode: "draw", glyph: "✎", word: "draw", doing: "drawing", on: "Stop drawing", off: "Draw on the page, then take a picture of it for the agent" },
];

/** Design mode's switches, in the bar and in the bench's float. */
function ModeButtons({ mode, disabled, toggle }: { mode: Mode; disabled?: boolean; toggle: (m: Exclude<Mode, null>) => void }) {
  return (
    <>
      {MODES.map((m) => {
        const on = mode === m.mode;
        const word = on ? m.on : m.off;
        return (
          <button
            key={m.mode}
            type="button"
            className={`mini preview-pick-btn${on ? " on" : ""}`}
            onClick={() => toggle(m.mode)}
            disabled={disabled}
            title={word}
            aria-label={word}
            aria-pressed={on}
          >
            <span aria-hidden="true">{m.glyph}</span> {on ? m.doing : m.word}
          </button>
        );
      })}
    </>
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
function SurfaceButtons({ mode, setMode, inBench }: { mode: SurfaceMode; setMode: (m: SurfaceMode) => void; inBench: boolean }) {
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

/** the object URLs of the pictures in a list, let go once the list is */
const dropThumbs = (list: readonly { clip: Clip | null }[]) => {
  for (const a of list) if (a.clip?.thumb) URL.revokeObjectURL(a.clip.thumb);
};

/** whether a key went to something that takes typing */
const typing = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

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
  const [mode, setMode] = useState<Mode>(null);
  const picking = mode === "pick";
  const [pending, setPending] = useState<Pending | null>(null);
  const [pickNote, setPickNote] = useState("");
  const [intent, setIntent] = useState<Intent>("change");
  // notes left on elements and pictures, sent together (FR-027, FR-029)
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [pickBusy, setPickBusy] = useState(false);
  const [pickWarn, setPickWarn] = useState<string | null>(null);
  const [pickStatus, setPickStatus] = useState<{ text: string; bad: boolean } | null>(null);
  // the draw mode's marks, tool and colour (FR-029)
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]?.hex ?? "#e5484d");
  // a picture is being taken: the bars over the frame hide so they stay
  // out of it
  const [shooting, setShooting] = useState(false);
  // the shared tab, kept while design mode has anything going
  const shooter = useRef<Shooter | null>(null);
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
  const pageOff = () => {
    if (origin) frame.current?.contentWindow?.postMessage({ canopy: "pick", on: false }, origin);
  };

  /**
   * A picture of `rect`, a box of the page's viewport, saved on the backend
   * and opened as a note to write (FR-029): on an element (its own box, the
   * S key), on a box dragged with the clip tool, or on the page with the
   * marks drawn over it. The bars over the frame hide first. Where this
   * browser cannot take pictures the note still opens, saying so. True when
   * a note opened; a refused share says why in the status line, and an
   * element keeps its note without the picture.
   */
  const takeClip = async (kind: Clip["kind"], rect: Rect, pick: Pick | null, marks: string): Promise<boolean> => {
    const open = (clip: Clip | null) => {
      setPending({ pick, clip });
      setPickNote("");
      setPickStatus(null);
    };
    if (!canShoot()) {
      open({ kind, path: null, rect, marks, thumb: null });
      return true;
    }
    const fr = frame.current?.getBoundingClientRect();
    if (!fr) return false;
    const onScreen = { x: fr.left + rect.x, y: fr.top + rect.y, width: rect.width, height: rect.height };
    flushSync(() => setShooting(true));
    try {
      shooter.current ??= new Shooter();
      const blob = await shooter.current.shot(onScreen);
      const thumb = URL.createObjectURL(blob);
      const saved = await api.clipImage(repo.id, blob).catch((e: unknown) => {
        URL.revokeObjectURL(thumb);
        throw e;
      });
      open({ kind, path: saved.path, rect, marks, thumb });
      return true;
    } catch (e) {
      setPickStatus({ text: shotError(e), bad: true });
      if (pick) open(null);
      return pick !== null;
    } finally {
      setShooting(false);
    }
  };
  // the message listener below is bound once per origin; this keeps it on
  // the current takeClip, whose closure has the current repo and frame
  const takeClipRef = useRef(takeClip);
  useEffect(() => {
    takeClipRef.current = takeClip;
  });

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
        setMode(null);
        return;
      }
      const got = readPick(event.data);
      if (!got) return;
      if (got.via === "copy") {
        // the page keeps picking; what it reported goes on the clipboard
        copyText(pickText(got)).then(
          () => setPickStatus({ text: `Copied ${got.selector}.`, bad: false }),
          (e: unknown) => setPickStatus({ text: errText(e), bad: true }),
        );
        return;
      }
      setMode(null);
      if (got.via === "shot") {
        // the page took its outline off the element before it answered
        void takeClipRef.current("element", got.rect, got, "");
        return;
      }
      setPending({ pick: got, clip: null });
      setPickNote("");
      setPickStatus(null);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [origin]);

  // focus stays in canopy until the pick itself, so Esc is heard here too,
  // and so are C and S, which ask the page for the element under the pointer
  useEffect(() => {
    if (!mode) return;
    const keys = (e: KeyboardEvent) => {
      // words typed onto the page are the text mark's own; its Esc drops
      // only that mark
      if (mode === "draw" && typing(e.target)) return;
      if (e.key === "Escape") {
        if (mode === "pick") pageOff();
        if (mode === "draw") setShapes([]);
        setMode(null);
        setPickWarn(null);
        return;
      }
      if (mode !== "pick" || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const k = e.key.toLowerCase();
      if (k !== "c" && k !== "s") return;
      e.preventDefault();
      e.stopPropagation();
      if (origin) frame.current?.contentWindow?.postMessage({ canopy: "hovered", via: k === "c" ? "copy" : "shot" }, origin);
    };
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
    // pageOff closes over origin alone
  }, [mode, origin]);

  // a pick names a page on one dev server; another port drops it, since
  // the prompt's address is read from the choice when it is sent
  useEffect(() => {
    setPending((p) => {
      if (p) dropThumbs([p]);
      return null;
    });
    setMode(null);
    setShapes([]);
    setNotes((l) => {
      dropThumbs(l);
      return [];
    });
  }, [port]);

  // the shared tab is let go once design mode has nothing going; the
  // section going away lets it go too
  const idle = !mode && !pending && notes.length === 0 && !shooting;
  useEffect(() => {
    if (idle) shooter.current?.stop();
  }, [idle]);
  useEffect(() => () => shooter.current?.stop(), []);

  // the page numbers the elements with notes; each load starts a fresh
  // script, so the marks go again after it
  useEffect(() => {
    const w = frame.current?.contentWindow;
    if (!loaded || !origin || !w) return;
    w.postMessage(marksMessage(notes), origin);
  }, [notes, loaded, loads, origin]);

  useEffect(() => {
    if (pending) noteBox.current?.focus();
  }, [pending]);

  const toggleMode = (m: Exclude<Mode, null>) => {
    const next = mode === m ? null : m;
    if (mode === "pick" && next !== "pick") pageOff();
    if (mode === "draw" && next !== "draw") setShapes([]);
    setMode(next);
    setPickWarn(null);
    if (next) {
      setPending((p) => {
        if (p) dropThumbs([p]);
        return null;
      });
      setPickStatus(null);
    }
  };
  const cancelPending = () => {
    setPending((p) => {
      if (p) dropThumbs([p]);
      return null;
    });
  };
  const pageUrl = choice ? devUrl(choice.port, choice.path) : "";
  // the note being written joins the list; "add" goes back to picking for
  // the next element, "send now" sends the lot to the repo's agent
  const addPick = (then: "pick" | "send") => {
    if (!pending || !pickNote.trim() || pickBusy) return;
    const all = [...notes, { pick: pending.pick, clip: pending.clip, note: pickNote.trim(), intent }];
    setNotes(all);
    setPending(null);
    setPickNote("");
    setPickStatus(null);
    if (then === "pick") {
      setPickWarn(null);
      setMode("pick");
      return;
    }
    setPickBusy(true);
    sendToAgent(repo.id, annotationsPrompt(all, pageUrl))
      .then((how) => {
        dropThumbs(all);
        setNotes([]);
        setPickStatus({ text: PICK_SAID[how], bad: false });
      })
      .catch((e: unknown) => setPickStatus({ text: errText(e), bad: true }))
      .finally(() => setPickBusy(false));
  };
  // a picture of the whole frame with the marks on it, then a note
  const snap = () => {
    const fr = frame.current?.getBoundingClientRect();
    if (!fr) return;
    void takeClipRef.current("markup", { x: 0, y: 0, width: Math.round(fr.width), height: Math.round(fr.height) }, null, markupWords(shapes)).then((opened) => {
      if (!opened) return;
      setShapes([]);
      setMode(null);
    });
  };
  const hint =
    mode === "pick"
      ? `${notes.length ? "Click another element" : "Click an element"} on the page; C copies the one under the pointer, S takes its picture. Esc stops.`
      : mode === "clip"
        ? "Drag a box on the page to take its picture. Esc stops."
        : null; // the draw bar is its own hint
  const pickLine = pickWarn ? { text: pickWarn, bad: true } : pickStatus ?? (hint ? { text: hint, bad: false } : null);

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
      tools={(m, setM) => <SurfaceButtons mode={m} setMode={setM} inBench={inBench} />}
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
                  <ModeButtons mode={mode} disabled={!url || shooting} toggle={toggleMode} />
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
                  className={`preview-frame-wrap${shooting ? " shooting" : ""}${mode === "draw" ? " drawing" : ""}`}
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
                  {/* the clip and draw tools work on a layer over the frame,
                      so the page never sees the pointer */}
                  {url && mode === "clip" && (
                    <ClipLayer
                      onClip={(rect) => {
                        void takeClipRef.current("region", rect, null, "").then((opened) => {
                          if (opened) setMode(null);
                        });
                      }}
                    />
                  )}
                  {url && mode === "draw" && <DrawLayer shapes={shapes} onChange={setShapes} tool={tool} color={color} />}
                  {url && mode === "draw" && (
                    <DrawBar
                      tool={tool}
                      setTool={setTool}
                      color={color}
                      setColor={setColor}
                      marks={shapes.length}
                      onUndo={() => setShapes((l) => l.slice(0, -1))}
                      onClear={() => setShapes([])}
                      onSnap={snap}
                      onDone={() => toggleMode("draw")}
                      busy={shooting}
                    />
                  )}
                  {/* over the frame, so it shows in place and in the bench
                      alike; whatever the page sent is shown as text only */}
                  {url && (pending || pickLine) && (
                    <div className="preview-pick" role="region" aria-label="Design mode">
                      {pending ? (
                        <form
                          className="preview-pick-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            addPick("pick");
                          }}
                        >
                          {pending.pick && (
                            <code className="preview-pick-sel" title={pending.pick.selector}>
                              {pending.pick.selector}
                            </code>
                          )}
                          {pending.clip?.thumb && <img className="preview-pick-thumb" src={pending.clip.thumb} alt="The picture taken, which goes with the note" />}
                          {pending.clip && !pending.clip.path && (
                            <p className="preview-pick-line bad">{pending.clip.marks ? `${NO_SHOTS}; the marks go in words` : NO_SHOTS}</p>
                          )}
                          {pending.clip?.marks && <pre className="preview-pick-snip">{pending.clip.marks}</pre>}
                          {pending.pick && (pending.pick.text || pending.pick.html) && (
                            <pre className="preview-pick-snip">{(pending.pick.text || pending.pick.html).slice(0, 240)}</pre>
                          )}
                          <div className="preview-pick-intent" role="group" aria-label="What the note asks for">
                            {(["change", "question"] as const).map((k) => (
                              <button key={k} type="button" className={`mini${intent === k ? " on" : ""}`} aria-pressed={intent === k} onClick={() => setIntent(k)}>
                                {k === "change" ? "change it" : "ask about it"}
                              </button>
                            ))}
                          </div>
                          <textarea
                            ref={noteBox}
                            rows={3}
                            required
                            placeholder={intent === "change" ? "what should change here" : "what do you want to know"}
                            aria-label={pending.pick ? "Note for the agent about this element" : "Note for the agent about this picture"}
                            value={pickNote}
                            onChange={(e) => setPickNote(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault();
                                addPick(e.shiftKey ? "send" : "pick");
                              } else if (e.key === "Escape") cancelPending();
                            }}
                          />
                          <div className="preview-pick-row">
                            <button type="submit" className="mini" disabled={!pickNote.trim() || pickBusy} title="Add the note and pick the next element (Ctrl+Enter)">
                              add
                            </button>
                            <button
                              type="button"
                              className="mini"
                              disabled={!pickNote.trim() || pickBusy}
                              title={`Send ${notes.length ? `this and the ${notes.length} waiting` : "it"} to the repo's agent (Ctrl+Shift+Enter)`}
                              onClick={() => addPick("send")}
                            >
                              send now
                            </button>
                            <button type="button" className="mini" onClick={cancelPending}>
                              cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        pickLine && (
                          <p className={`preview-pick-line${pickLine.bad ? " bad" : ""}`} role="status">
                            <span>{pickLine.text}</span>
                            {!mode && (
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
                  {url && notes.length > 0 && !pending && (
                    <PickNotes
                      repoId={repo.id}
                      notes={notes}
                      pageUrl={pageUrl}
                      onRemove={(i) =>
                        setNotes((l) => {
                          dropThumbs(l.filter((_, j) => j === i));
                          return l.filter((_, j) => j !== i);
                        })
                      }
                      onClear={() =>
                        setNotes((l) => {
                          dropThumbs(l);
                          return [];
                        })
                      }
                      onSent={(said) => {
                        setNotes((l) => {
                          dropThumbs(l);
                          return [];
                        });
                        setPickStatus({ text: said, bad: false });
                      }}
                      say={(text, bad) => setPickStatus({ text, bad })}
                    />
                  )}
                  {/* in the bench the frame goes edge to edge, and these few
                      controls float over its corner instead of a bar above */}
                  {inBench && url && (
                    <div className="preview-float" role="toolbar" aria-label={`Preview of ${repo.name}`}>
                      <button type="button" className="mini" onClick={() => setNonce((n) => n + 1)} title="Reload" aria-label="Reload">
                        ⟳
                      </button>
                      <ModeButtons mode={mode} disabled={shooting} toggle={toggleMode} />
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

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api";
import { groveUrl, nameShellHere, parseRoute } from "../routes";
import { PANEL_TERM, TERM, closedIn, panelTermHeightFor, useStore, type TermTab } from "../store";
import { TERM_FONT, termId, viewKey } from "../term";
import { clamp } from "../util";
import { clientId } from "../client";
import { BAR_KEYS, NO_MODS, keyBytes, withMods, type BarKey, type Mods } from "../keys";
import { GLIDE_MIN, TAP_SLOP, dragLines, gapOf, glide, pinchFont, speedOf } from "../touch";
import { Wordmark } from "./TopBar";
import { TERM_GONE, type Repo } from "../../../src/core/types";

/** The design tokens the terminal paints with, resolved through a probe
 *  element so `light-dark()` collapses to the scheme in force. */
const TOKENS = [
  "--bark0",
  "--bark3",
  "--hair2",
  "--ink",
  "--ink-dim",
  "--ink-faint",
  "--moss",
  "--moss-pale",
  "--lichen",
  "--rust",
  "--sky",
  "--term-magenta",
  "--term-cyan",
] as const;

function resolveTokens(): Record<(typeof TOKENS)[number], string> {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const out = {} as Record<(typeof TOKENS)[number], string>;
  for (const name of TOKENS) {
    probe.style.color = `var(${name})`;
    out[name] = getComputedStyle(probe).color;
  }
  probe.remove();
  return out;
}

function xtermTheme(): ITheme {
  const c = resolveTokens();
  return {
    background: c["--bark0"],
    foreground: c["--ink"],
    cursor: c["--moss"],
    cursorAccent: c["--bark0"],
    selectionBackground: c["--hair2"],
    black: c["--bark3"],
    red: c["--rust"],
    green: c["--moss"],
    yellow: c["--lichen"],
    blue: c["--sky"],
    magenta: c["--term-magenta"],
    cyan: c["--term-cyan"],
    white: c["--ink-dim"],
    brightBlack: c["--ink-faint"],
    brightRed: c["--rust"],
    brightGreen: c["--moss-pale"],
    brightYellow: c["--lichen"],
    brightBlue: c["--sky"],
    brightMagenta: c["--term-magenta"],
    brightCyan: c["--term-cyan"],
    brightWhite: c["--ink"],
  };
}

/** The socket for one shell, sized to the terminal that will show it. The
 *  server holds shells by the tab's id: the first socket joins the shell of
 *  that name or starts one; a socket after a dropped connection (`rejoin`)
 *  only joins, since a shell that is gone should say so rather than start
 *  over under the same name. */
function socketUrl(tab: TermTab, cols: number, rows: number, rejoin: boolean): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({
    id: tab.repoId,
    term: tab.id,
    place: tab.place,
    cols: String(cols),
    rows: String(rows),
    // which device is looking, for the shell's viewers
    client: clientId(),
  });
  if (rejoin) q.set("attach", "1");
  return `${scheme}://${location.host}/api/term?${q}`;
}

/** how long to wait before the n-th try at rejoining a dropped shell */
const rejoinWait = (n: number): number => Math.min(30_000, 1000 * 2 ** Math.min(n, 5));

/** what the server says in its one text frame */
function exitOf(text: string): number | null | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && "exit" in v) {
      const code = (v as { exit: unknown }).exit;
      return typeof code === "number" ? code : null;
    }
  } catch {
    // not ours
  }
  return undefined;
}

/**
 * One shell: an xterm on a websocket to the pty at the repo. It lives for
 * the tab's life, hidden rather than unmounted when another tab is showing,
 * so switching tabs never ends a session.
 */
export function TermView({
  tab,
  active,
  onExit,
}: {
  tab: TermTab;
  active: boolean;
  /** told when the shell ends, for a view whose tab is not in the store */
  onExit?: (code: number | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const theme = useStore((s) => s.settings.theme);
  const endTerm = useStore((s) => s.endTerm);
  const fontSize = useStore((s) => s.settings.termFont);
  const setSetting = useStore((s) => s.setSetting);
  // read when the terminal is made and when a pinch ends, neither of which
  // should remake the terminal
  const fontRef = useRef(fontSize);
  fontRef.current = fontSize;
  const saveFont = useRef((px: number) => setSetting("termFont", px));
  saveFont.current = (px: number) => setSetting("termFont", px);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  // the touch key bar's sticky Ctrl/Alt, read by the phone keyboard's input
  // inside the effect below, so a ref beside the state the bar renders
  const [mods, setModsState] = useState<Mods>(NO_MODS);
  const modsRef = useRef<Mods>(NO_MODS);
  const setMods = (m: Mods) => {
    modsRef.current = m;
    setModsState(m);
  };
  const setModsRef = useRef(setMods);
  setModsRef.current = setMods;
  const sendRef = useRef<(data: string) => void>(() => {});
  const touch = useCoarsePointer();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: TERM_FONT.family,
      fontSize: fontRef.current,
      lineHeight: TERM_FONT.lineHeight,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: xtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const enc = new TextEncoder();
    let ws: WebSocket | null = null;
    let ended = false;
    let gone = false;
    let tries = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const note = (text: string) => term.write(`\r\n\x1b[2m${text}\x1b[0m`);
    const end = (code: number | null, text: string) => {
      if (ended) return;
      ended = true;
      endTerm(tab.id, code);
      exitRef.current?.(code);
      note(text);
    };
    const send = (data: string | Uint8Array) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    };
    // The shell lives on the server: a connection that drops without the
    // shell exiting (the server restarting, the laptop asleep, the tunnel
    // gone) is rejoined, first after a second and then with longer waits,
    // for as long as the view is up. A socket that has been open once only
    // rejoins, and the server answers a rejoin for a shell it no longer
    // holds with TERM_GONE, which ends the tab; one that never opened (the
    // server was away) may still start the shell.
    let opened = false;
    const connect = () => {
      if (gone || ended) return;
      const rejoin = opened;
      const sock = new WebSocket(socketUrl(tab, term.cols, term.rows, rejoin));
      sock.binaryType = "arraybuffer";
      ws = sock;
      // A rejoined shell's output arrives again from the start of its
      // scrollback, so the old copy goes when the first of it lands (not
      // sooner: a rejoin the server refuses should leave the screen as it
      // was). In band, since xterm's reset() from outside stops it painting.
      let replaying = rejoin;
      sock.onopen = () => {
        opened = true;
        tries = 0;
        term.focus();
      };
      sock.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
        if (typeof e.data === "string") {
          const code = exitOf(e.data);
          if (code !== undefined) end(code, `[the shell exited${code === null ? "" : ` with ${code}`}]`);
          return;
        }
        if (replaying) {
          replaying = false;
          term.write("\x1b[2J\x1b[3J\x1b[H");
        }
        term.write(new Uint8Array(e.data));
      };
      sock.onclose = (e) => {
        if (ws !== sock) return;
        ws = null;
        if (gone || ended) return;
        if (e.code === TERM_GONE) {
          end(null, "[the shell is gone]");
          return;
        }
        if (e.code === 1011) {
          end(null, e.reason ? `[${e.reason}]` : "[the shell could not start]");
          return;
        }
        if (tries === 0) note(opened ? "[the connection dropped; rejoining]" : "[could not reach the canopy server; retrying]");
        retry = setTimeout(connect, rejoinWait(tries));
        tries += 1;
      };
    };
    connect();

    // what the key bar sends goes the same way as a typed key
    sendRef.current = (data) => send(enc.encode(data));
    const subs = [
      term.onData((data) => {
        const m = modsRef.current;
        if (m.ctrl || m.alt) {
          setModsRef.current(NO_MODS);
          send(enc.encode(withMods(data, m)));
        } else send(enc.encode(data));
      }),
      // mouse reports and the like arrive as raw bytes in a string
      term.onBinary((data) => send(Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 0xff))),
      term.onResize(({ cols, rows }) => send(JSON.stringify({ resize: { cols, rows } }))),
    ];
    // An image cannot go down a terminal, and the backend has no clipboard
    // for claude to read it from: a pasted or dropped image is uploaded,
    // and its saved path is pasted in instead, which Claude Code attaches.
    const images = (list: DataTransfer | null): File[] =>
      [...(list?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    const upload = (files: File[]) => {
      void (async () => {
        const texts: string[] = [];
        for (const f of files) {
          try {
            texts.push((await api.pasteImage(tab.id, f)).text);
          } catch (err) {
            note(`[the image did not paste: ${err instanceof Error ? err.message : String(err)}]`);
          }
        }
        if (texts.length > 0) term.paste(texts.join(" "));
        term.focus();
      })();
    };
    const onPaste = (e: ClipboardEvent) => {
      const files = images(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      upload(files);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const files = images(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      upload(files);
    };
    // capture, so it runs before xterm's own paste handler on its textarea
    el.addEventListener("paste", onPaste, true);
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    // A finger on the shell. xterm 6 has no touch handling of its own, so a
    // drag scrolls (the scrollback, or for a program that owns the screen
    // the arrows or wheel reports it would get from a mouse), a flick glides
    // on, and two fingers pinch the text size. A touch that stays within
    // TAP_SLOP is left alone and arrives at xterm as a click, which is what
    // focuses it and raises the phone's keyboard.
    let drag: { start: number; y: number; carry: number; moved: boolean; samples: { y: number; t: number }[] } | null =
      null;
    let pinch: { gap: number; font: number } | null = null;
    let at = { x: 0, y: 0 };
    let gliding = 0;
    let fitting = 0;
    const stopGlide = () => {
      if (gliding) cancelAnimationFrame(gliding);
      gliding = 0;
    };
    const fitSoon = () => {
      if (!fitting)
        fitting = requestAnimationFrame(() => {
          fitting = 0;
          fit.fit();
        });
    };
    const screen = () => term.element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
    const rowPx = () => {
      const s = screen();
      return s && term.rows > 0 ? s.clientHeight / term.rows : 0;
    };
    const scrollBy = (lines: number) => {
      if (lines === 0) return;
      const n = Math.min(Math.abs(lines), 30);
      if (term.modes.mouseTrackingMode !== "none") {
        // the program asked for the mouse: a wheel turn per line, at the finger
        const target = screen();
        for (let i = 0; i < n; i++)
          target?.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: Math.sign(lines),
              deltaMode: WheelEvent.DOM_DELTA_LINE,
              clientX: at.x,
              clientY: at.y,
              bubbles: true,
              cancelable: true,
            }),
          );
      } else if (term.buffer.active.type === "alternate") {
        // a full-screen program with no scrollback: arrows, as a wheel sends
        const arrow = keyBytes(lines > 0 ? "down" : "up", NO_MODS, term.modes.applicationCursorKeysMode);
        send(enc.encode(arrow.repeat(n)));
      } else term.scrollLines(lines);
    };
    const onTouchStart = (e: TouchEvent) => {
      stopGlide();
      const [a, b] = [e.touches[0], e.touches[1]];
      if (a && b) {
        drag = null;
        pinch = { gap: gapOf(a, b), font: term.options.fontSize ?? fontRef.current };
      } else if (a && e.touches.length === 1) {
        pinch = null;
        at = { x: a.clientX, y: a.clientY };
        drag = { start: a.clientY, y: a.clientY, carry: 0, moved: false, samples: [{ y: a.clientY, t: e.timeStamp }] };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (pinch && a && b) {
        e.preventDefault();
        const px = pinchFont(pinch.font, pinch.gap, gapOf(a, b));
        if (px !== term.options.fontSize) {
          term.options.fontSize = px;
          fitSoon();
        }
        return;
      }
      if (!drag || !a || e.touches.length !== 1) return;
      if (!drag.moved && Math.abs(a.clientY - drag.start) < TAP_SLOP) return;
      drag.moved = true;
      e.preventDefault();
      at = { x: a.clientX, y: a.clientY };
      const r = dragLines(drag.carry, a.clientY - drag.y, rowPx());
      drag.carry = r.carry;
      drag.y = a.clientY;
      drag.samples.push({ y: a.clientY, t: e.timeStamp });
      if (drag.samples.length > 8) drag.samples.shift();
      scrollBy(r.lines);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (pinch) {
        if (e.touches.length < 2) {
          pinch = null;
          saveFont.current(term.options.fontSize ?? fontRef.current);
        }
        return;
      }
      const d = drag;
      drag = null;
      if (!d?.moved) return;
      // a drag is not a click
      if (e.cancelable) e.preventDefault();
      let v = speedOf(d.samples);
      if (Math.abs(v) <= GLIDE_MIN) return;
      let carry = d.carry;
      let last = performance.now();
      const step = (now: number) => {
        const dt = now - last;
        last = now;
        v = glide(v, dt);
        if (v === 0) {
          gliding = 0;
          return;
        }
        const r = dragLines(carry, v * dt, rowPx());
        carry = r.carry;
        scrollBy(r.lines);
        gliding = requestAnimationFrame(step);
      };
      gliding = requestAnimationFrame(step);
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", onTouchEnd, { passive: false });
    // Any change of size refits: the strip dragged taller, the window
    // resized, the tab shown again after being hidden.
    const ro = new ResizeObserver(() => {
      if (el.offsetParent !== null) fit.fit();
    });
    ro.observe(el);
    return () => {
      gone = true;
      if (retry) clearTimeout(retry);
      ro.disconnect();
      stopGlide();
      if (fitting) cancelAnimationFrame(fitting);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("paste", onPaste, true);
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      for (const s of subs) s.dispose();
      // closing the socket leaves the shell running for the next view of it
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [tab.id, tab.repoId, tab.path, endTerm]);

  useEffect(() => {
    if (!active) return;
    fitRef.current?.fit();
    termRef.current?.focus();
  }, [active]);

  // A pinch in any shell sizes them all; one hidden now refits when shown,
  // since showing it changes its box.
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    if (host.current?.offsetParent) fitRef.current?.fit();
  }, [fontSize]);

  // The theme setting and the OS scheme both repaint the terminal.
  useEffect(() => {
    const paint = () => {
      const term = termRef.current;
      if (term) term.options.theme = xtermTheme();
    };
    paint();
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", paint);
    return () => mq.removeEventListener("change", paint);
  }, [theme]);

  const tapKey = (key: BarKey) => {
    const term = termRef.current;
    sendRef.current(keyBytes(key, modsRef.current, term?.modes.applicationCursorKeysMode ?? false));
    if (modsRef.current.ctrl || modsRef.current.alt) setMods(NO_MODS);
  };

  return (
    <div className="term-view" hidden={!active}>
      <div ref={host} className="term-screen" />
      {touch && (
        <KeyBar
          mods={mods}
          onMods={setMods}
          onKey={tapKey}
          onKeyboard={() => termRef.current?.focus()}
          onPaste={
            canPaste()
              ? () => {
                  navigator.clipboard.readText().then(
                    (text) => {
                      if (text) termRef.current?.paste(text);
                    },
                    () => {
                      // refused, or nothing readable there
                    },
                  );
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/** whether the main pointer is a finger: a phone or a tablet, where the
 *  key bar shows */
function useCoarsePointer(): boolean {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setCoarse(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return coarse;
}

/** Whether a key can paste the clipboard: reading it needs a secure page
 *  (the tunnel, or localhost), not the tailnet's plain http. */
const canPaste = (): boolean => isSecureContext && typeof navigator.clipboard?.readText === "function";

/** keys that repeat while held */
const REPEATS: readonly BarKey[] = ["up", "down", "left", "right", "pgup", "pgdn"];

/**
 * The keys a phone keyboard lacks, in a strip under the shell. Each acts on
 * pointer down with the default prevented, so the terminal keeps focus and
 * the phone's keyboard stays up; the arrows repeat while held. Ctrl and Alt
 * stay lit until the next key, from here or the keyboard.
 */
function KeyBar({
  mods,
  onMods,
  onKey,
  onKeyboard,
  onPaste,
}: {
  mods: Mods;
  onMods: (m: Mods) => void;
  onKey: (key: BarKey) => void;
  onKeyboard: () => void;
  /** reads the clipboard into the shell; absent where the page cannot */
  onPaste?: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  const press = (key: BarKey) => (e: PointerEvent) => {
    e.preventDefault();
    stop();
    onKey(key);
    if (!REPEATS.includes(key)) return;
    const again = () => {
      onKey(key);
      timer.current = setTimeout(again, 70);
    };
    timer.current = setTimeout(again, 400);
  };
  // a keyboard (Enter or Space on a focused button) arrives as a click with
  // no pointer behind it
  const byKeyboard = (fn: () => void) => (e: MouseEvent) => {
    if (e.detail === 0) fn();
  };
  const toggle = (which: keyof Mods) => (e: PointerEvent) => {
    e.preventDefault();
    onMods({ ...mods, [which]: !mods[which] });
  };
  return (
    <div className="term-keys" role="toolbar" aria-label="Terminal keys">
      <button
        type="button"
        className="term-key"
        tabIndex={-1}
        title="Show the keyboard"
        aria-label="Show the keyboard"
        onPointerDown={(e) => {
          e.preventDefault();
          onKeyboard();
        }}
        onClick={byKeyboard(onKeyboard)}
      >
        ⌨
      </button>
      {onPaste && (
        // on click rather than pointer down: a touch grants the page the
        // right to read the clipboard only once the finger lifts
        <button
          type="button"
          className="term-key"
          tabIndex={-1}
          title="Paste the clipboard"
          aria-label="Paste the clipboard"
          onPointerDown={(e) => e.preventDefault()}
          onClick={onPaste}
        >
          paste
        </button>
      )}
      {(["ctrl", "alt"] as const).map((m) => (
        <button
          key={m}
          type="button"
          className={`term-key mod${mods[m] ? " on" : ""}`}
          tabIndex={-1}
          aria-pressed={mods[m]}
          title={`${m === "ctrl" ? "Ctrl" : "Alt"} for the next key`}
          onPointerDown={toggle(m)}
          onClick={byKeyboard(() => onMods({ ...mods, [m]: !mods[m] }))}
        >
          {m}
        </button>
      ))}
      {BAR_KEYS.map((k) => (
        <button
          key={k.key}
          type="button"
          className="term-key"
          tabIndex={-1}
          title={k.title}
          aria-label={k.title}
          onPointerDown={press(k.key)}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          onContextMenu={(e) => e.preventDefault()}
          onClick={byKeyboard(() => onKey(k.key))}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}

/** A shell area's top edge: dragged to size it, arrowed by the keyboard,
 *  double-clicked to reset. It writes the height live to `cssVar` on `box`
 *  while dragging, then commits it on release. */
export function TermGrip({
  box,
  cssVar,
  label,
  height,
  setHeight,
  bounds,
  edge = "top",
}: {
  box: React.RefObject<HTMLElement | null>;
  cssVar: string;
  label: string;
  height: number;
  setHeight: (px: number) => void;
  bounds: { min: number; max: number; initial: number };
  /** which edge the grip sits on: "top" grows upward, "bottom" downward */
  edge?: "top" | "bottom";
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ y: number; h: number } | null>(null);

  const apply = (h: number) => box.current?.style.setProperty(cssVar, `${h}px`);
  const clamped = (raw: number) => clamp(raw, bounds.min, bounds.max);
  // a top grip grows as the pointer rises, a bottom grip as it falls
  const sized = (e: PointerEvent<HTMLDivElement>) => {
    const dy = start.current ? e.clientY - start.current.y : 0;
    return clamped((start.current?.h ?? height) + (edge === "top" ? -dy : dy));
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { y: e.clientY, h: height };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    apply(sized(e));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const h = sized(e);
    start.current = null;
    setDragging(false);
    setHeight(h);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowUp") setHeight(height + step);
    else if (e.key === "ArrowDown") setHeight(height - step);
    else return;
    e.preventDefault();
  };
  return (
    <div
      className={`term-grip ${edge}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={height}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => setHeight(bounds.initial)}
      onKeyDown={onKey}
    />
  );
}

/** Two shells at one repo get numbered so their tabs can be told apart. */
function tabLabels(terms: TermTab[]): string[] {
  const seen = new Map<string, number>();
  return terms.map((t) => {
    const n = (seen.get(t.repoId) ?? 0) + 1;
    seen.set(t.repoId, n);
    return n === 1 ? t.name : `${t.name} ${n}`;
  });
}

/** The row of tabs over a set of shells, with what comes before and after
 *  them (a caption, a "new" button) passed in, and `end` at the far right. */
function TermTabs({
  terms,
  active,
  onShow,
  caption,
  extra,
  end,
}: {
  terms: TermTab[];
  active: string | null;
  onShow: (id: string) => void;
  caption: string;
  extra?: React.ReactNode;
  end?: React.ReactNode;
}) {
  const closeTerm = useStore((s) => s.closeTerm);
  const labels = tabLabels(terms);
  return (
    <div className="term-tabs" role="tablist" aria-label="Open shells">
      {caption && <span className="term-caption">{caption}</span>}
      {terms.map((t, i) => {
        const label = labels[i] ?? t.name;
        const on = t.id === active;
        return (
          <div
            key={t.id}
            role="tab"
            tabIndex={on ? 0 : -1}
            aria-selected={on}
            className={`term-tab${on ? " on" : ""}${t.exit !== undefined ? " exited" : ""}`}
            title={t.exit === undefined ? t.path : `${t.path} · exited`}
            onClick={() => onShow(t.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onShow(t.id);
              }
            }}
          >
            <span className={`dot ${t.exit === undefined ? "moss" : "faint"}`} aria-hidden="true" />
            <span className="term-tab-name">{label}</span>
            <button
              type="button"
              className="term-x"
              aria-label={`Close the shell at ${label}`}
              title="close"
              onClick={(e) => {
                e.stopPropagation();
                closeTerm(t.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      {extra}
      {end}
    </div>
  );
}

/** The tab row's maximize switch: the shells take the whole of what holds
 *  them (the panel, or the window for the strip), and again gives it back. */
function FullToggle({ full, onToggle, what }: { full: boolean; onToggle: () => void; what: string }) {
  return (
    <button
      type="button"
      className={`term-new term-full${full ? " on" : ""}`}
      title={full ? `Give the ${what} back` : `Shells take the whole ${what}`}
      aria-label={full ? "Restore shell size" : "Maximize shell"}
      aria-pressed={full}
      onClick={(e) => {
        onToggle();
        // back to the shell showing, so typing carries on where it was
        const box = e.currentTarget.closest("section");
        requestAnimationFrame(() =>
          box?.querySelector<HTMLElement>(".term-view:not([hidden]) textarea")?.focus(),
        );
      }}
    >
      {full ? "⤡" : "⤢"}
    </button>
  );
}

/**
 * The shells along the bottom of the window: one tab per shell, the repo's
 * name on it, opened from a card's menu. Nothing renders while there are
 * none, so the grove keeps its whole height.
 */
export function TermDock() {
  const terms = useStore((s) => s.terms);
  const activeTerm = useStore((s) => s.activeTerm);
  const termHeight = useStore((s) => s.termHeight);
  const setTermHeight = useStore((s) => s.setTermHeight);
  const showTerm = useStore((s) => s.showTerm);
  const dock = useRef<HTMLElement>(null);
  const [full, setFull] = useState(false);
  const strip = terms.filter((t) => t.place === "strip");

  if (strip.length === 0) return null;
  return (
    <section
      ref={dock}
      className={`termdock${full ? " full" : ""}`}
      aria-label="Shells"
      style={{ "--term-h": `${termHeight}px` } as CSSProperties}
    >
      {!full && (
        <TermGrip
          box={dock}
          cssVar="--term-h"
          label="Terminal strip height"
          height={termHeight}
          setHeight={setTermHeight}
          bounds={TERM}
        />
      )}
      <TermTabs
        terms={strip}
        active={activeTerm}
        onShow={showTerm}
        caption="shells"
        end={<FullToggle full={full} onToggle={() => setFull(!full)} what="window" />}
      />
      <div className="term-body">
        {strip.map((t) => (
          <TermView key={viewKey(t)} tab={t} active={t.id === activeTerm} />
        ))}
      </div>
    </section>
  );
}

/**
 * The shells living in one repo's panel: the panel's footer, tabs when there
 * are two or more, the newest showing, sized by a grip along its top edge
 * since the panel's bottom is where it sits. Nothing renders while the repo
 * has none there.
 */
export function PanelShells({ repo }: { repo: Repo }) {
  const terms = useStore((s) => s.terms);
  const openTerm = useStore((s) => s.openTerm);
  const closed = useStore((s) => closedIn(s, repo.id, "shell"));
  const toggleSection = useStore((s) => s.toggleSection);
  const panelTermHeight = useStore((s) => panelTermHeightFor(s, repo.id));
  const setPanelTermHeight = useStore((s) => s.setPanelTermHeight);
  const box = useRef<HTMLElement>(null);
  const [full, setFull] = useState(false);
  const mine = terms.filter((t) => t.place === "panel" && t.repoId === repo.id);
  const [chosen, setChosen] = useState<string | null>(null);
  // the newest shell shows until another tab is picked
  const latest = mine[mine.length - 1]?.id ?? null;
  const [seenLatest, setSeenLatest] = useState(latest);
  if (latest !== seenLatest) {
    setSeenLatest(latest);
    setChosen(latest);
  }
  const active = mine.some((t) => t.id === chosen) ? chosen : latest;

  if (mine.length === 0) return null;
  return (
    <section
      ref={box}
      className={`panel-shells${full && !closed ? " full" : ""}`}
      aria-label={`Shells at ${repo.name}`}
      style={{ "--panel-term-h": `${panelTermHeight}px` } as CSSProperties}
    >
      {!closed && !full && (
        <TermGrip
          box={box}
          cssVar="--panel-term-h"
          label={`Shell height at ${repo.name}`}
          height={panelTermHeight}
          setHeight={(px) => setPanelTermHeight(repo.id, px)}
          bounds={PANEL_TERM}
        />
      )}
      <button
        type="button"
        className={`panel-label fold${closed ? "" : " open"}`}
        aria-expanded={!closed}
        onClick={() => toggleSection(repo.id, "shell")}
      >
        shell <span>{mine.length}</span>
      </button>
      {/* Kept mounted while folded (display:none via `hidden`) so the shells
          keep running: unmounting a TermView hangs up its pty. */}
      <div className="panel-shells-body" hidden={closed}>
        <TermTabs
          terms={mine}
          active={active}
          onShow={setChosen}
          caption=""
          extra={
            <button
              type="button"
              className="term-new"
              title="Another shell at this repo, here"
              aria-label="New shell"
              onClick={() => openTerm(repo.id, "panel")}
            >
              +
            </button>
          }
          end={<FullToggle full={full} onToggle={() => setFull(!full)} what="panel" />}
        />
        <div className="term-body">
          {mine.map((t) => (
            <TermView key={viewKey(t)} tab={t} active={t.id === active && !closed} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** One shell, edge to edge: what a "new tab" or "new window" shell shows. */
export function ShellSolo({ id }: { id: string }) {
  const root = useStore((s) => s.root);
  const repo = useStore((s) => s.repos.find((r) => r.id === id));
  const name = repo?.name;
  // The shell's name goes into the url, so a reload of this window comes
  // back to the same shell rather than opening another.
  const [tab] = useState<TermTab | null>(() =>
    repo && !repo.forge
      ? {
          id: parseRoute(window.location.search).term ?? termId(),
          repoId: repo.id,
          name: repo.name,
          path: repo.path,
          place: "strip",
        }
      : null,
  );
  const [exited, setExited] = useState(false);

  useEffect(() => {
    if (tab) nameShellHere(tab.id);
  }, [tab]);

  useEffect(() => {
    document.title = name ? `${name} · shell · canopy` : "canopy";
    return () => {
      document.title = "canopy";
    };
  }, [name]);

  return (
    <div className="shell-solo">
      <header className="topbar">
        <Wordmark />
        <span className="root-path" title={root}>
          {root}
        </span>
        <span className="solo-id">{id}</span>
        {exited && <span className="shell-exited">exited</span>}
        <span className="spacer" />
        <a className="mini" href={groveUrl()} target="_blank">
          whole grove ↗
        </a>
      </header>
      {tab ? (
        <div className="term-body">
          <TermView tab={tab} active onExit={() => setExited(true)} />
        </div>
      ) : (
        <p className="empty">
          No repo called {id} under {root}, or none with a folder to open a shell in.{" "}
          <a href={groveUrl()}>Open the whole grove</a> instead.
        </p>
      )}
    </div>
  );
}

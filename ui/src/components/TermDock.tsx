import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TERM, useStore, type TermTab } from "../store";
import { clamp } from "../util";

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

const FONT =
  '"Berkeley Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';

/** the socket for one shell, sized to the terminal that will show it */
function socketUrl(tab: TermTab, cols: number, rows: number): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ id: tab.repoId, cols: String(cols), rows: String(rows) });
  return `${scheme}://${location.host}/api/term?${q}`;
}

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
function TermView({ tab, active }: { tab: TermTab; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const theme = useStore((s) => s.settings.theme);
  const endTerm = useStore((s) => s.endTerm);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: FONT,
      fontSize: 12.5,
      lineHeight: 1.2,
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

    const ws = new WebSocket(socketUrl(tab, term.cols, term.rows));
    ws.binaryType = "arraybuffer";
    const enc = new TextEncoder();
    let ended = false;
    const end = (code: number | null, note: string) => {
      if (ended) return;
      ended = true;
      endTerm(tab.id, code);
      term.write(`\r\n\x1b[2m${note}\x1b[0m`);
    };
    ws.onopen = () => term.focus();
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data === "string") {
        const code = exitOf(e.data);
        if (code !== undefined) end(code, `[the shell exited${code === null ? "" : ` with ${code}`}]`);
        return;
      }
      term.write(new Uint8Array(e.data));
    };
    ws.onclose = (e) => end(null, e.reason ? `[${e.reason}]` : "[the connection closed]");
    ws.onerror = () => end(null, "[could not reach the canopy server]");

    const send = (data: string | Uint8Array) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    };
    const subs = [
      term.onData((data) => send(enc.encode(data))),
      // mouse reports and the like arrive as raw bytes in a string
      term.onBinary((data) => send(Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 0xff))),
      term.onResize(({ cols, rows }) => send(JSON.stringify({ resize: { cols, rows } }))),
    ];
    // Any change of size refits: the strip dragged taller, the window
    // resized, the tab shown again after being hidden.
    const ro = new ResizeObserver(() => {
      if (el.offsetParent !== null) fit.fit();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      for (const s of subs) s.dispose();
      ws.onclose = null;
      ws.close();
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

  return <div ref={host} className="term-view" hidden={!active} />;
}

/** The strip's top edge: dragged to size it, arrowed by the keyboard,
 *  double-clicked to reset. */
function TermGrip({ dock }: { dock: React.RefObject<HTMLElement | null> }) {
  const height = useStore((s) => s.termHeight);
  const setTermHeight = useStore((s) => s.setTermHeight);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ y: number; h: number } | null>(null);

  const apply = (h: number) => dock.current?.style.setProperty("--term-h", `${h}px`);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { y: e.clientY, h: height };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    apply(clamp(start.current.h + (start.current.y - e.clientY), TERM.min, TERM.max));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const h = clamp(start.current.h + (start.current.y - e.clientY), TERM.min, TERM.max);
    start.current = null;
    setDragging(false);
    setTermHeight(h);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowUp") setTermHeight(height + step);
    else if (e.key === "ArrowDown") setTermHeight(height - step);
    else return;
    e.preventDefault();
  };
  return (
    <div
      className={dragging ? "term-grip dragging" : "term-grip"}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Terminal strip height"
      aria-valuenow={height}
      aria-valuemin={TERM.min}
      aria-valuemax={TERM.max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => setTermHeight(TERM.initial)}
      onKeyDown={onKey}
    />
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
  const showTerm = useStore((s) => s.showTerm);
  const closeTerm = useStore((s) => s.closeTerm);
  const dock = useRef<HTMLElement>(null);

  // Two shells at one repo get numbered so the tabs can be told apart.
  const seen = new Map<string, number>();
  const labels = terms.map((t) => {
    const n = (seen.get(t.repoId) ?? 0) + 1;
    seen.set(t.repoId, n);
    return n === 1 ? t.name : `${t.name} ${n}`;
  });

  if (terms.length === 0) return null;
  return (
    <section
      ref={dock}
      className="termdock"
      aria-label="Shells"
      style={{ "--term-h": `${termHeight}px` } as CSSProperties}
    >
      <TermGrip dock={dock} />
      <div className="term-tabs" role="tablist" aria-label="Open shells">
        <span className="term-caption">shells</span>
        {terms.map((t, i) => {
          const label = labels[i] ?? t.name;
          const on = t.id === activeTerm;
          return (
            <div
              key={t.id}
              role="tab"
              tabIndex={on ? 0 : -1}
              aria-selected={on}
              className={`term-tab${on ? " on" : ""}${t.exit !== undefined ? " exited" : ""}`}
              title={t.exit === undefined ? t.path : `${t.path} · exited`}
              onClick={() => showTerm(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  showTerm(t.id);
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
      </div>
      <div className="term-body">
        {terms.map((t) => (
          <TermView key={t.id} tab={t} active={t.id === activeTerm} />
        ))}
      </div>
    </section>
  );
}

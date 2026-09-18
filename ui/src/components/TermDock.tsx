import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { groveUrl } from "../routes";
import { PANEL_TERM, TERM, useStore, type TermTab } from "../store";
import { clamp } from "../util";
import { Wordmark } from "./TopBar";
import type { Repo } from "../../../src/core/types";

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
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

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
      exitRef.current?.(code);
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
 *  them (a caption, a "new" button) passed in. */
function TermTabs({
  terms,
  active,
  onShow,
  caption,
  extra,
}: {
  terms: TermTab[];
  active: string | null;
  onShow: (id: string) => void;
  caption: string;
  extra?: React.ReactNode;
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
    </div>
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
  const strip = terms.filter((t) => t.place === "strip");

  if (strip.length === 0) return null;
  return (
    <section
      ref={dock}
      className="termdock"
      aria-label="Shells"
      style={{ "--term-h": `${termHeight}px` } as CSSProperties}
    >
      <TermGrip
        box={dock}
        cssVar="--term-h"
        label="Terminal strip height"
        height={termHeight}
        setHeight={setTermHeight}
        bounds={TERM}
      />
      <TermTabs terms={strip} active={activeTerm} onShow={showTerm} caption="shells" />
      <div className="term-body">
        {strip.map((t) => (
          <TermView key={t.id} tab={t} active={t.id === activeTerm} />
        ))}
      </div>
    </section>
  );
}

/**
 * The shells living in one repo's panel: a section of the panel, tabs when
 * there are two or more, the newest showing. Nothing renders while the repo
 * has none there.
 */
export function PanelShells({ repo }: { repo: Repo }) {
  const terms = useStore((s) => s.terms);
  const openTerm = useStore((s) => s.openTerm);
  const closed = useStore((s) => s.closedSections.includes("shell"));
  const toggleSection = useStore((s) => s.toggleSection);
  const panelTermHeight = useStore((s) => s.panelTermHeight);
  const setPanelTermHeight = useStore((s) => s.setPanelTermHeight);
  const inner = useRef<HTMLDivElement>(null);
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
    <section className="panel-shells" aria-label={`Shells at ${repo.name}`}>
      <button
        type="button"
        className={`panel-label fold${closed ? "" : " open"}`}
        aria-expanded={!closed}
        onClick={() => toggleSection("shell")}
      >
        shell <span>{mine.length}</span>
      </button>
      {/* Kept mounted while folded (display:none via `hidden`) so the shells
          keep running: unmounting a TermView hangs up its pty. */}
      <div
        ref={inner}
        className="panel-shells-body"
        hidden={closed}
        style={{ "--panel-term-h": `${panelTermHeight}px` } as CSSProperties}
      >
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
        />
        <div className="term-body">
          {mine.map((t) => (
            <TermView key={t.id} tab={t} active={t.id === active && !closed} />
          ))}
        </div>
        <TermGrip
          box={inner}
          cssVar="--panel-term-h"
          label={`Shell height at ${repo.name}`}
          height={panelTermHeight}
          setHeight={setPanelTermHeight}
          bounds={PANEL_TERM}
          edge="bottom"
        />
      </div>
    </section>
  );
}

/** One shell, edge to edge: what a "new tab" or "new window" shell shows. */
export function ShellSolo({ id }: { id: string }) {
  const root = useStore((s) => s.root);
  const repo = useStore((s) => s.repos.find((r) => r.id === id));
  const name = repo?.name;
  const [tab] = useState<TermTab | null>(() =>
    repo && !repo.forge
      ? { id: "solo", repoId: repo.id, name: repo.name, path: repo.path, place: "strip" }
      : null,
  );
  const [exited, setExited] = useState(false);

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

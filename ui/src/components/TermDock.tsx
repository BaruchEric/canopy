import { useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, reachable, socketUrl as backendSocket } from "../api";
import { copyText } from "../share";
import { backendOf, plainOf, qual } from "../registry";
import { groveUrl, nameShellHere, parseRoute, popShell } from "../routes";
import {
  PANEL_TERM,
  TERM,
  connOf,
  dockless,
  idLabel,
  idText,
  multi,
  panelTermHeightFor,
  useStore,
  type TermTab,
} from "../store";
import { IdLabel, WaitingFor, useWaitingFor } from "./IdLabel";
import { TERM_FONT, joinsOnly, otherShells, termId, viewKey } from "../term";
import { benchIs, benchSolo } from "../front";
import { SPOT_WORD, flipMode, shellCopyOf, shellSpot, termFontIn, tidyLines, type CopyOut, type ShellSpot, type SurfaceMode } from "../surface";
import { SHELL_TARGETS, type ShellTarget } from "../settings";
import { Gear, type GearEntry } from "./Gear";
import {
  FocusBackdrop,
  FocusGrips,
  focusVars,
  useLeaveOnEscape,
  modeEntries,
  benchEntries,
  saveTermFont,
  shareEntries,
  ShellSpotHere,
  useSectionClosed,
  useShellZoom,
} from "./Surface";
import { clamp } from "../util";
import { clientId, myPlatform } from "../client";
import { BAR_KEYS, NO_MODS, keyBytes, shortcutOf, withMods, type BarKey, type Mods } from "../keys";
import { osc52Text } from "../osc52";
import { GLIDE_MIN, TAP_SLOP, dragLines, gapOf, glide, pinchFont, speedOf } from "../touch";
import { showKeyboard } from "../softkeys";
import { Wordmark } from "./TopBar";
import { AgentButtons } from "./AgentButtons";
import { LIVE } from "../liveTerms";
import { TERM_GONE, type Repo } from "../../../src/core/types";
import { NewShellButton } from "./NewShell";

/** The design tokens the terminal paints with, resolved through a probe
 *  element so `light-dark()` collapses to the scheme in force. */
/** ms a shell's size has to hold before the pty is told it */
const RESIZE_SETTLE = 120;


/** what a shell holds, scrollback and screen, as text */
function shellText(id: string): string {
  const buf = LIVE.get(id)?.buffer.active;
  if (!buf) return "";
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  return tidyLines(lines);
}

/** how long a copy waits on the server for tmux's text before it takes the
 *  buffer: a copy off a page that is not a secure one needs the click's
 *  own moment, which does not last */
const COPY_WAIT = 1500;

/** a shell's copy: tmux's clean text when the server answers in time */
async function shellCopy(id: string): Promise<CopyOut> {
  const got = await Promise.race([
    api.termText(id).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), COPY_WAIT)),
  ]);
  return shellCopyOf(got, () => shellText(id));
}

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
 *  over under the same name. The socket goes to the shell's own backend,
 *  with the ids that backend knows. */
function socketUrl(tab: TermTab, cols: number, rows: number, rejoin: boolean): string {
  const q = new URLSearchParams({
    id: plainOf(tab.repoId),
    term: plainOf(tab.id),
    place: tab.place,
    cols: String(cols),
    rows: String(rows),
    // which device is looking, for the shell's viewers
    client: clientId(),
  });
  if (joinsOnly(tab, rejoin)) q.set("attach", "1");
  else if (tab.start) {
    // a backend older than harnesses reports none and knows only start=claude
    const legacy = !connOf(useStore.getState(), backendOf(tab.id)).backend.harnesses;
    q.set("start", legacy ? "claude" : tab.start);
    if (tab.profile) q.set("profile", tab.profile);
    else if (tab.harness) q.set("harness", tab.harness);
    if (tab.prompt) q.set("prompt", tab.prompt);
  }
  return backendSocket(backendOf(tab.id), `/api/term?${q}`);
}

/** how often a shell whose machine has no URL yet looks again */
const UNREACHABLE_WAIT = 1000;

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
  const palette = useStore((s) => s.settings.palette);
  const moreContrast = useStore((s) => s.settings.moreContrast);
  const endTerm = useStore((s) => s.endTerm);
  // the text size is where the shell shows: in place, filling, in front
  // or in a window of its own each keep theirs
  const spot = useContext(ShellSpotHere);
  const fontSize = useStore((s) => termFontIn(s.settings.termFont, s.settings.termFonts, spot));
  // read when the terminal is made and when a pinch ends, neither of which
  // should remake the terminal
  const fontRef = useRef(fontSize);
  fontRef.current = fontSize;
  const saveFont = useRef((px: number) => saveTermFont(spot, px));
  saveFont.current = (px: number) => saveTermFont(spot, px);
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
      // Option-drag selects even while a program has the mouse (Claude Code
      // does); Shift-drag is the same off a Mac, built in
      macOptionClickForcesSelection: true,
      theme: xtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    LIVE.set(tab.id, term);

    const enc = new TextEncoder();
    let ws: WebSocket | null = null;
    let ended = false;
    let gone = false;
    let tries = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let sizing: ReturnType<typeof setTimeout> | null = null;
    const note = (text: string) => term.write(`\r\n\x1b[2m${text}\x1b[0m`);
    const end = (code: number | null, text: string) => {
      if (ended) return;
      ended = true;
      endTerm(tab.id, code);
      exitRef.current?.(code);
      note(text);
    };
    const send = (data: string | Uint8Array<ArrayBuffer>) => {
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
    // said once per spell away, when the shell's machine is what went
    let saidAway = false;
    // only for a machine known to be away, not one still being reached
    const sayAway = () => {
      const s = useStore.getState();
      const state = connOf(s, backendOf(tab.id)).status.state;
      if (!saidAway && multi(s) && (state === "offline" || state === "signin")) {
        saidAway = true;
        note("[backend offline]");
      }
    };
    const connect = () => {
      if (gone || ended) return;
      // a tab's shell and its repo must be the same backend's; a mismatch
      // (a stale tab, a bug elsewhere) must never open a socket that sends
      // one backend's plain id to another's shell, so this shows as gone
      // rather than guess which backend was meant
      if (backendOf(tab.repoId) !== backendOf(tab.id)) {
        end(null, "[this tab names another backend's repo; not opening its shell]");
        return;
      }
      // a machine the page has no URL for yet is waited on, not dialled
      // at the page's own origin; the waits are not tries, so the first
      // real dial and its notes go as they would have
      if (!reachable(backendOf(tab.id))) {
        sayAway();
        retry = setTimeout(connect, UNREACHABLE_WAIT);
        return;
      }
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
        saidAway = false;
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
        sayAway();
        if (tries === 0) note(opened ? "[the connection dropped; rejoining]" : "[could not reach the canopy server; retrying]");
        retry = setTimeout(connect, rejoinWait(tries));
        tries += 1;
      };
    };
    connect();

    // what the key bar sends goes the same way as a typed key
    sendRef.current = (data) => send(enc.encode(data));
    // The clipboard. A program copies through OSC 52 (Claude Code copies its
    // own mouse selection so), which xterm drops unless told where it goes.
    // ⌘C, or Ctrl+Shift+C off a Mac, copies xterm's own selection. A copy
    // the browser refused (the page without focus, or the gesture's moment
    // gone) waits for the next ⌘C with nothing selected. ⌘V needs nothing
    // here: the browser's paste event reaches xterm without any permission.
    let unsent: string | null = null;
    const toClipboard = (text: string) => {
      copyText(text).then(
        () => {
          unsent = null;
        },
        () => {
          unsent = text;
        },
      );
    };
    const apple = ["mac", "ios"].includes(myPlatform());
    term.attachCustomKeyEventHandler((e) => {
      const cut = shortcutOf(e, apple);
      if (!cut) return true;
      e.preventDefault();
      if (cut.kind === "send") term.input(cut.bytes);
      else {
        const text = term.hasSelection() ? term.getSelection() : unsent;
        if (text) toClipboard(text);
      }
      return false;
    });
    const subs = [
      term.parser.registerOscHandler(52, (body) => {
        const text = osc52Text(body);
        if (text !== null) {
          // every window on this shell hears it; only the one in use copies
          if (document.hasFocus()) toClipboard(text);
          else unsent = text;
        }
        return true;
      }),
      term.onData((data) => {
        const m = modsRef.current;
        if (m.ctrl || m.alt) {
          setModsRef.current(NO_MODS);
          send(enc.encode(withMods(data, m)));
        } else send(enc.encode(data));
      }),
      // mouse reports and the like arrive as raw bytes in a string
      term.onBinary((data) => send(Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 0xff))),
      // A drag sizes the xterm every frame; the pty hears only where it
      // settled, so a full-screen program is not made to repaint at every
      // size in between.
      term.onResize(({ cols, rows }) => {
        if (sizing) clearTimeout(sizing);
        sizing = setTimeout(() => {
          sizing = null;
          send(JSON.stringify({ resize: { cols, rows } }));
        }, RESIZE_SETTLE);
      }),
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
    // TAP_SLOP is left alone and arrives at xterm as a click, which focuses
    // it; the phone's keyboard stays down for that (softkeys.ts) and comes
    // up from the key bar's ⌨.
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
      if (el.offsetParent !== null) fitSoon();
    });
    ro.observe(el);
    return () => {
      gone = true;
      if (retry) clearTimeout(retry);
      if (sizing) clearTimeout(sizing);
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
      if (LIVE.get(tab.id) === term) LIVE.delete(tab.id);
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

  // A pinch in any shell sizes every shell in the same spot, and moving the
  // shell to another spot takes that one's size; one hidden now refits when
  // shown, since showing it changes its box.
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    if (host.current?.offsetParent) fitRef.current?.fit();
  }, [fontSize]);

  // The theme, palette and contrast settings and the OS scheme all repaint
  // the terminal.
  useEffect(() => {
    const paint = () => {
      const term = termRef.current;
      if (term) term.options.theme = xtermTheme();
    };
    paint();
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", paint);
    return () => mq.removeEventListener("change", paint);
  }, [theme, palette, moreContrast]);

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
          onKeyboard={() => showKeyboard(termRef.current?.textarea)}
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
/** the least a panel's scrolling part keeps under a tall shell; styles.css
 *  gives `.panel-body` the same floor */
const PANEL_BODY_MIN = 120;

export function TermGrip({
  box,
  cssVar,
  label,
  height,
  setHeight,
  bounds,
  edge = "top",
  fit,
}: {
  box: React.RefObject<HTMLElement | null>;
  cssVar: string;
  label: string;
  height: number;
  setHeight: (px: number) => void;
  bounds: { min: number; max: number; initial: number };
  /** which edge the grip sits on: "top" grows upward, "bottom" downward */
  edge?: "top" | "bottom";
  /** the most the box can take right now, read as a drag starts; below
   *  `bounds.max` when the room around it is what limits it, so the drag
   *  never runs into height nobody can see */
  fit?: () => number;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ y: number; h: number; top: number } | null>(null);

  const ceiling = () => {
    const room = fit?.();
    return room !== undefined && Number.isFinite(room) ? clamp(room, bounds.min, bounds.max) : bounds.max;
  };
  const apply = (h: number) => box.current?.style.setProperty(cssVar, `${h}px`);
  // a top grip grows as the pointer rises, a bottom grip as it falls
  const sized = (e: PointerEvent<HTMLDivElement>) => {
    const dy = start.current ? e.clientY - start.current.y : 0;
    return clamp((start.current?.h ?? height) + (edge === "top" ? -dy : dy), bounds.min, start.current?.top ?? bounds.max);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const top = ceiling();
    start.current = { y: e.clientY, h: Math.min(height, top), top };
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
    const top = ceiling();
    if (e.key === "ArrowUp") setHeight(clamp(Math.min(height, top) + step, bounds.min, top));
    else if (e.key === "ArrowDown") setHeight(clamp(Math.min(height, top) - step, bounds.min, top));
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

/** what a panel shell may grow to: its height now plus whatever the
 *  panel's scrolling part has above its floor (`PANEL_BODY_MIN`, styles.css),
 *  which is where the room comes from */
function shellRoom(shells: HTMLElement | null): number {
  const term = shells?.querySelector(":scope > .panel-shells-body > .term-body");
  const body = shells?.parentElement?.querySelector(":scope > .panel-body");
  if (!(term instanceof HTMLElement) || !(body instanceof HTMLElement)) return Infinity;
  return term.offsetHeight + Math.max(0, body.offsetHeight - PANEL_BODY_MIN);
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
      {(() => {
        const showing = terms.find((t) => t.id === active);
        return showing && showing.task === undefined && !showing.ranger && showing.exit === undefined ? <AgentButtons tab={showing} /> : null;
      })()}
      {extra}
      {end}
    </div>
  );
}

/** the textarea of the shell showing in `box`, once the layout has settled */
const refocus = (box: Element | null) =>
  requestAnimationFrame(() => box?.querySelector<HTMLElement>(".term-view:not([hidden]) textarea")?.focus());

/** The tab row's switches at its right end: bring to front, and maximize.
 *  Either again gives the place back; either way focus returns to the shell
 *  showing so typing carries on where it was. */
function ModeButtons({
  mode,
  setMode,
  what,
  bench = false,
}: {
  mode: SurfaceMode;
  setMode: (m: SurfaceMode) => void;
  what: string;
  /** inside a project's bench: one switch, the shells taking the whole
   *  bench or giving it back, and no maximize */
  bench?: boolean;
}) {
  const flip = (m: SurfaceMode) => (e: MouseEvent<HTMLButtonElement>) => {
    setMode(flipMode(mode, m));
    refocus(e.currentTarget.closest("section"));
  };
  const focus = mode === "focus";
  const full = mode === "full";
  return (
    <>
      <button
        type="button"
        className={`term-new term-focus${focus ? " on" : ""}`}
        title={
          bench
            ? focus ? "Give the bench back" : "The shells take the bench"
            : what === "panel"
              ? focus ? "Put the project back" : "Bring the project to the front"
              : focus ? "Put the shell back" : "Bring the shell to the front"
        }
        aria-label={
          bench
            ? focus ? "Give the bench back" : "The shells take the bench"
            : what === "panel" ? (focus ? "Put the project back" : "Bring the project to the front") : focus ? "Leave focus mode" : "Focus the shell"
        }
        aria-pressed={focus}
        onClick={flip("focus")}
      >
        ⧉
      </button>
      {!bench && <button
        type="button"
        className={`term-new term-full${full ? " on" : ""}`}
        title={full ? `Give the ${what} back` : `Shells take the whole ${what}`}
        aria-label={full ? "Restore shell size" : "Maximize shell"}
        aria-pressed={full}
        onClick={flip("full")}
      >
        {full ? "⤡" : "⤢"}
      </button>}
    </>
  );
}

/** How the strip's shells sit: in place or filling the window is the
 *  strip's own, while in front is the store's, since one thing at a time
 *  has the front and a project's bench can take it. */
function useStripMode(): [SurfaceMode, (m: SurfaceMode) => void] {
  const front = useStore((s) => s.front?.kind === "strip");
  const setFront = useStore((s) => s.setFront);
  const [placed, setPlaced] = useState<"normal" | "full">("normal");
  const setMode = (m: SurfaceMode) => {
    if (m === "focus") {
      setFront({ kind: "strip" });
      return;
    }
    if (front) setFront(null);
    setPlaced(m);
  };
  return [front ? "focus" : placed, setMode];
}

/** How a panel's shells sit: filling the panel is theirs, while in front is
 *  the project's bench, which they are one pane of. `mode` is what their
 *  buttons show (in the bench, focus while they fill it), `placed` how the
 *  box itself lays out, which inside the bench is in place, and `bench`
 *  whether the bench is up. */
function usePanelShellMode(repoId: string): {
  mode: SurfaceMode;
  placed: SurfaceMode;
  setMode: (m: SurfaceMode) => void;
  bench: boolean;
} {
  const bench = useStore((s) => benchIs(s.front, repoId));
  const soloed = useStore((s) => benchSolo(s.front, repoId) === "shell");
  const bringProject = useStore((s) => s.bringProject);
  const soloBench = useStore((s) => s.soloBench);
  const [placed, setPlaced] = useState<"normal" | "full">("normal");
  const setMode = (m: SurfaceMode) => {
    if (bench) soloBench(repoId, m === "normal" ? null : "shell");
    else if (m === "focus") bringProject(repoId);
    else setPlaced(m);
  };
  return { mode: bench ? (soloed ? "focus" : "normal") : placed, placed: bench ? "normal" : placed, setMode, bench };
}

/** The running shells outside a set brought to the front, other repos' and
 *  other devices' included: a click brings that one to the front instead,
 *  in its own strip or panel, where its tab lives. */
function FrontOthers({ set }: { set: string }) {
  const terms = useStore((s) => s.terms);
  const shells = useStore((s) => s.shells);
  const repos = useStore((s) => s.repos);
  const bringTerm = useStore((s) => s.bringTerm);
  // the machine already rides in `word`'s " · b" suffix below, so the
  // id fallback here is the plain id alone, never idText's own "on b"
  const others = otherShells(set, terms, shells, repos, (id) => idLabel(id).backend ?? "", (id) => idLabel(id).plain);
  if (others.length === 0) return null;
  return (
    <nav className="term-others" aria-label="Other running shells">
      <span className="term-caption">also running</span>
      {others.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`term-other${o.tabbed ? "" : " away"}`}
          title={
            o.tabbed
              ? `Bring the shell at ${o.label} to the front`
              : `Join the shell at ${o.label}${o.viewers.length ? `, open on ${o.viewers.join(", ")}` : ""}`
          }
          onClick={() => {
            bringTerm(o.id);
            // the set it lives in mounts or rises on the next frames
            requestAnimationFrame(() => refocus(document.querySelector(".termdock.focus, .panel-shells.focus")));
          }}
        >
          <span className={`dot ${o.tabbed ? "moss" : "faint"}`} aria-hidden="true" />
          {o.label}
        </button>
      ))}
    </nav>
  );
}

/** the gear's words for where a set's shells show */
const spotWord = (spot: ShellSpot, what: string): string =>
  spot === "full" ? `filling the ${what}` : SPOT_WORD[spot];

const SHELL_WORD: Record<ShellTarget, string> = {
  auto: "the panel when open, else the strip",
  panel: "the panel",
  strip: "the strip",
  tab: "a new tab",
  window: "a new window",
};

/** A set of shells' gear: the text size every shell shares where this set
 *  shows now (in place, filling, in front, or a window of its own), how the set
 *  sits, where new shells land, the showing shell in a window of its own,
 *  and its text copied, captured or pasted into. */
function ShellGear({
  label,
  what,
  mode,
  setMode,
  showing,
  box,
  bench = false,
}: {
  label: string;
  what: string;
  mode: SurfaceMode;
  setMode: (m: SurfaceMode) => void;
  showing: TermTab | null;
  box: React.RefObject<HTMLElement | null>;
  /** a pane of a project's bench, whose layout is beside the rest or
   *  filling the bench */
  bench?: boolean;
}) {
  const spot = useContext(ShellSpotHere);
  const zoom = useShellZoom(spot);
  const place = useStore((s) => s.settings.shell);
  const setSetting = useStore((s) => s.setSetting);
  const landing: GearEntry[] = SHELL_TARGETS.map((t) => ({
    type: "item",
    label: SHELL_WORD[t],
    on: place === t,
    run: () => setSetting("shell", t),
  }));
  const pop: GearEntry[] = showing && !showing.task && !showing.ranger
    ? [
        { type: "item", label: "this shell in a new tab", run: () => popShell(showing.repoId, showing.id, "tab") },
        { type: "item", label: "this shell in a new window", run: () => popShell(showing.repoId, showing.id, "window") },
      ]
    : [];
  return (
    <Gear
      label={label}
      groups={[
        { label: `shells · ${spotWord(spot, what)}`, entries: [zoom] },
        { label: "layout", entries: [...(bench ? benchEntries(mode, setMode) : modeEntries(mode, setMode, what)), ...pop] },
        { label: "new shells open in", entries: landing },
        {
          label: "share",
          entries: showing
            ? shareEntries({
                el: () => box.current?.querySelector<HTMLElement>(".term-view:not([hidden])") ?? null,
                label: `shell ${showing.name}`,
                copy: () => shellCopy(showing.id),
                paste: (text) => LIVE.get(showing.id)?.paste(text),
              })
            : [],
        },
      ]}
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
  const setTermHeight = useStore((s) => s.setTermHeight);
  const showTerm = useStore((s) => s.showTerm);
  const focusSize = useStore((s) => s.focusSize);
  const dock = useRef<HTMLElement>(null);
  const [mode, setMode] = useStripMode();
  const spot = shellSpot(mode, false);
  const strip = terms.filter((t) => t.place === "strip");
  useLeaveOnEscape(mode, setMode);

  if (strip.length === 0) return null;
  const leave = () => {
    setMode("normal");
    refocus(dock.current);
  };
  return (
    <ShellSpotHere.Provider value={spot}>
      {mode === "focus" && <FocusBackdrop onLeave={leave} />}
      <section
        ref={dock}
        className={`termdock${mode === "normal" ? "" : ` ${mode}`}`}
        aria-label="Shells"
        style={{ "--term-h": `${termHeight}px`, ...focusVars(focusSize) } as CSSProperties}
      >
        {mode === "normal" && (
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
          end={
            <>
              <ModeButtons mode={mode} setMode={setMode} what="window" />
              <ShellGear
                label="the shells strip"
                what="window"
                mode={mode}
                setMode={setMode}
                showing={strip.find((t) => t.id === activeTerm) ?? null}
                box={dock}
              />
            </>
          }
        />
        {mode === "focus" && <FrontOthers set="strip" />}
        <div className="term-body">
          {strip.map((t) => (
            <TermView key={viewKey(t)} tab={t} active={t.id === activeTerm} />
          ))}
        </div>
        {mode === "focus" && <FocusGrips box={dock} />}
      </section>
    </ShellSpotHere.Provider>
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
  // the bench holds the shells open without touching the fold
  const closed = useSectionClosed(repo.id, "shell");
  const toggleSection = useStore((s) => s.toggleSection);
  const panelTermHeight = useStore((s) => panelTermHeightFor(s, repo.id));
  const setPanelTermHeight = useStore((s) => s.setPanelTermHeight);
  const box = useRef<HTMLElement>(null);
  const { mode: chosenMode, placed: chosenPlace, setMode, bench } = usePanelShellMode(repo.id);
  const frontPick = useStore((s) => (s.front?.kind === "project" && s.front.repoId === repo.id ? s.front.pick : null));
  const mine = terms.filter((t) => t.place === "panel" && t.repoId === repo.id);
  const [chosen, setChosen] = useState<string | null>(null);
  // the newest shell shows until another tab is picked
  const latest = mine[mine.length - 1]?.id ?? null;
  const [seenLatest, setSeenLatest] = useState(latest);
  if (latest !== seenLatest) {
    setSeenLatest(latest);
    setChosen(latest);
  }
  // a shell brought here from another set's list shows, once
  const [seenPick, setSeenPick] = useState(frontPick);
  if (frontPick !== seenPick) {
    setSeenPick(frontPick);
    if (mine.some((t) => t.id === frontPick)) setChosen(frontPick);
  }
  const active = mine.some((t) => t.id === chosen) ? chosen : latest;
  // folded, the shells are neither maximized nor in front; in the bench
  // their box lays out in place, as one of its panes
  const mode: SurfaceMode = closed ? "normal" : chosenPlace;
  // a pane of the bench is about the size of the shells in place, so it
  // takes their text size, not the one for a box filling the window
  const spot = shellSpot(mode, dockless());
  useLeaveOnEscape(mode, setMode);

  if (mine.length === 0)
    return bench ? (
      <section className="panel-shells bench-empty" aria-label={`Shells at ${repo.name}`}>
        <p className="panel-clean">
          No shell here yet.{" "}
          <button type="button" className="mini" onClick={() => openTerm(repo.id, "panel")}>
            open a shell
          </button>
        </p>
      </section>
    ) : null;
  return (
    <ShellSpotHere.Provider value={spot}>
      <section
        ref={box}
        className={`panel-shells${mode === "normal" ? "" : ` ${mode}`}`}
        aria-label={`Shells at ${repo.name}`}
        style={{ "--panel-term-h": `${panelTermHeight}px` } as CSSProperties}
      >
        {mode === "normal" && !closed && !bench && (
          <TermGrip
            box={box}
            cssVar="--panel-term-h"
            label={`Shell height at ${repo.name}`}
            height={panelTermHeight}
            setHeight={(px) => setPanelTermHeight(repo.id, px)}
            bounds={PANEL_TERM}
            fit={() => shellRoom(box.current)}
          />
        )}
        <button
          type="button"
          className={`panel-label fold${closed ? "" : " open"}`}
          aria-expanded={!closed}
          disabled={bench}
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
            extra={<NewShellButton repoId={repo.id} />}
            end={
              <>
                <ModeButtons mode={closed ? "normal" : chosenMode} setMode={setMode} what="panel" bench={bench} />
                <ShellGear
                  label={`shells at ${repo.name}`}
                  what="panel"
                  mode={closed ? "normal" : chosenMode}
                  setMode={setMode}
                  showing={mine.find((t) => t.id === active) ?? null}
                  box={box}
                  bench={bench}
                />
              </>
            }
          />
          <div className="term-body">
            {mine.map((t) => (
              <TermView key={viewKey(t)} tab={t} active={t.id === active && !closed} />
            ))}
          </div>
        </div>
        {mode === "focus" && <FocusGrips box={box} />}
      </section>
    </ShellSpotHere.Provider>
  );
}

/** The tab a shell window shows for its repo: the shell the url names, else
 *  a new one on the repo's own backend. None for a forge repo. */
function shellTab(repo: Repo | undefined): TermTab | null {
  if (!repo || repo.forge) return null;
  const route = parseRoute(window.location.search);
  return {
    id: route.term ?? qual(backendOf(repo.id), termId()),
    repoId: repo.id,
    name: repo.name,
    path: repo.path,
    place: "strip",
    ...(route.task ? { task: route.task } : {}),
  };
}

/** One shell, edge to edge: what a "new tab" or "new window" shell shows. */
export function ShellSolo({ id }: { id: string }) {
  const root = useStore((s) => s.root);
  const repo = useStore((s) => s.repos.find((r) => r.id === id));
  const name = repo?.name;
  const waiting = useWaitingFor(id, repo !== undefined);
  // The shell's name goes into the url, so a reload of this window comes
  // back to the same shell rather than opening another. Another machine's
  // repo may arrive after the page has loaded, so the tab is made when the
  // repo is first there, and never again.
  const [tab, setTab] = useState<TermTab | null>(() => shellTab(repo));
  useEffect(() => {
    if (!tab && repo) setTab(shellTab(repo));
  }, [tab, repo]);
  const [exited, setExited] = useState(false);
  const zoom = useShellZoom("window");
  const body = useRef<HTMLDivElement>(null);

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
        <span className="solo-id">
          <IdLabel id={id} />
        </span>
        {exited && <span className="shell-exited">exited</span>}
        <span className="spacer" />
        {tab && (
          <Gear
            label={`the shell at ${name ?? idText(id)}`}
            groups={[
              { label: `shells · ${SPOT_WORD.window}`, entries: [zoom] },
              {
                label: "share",
                entries: shareEntries({
                  el: () => body.current,
                  label: `shell ${name ?? idText(id)}`,
                  copy: () => shellCopy(tab.id),
                  paste: (text) => LIVE.get(tab.id)?.paste(text),
                }),
              },
            ]}
          />
        )}
        <a className="mini" href={groveUrl()} target="_blank">
          whole grove ↗
        </a>
      </header>
      {tab ? (
        <div className="term-body" ref={body}>
          <ShellSpotHere.Provider value="window">
            <TermView tab={tab} active onExit={() => setExited(true)} />
          </ShellSpotHere.Provider>
        </div>
      ) : waiting ? (
        <WaitingFor name={waiting} />
      ) : repo && !repo.forge ? null : (
        <p className="empty">
          No repo called {idText(id)} under {root}, or none with a folder to open a shell in.{" "}
          <a href={groveUrl()}>Open the whole grove</a> instead.
        </p>
      )}
    </div>
  );
}

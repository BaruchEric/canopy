import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { dictatable, dictationText, DictatorDiscovery } from "../dictate";
import { LIVE } from "../liveTerms";
import { recorderBlocked, useRecorder } from "../recorder";
import { connOf, isOnline, useStore } from "../store";

type Field = HTMLInputElement | HTMLTextAreaElement;

const isField = (t: EventTarget | null): t is Field => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;

/** the shell a focused xterm belongs to, as its `.xterm` root: xterm takes
 *  keys through a hidden textarea, so its words go in as a paste */
const shellOf = (t: EventTarget | null): HTMLElement | null =>
  t instanceof HTMLTextAreaElement && t.classList.contains("xterm-helper-textarea") && !t.closest("[data-no-dictate]")
    ? t.closest<HTMLElement>(".xterm")
    : null;

/** where a mic's words would go for this focus: a shell, a text field, or nowhere */
const spotFor = (t: EventTarget | null): HTMLElement | null => shellOf(t) ?? (isField(t) && dictatable(t) ? t : null);

/** the top bar's mic, the same everywhere a mic shows */
export function MicIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

// Which backend turns a clip into text: home first, then each other online
// one, so a page on the Mac uses the mini's speech model when the Mac has
// none. Asked once per set of online backends and shared by every mic.
const discovery = new DictatorDiscovery();
const findDictator = (order: string[], connectionState: string): Promise<string | null> =>
  discovery.find(order, connectionState, async (backend) => (await api.voice(backend)).dictate);

/** the backend a mic sends its clip to, or null when none can take one */
function useDictator(): string | null {
  const order = useStore(useShallow((s) => [s.home, ...s.backendOrder.filter((b) => b !== s.home)].filter((b) => isOnline(s, b))));
  // Include every backend, even ones that are offline or secondary. A
  // disconnect/restart clears a cached negative answer even if the same set
  // of names is online again afterward.
  const connectionState = useStore((s) => [s.home, ...s.backendOrder.filter((b) => b !== s.home)].map((b) => `${b.length}:${b}:${connOf(s, b).status.state}`).join("|"));
  const [found, setFound] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void findDictator(order, connectionState).then((b) => live && setFound(b));
    return () => {
      live = false;
    };
  }, [order, connectionState]);
  return found;
}

/** Fields can be hidden by any ancestor. Opacity is checked too because the
 *  float must not keep a mic live beside a target that has faded away. */
function targetVisible(el: HTMLElement): boolean {
  if (document.visibilityState === "hidden") return false;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
  }
  return true;
}

function targetAvailable(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const onScreen = r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  return el.isConnected && targetVisible(el) && onScreen && r.width > 0 && r.height > 0;
}

/** Cancel any mic whose insertion target disappears, including inline
 *  composer mics and the floating mic. */
function useCancelWhenTargetLost(target: HTMLElement | null, cancel: () => void, onLost?: (target: HTMLElement) => void): void {
  useEffect(() => {
    if (!target) return;
    let live = true;
    const check = () => {
      if (!live || targetAvailable(target)) return;
      live = false;
      cancel();
      onLost?.(target);
    };
    const changes = new MutationObserver(check);
    if (document.body) changes.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "hidden"], childList: true, subtree: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    resize?.observe(target);
    window.addEventListener("resize", check);
    window.addEventListener("scroll", check, true);
    document.addEventListener("visibilitychange", check);
    document.addEventListener("transitionend", check, true);
    document.addEventListener("animationend", check, true);
    check();
    return () => {
      live = false;
      changes.disconnect();
      resize?.disconnect();
      window.removeEventListener("resize", check);
      window.removeEventListener("scroll", check, true);
      document.removeEventListener("visibilitychange", check);
      document.removeEventListener("transitionend", check, true);
      document.removeEventListener("animationend", check, true);
    };
  }, [cancel, onLost, target]);
}

/** Puts the words where they go: pasted into a shell, which leaves Enter to
 *  the user, or typed at a field's caret. False when the place is gone. */
function putDictation(el: HTMLElement, said: string): boolean {
  if (!targetAvailable(el)) return false;
  if (isField(el)) return insertDictation(el, said);
  const term = [...LIVE.values()].find((t) => t.element === el);
  if (!term) return false;
  term.paste(said.trim());
  term.focus();
  return true;
}

/** Puts the words in at the field's caret the way typing would, so React's
 *  onChange runs and undo takes them back. False when the field is gone. */
function insertDictation(el: Field, said: string): boolean {
  if (!el.isConnected) return false;
  // email and url inputs have no selection to read
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const text = dictationText(el.value.slice(0, start), said, el.value.slice(end));
  if (!text) return true;
  el.focus();
  try {
    el.setSelectionRange(start, end);
  } catch {
    // a type without a selection; the words go at the end
  }
  // execCommand is the one way in that keeps the browser's undo
  if (document.execCommand("insertText", false, text)) return true;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, el.value.slice(0, start) + text + el.value.slice(end));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

type Phase = "idle" | "starting" | "listening" | "writing";

/** One mic's recording: started for a field or a shell, stopped by a second
 *  press, the clip sent to the dictator and the words put there. */
function useDictation(dictator: string | null) {
  const target = useRef<HTMLElement | null>(null);
  const destination = useRef<string | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const [writing, setWriting] = useState<HTMLElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rec = useRecorder((clip) => {
    const el = target.current;
    const b = destination.current;
    const attempt = generation.current;
    if (!el || !b) return;
    setWriting(el);
    api.dictate(b, clip).then(
      ({ text }) => {
        if (attempt !== generation.current) return;
        target.current = null;
        destination.current = null;
        setWriting(null);
        if (!text.trim()) setErr("nothing heard");
        else if (targetAvailable(el)) {
          if (!putDictation(el, text)) setErr("the field went away before the words came back");
        } else setErr(null);
      },
      (e: unknown) => {
        if (attempt !== generation.current) return;
        target.current = null;
        destination.current = null;
        setWriting(null);
        setErr(e instanceof Error ? e.message : String(e));
      },
    );
  });
  const shown = rec.err ?? err;
  // an error is read, then goes
  useEffect(() => {
    if (!err) return;
    const t = setTimeout(() => setErr(null), 6000);
    return () => clearTimeout(t);
  }, [err]);
  const phase: Phase = writing ? "writing" : rec.recording ? "listening" : rec.pending ? "starting" : "idle";
  const press = (el: HTMLElement | null) => {
    if (rec.recording) return rec.stop();
    if (phase !== "idle" || !el || !dictator || !targetAvailable(el)) return;
    generation.current++;
    target.current = el;
    destination.current = dictator;
    setErr(null);
    void rec.start();
  };
  const cancel = useCallback(() => {
    generation.current++;
    target.current = null;
    destination.current = null;
    setWriting(null);
    rec.cancel();
  }, [rec.cancel]);
  // the field a recording or its words are for, which the mic stays beside
  const busyWith = phase === "idle" ? null : (writing ?? target.current);
  return { phase, err: shown, press, cancel, busyWith };
}

const PHASE_TITLE: Record<Phase, string> = {
  idle: "Dictate into this field",
  starting: "Opening the microphone…",
  listening: "Listening; press again to stop",
  writing: "Writing what you said…",
};

function MicButton({ phase, err, onPress }: { phase: Phase; err: string | null; onPress: () => void }) {
  const why = recorderBlocked();
  return (
    <>
      <button
        type="button"
        className="dictate-btn"
        data-phase={phase}
        title={why ?? PHASE_TITLE[phase]}
        aria-label={phase === "listening" ? "Stop dictating" : "Dictate"}
        aria-pressed={phase === "listening"}
        disabled={why !== null || phase === "writing" || phase === "starting"}
        // the field keeps focus, and with it the caret the words go to
        onPointerDown={(e) => e.preventDefault()}
        onClick={onPress}
      >
        <MicIcon size={13} />
      </button>
      {err && (
        <span className="dictate-err" role="alert">
          {err}
        </span>
      )}
    </>
  );
}

/** A mic beside a composer that keeps one in view; its field carries
 *  `data-mic` so the floating one leaves it alone. */
export function DictateButton({ target }: { target: RefObject<Field | null> }) {
  const dictator = useDictator();
  const d = useDictation(dictator);
  useCancelWhenTargetLost(d.busyWith, d.cancel);
  if (!dictator && d.phase === "idle") return null;
  return (
    <span className="dictate">
      <MicButton
        phase={d.phase}
        err={d.err}
        onPress={() => d.press(target.current)}
      />
    </span>
  );
}

/** The mic that follows focus: inside the right edge of whichever text field
 *  or shell has it, and beside the one a recording is for until its words
 *  land. Mounted once; see `dictatable` for the fields it skips. */
export function DictationFloat() {
  const dictator = useDictator();
  const d = useDictation(dictator);
  const [focused, setFocused] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  const clearLostTarget = useCallback((target: HTMLElement) => {
    setFocused((f) => (f === target ? null : f));
    setBox(null);
  }, []);
  useCancelWhenTargetLost(d.busyWith, d.cancel, clearLostTarget);

  useEffect(() => {
    const pick = (t: EventTarget | null) => setFocused(spotFor(t));
    const onIn = (e: FocusEvent) => pick(e.target);
    const onOut = (e: FocusEvent) => {
      if (isField(e.relatedTarget)) return;
      const left = spotFor(e.target);
      setFocused((f) => (f === left ? null : f));
    };
    pick(document.activeElement);
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);

  const field = d.busyWith ?? focused;
  // follows the field through scrolls, resizes and sheets sliding in
  useEffect(() => {
    if (!field || (!dictator && d.phase === "idle")) {
      setBox(null);
      return;
    }
    // read every frame while the field moves, then rest until something
    // could move it again, so a shell left focused for hours costs nothing
    let frame = 0;
    let still = 0;
    let last = "";
    const place = () => {
      frame = 0;
      const r = field.getBoundingClientRect();
      const next = !targetAvailable(field) ? null : spot(field, r);
      const key = next ? `${next.left},${next.top}` : "";
      if (key !== last) {
        last = key;
        still = 0;
        setBox(next);
      } else still++;
      if (still < 30) frame = requestAnimationFrame(place);
    };
    const wake = () => {
      still = 0;
      if (!frame) frame = requestAnimationFrame(place);
    };
    const MOVERS = ["scroll", "resize", "transitionstart", "animationstart", "transitionend", "animationend", "pointerup", "keyup"] as const;
    for (const m of MOVERS) window.addEventListener(m, wake, { capture: true, passive: true });
    place();
    return () => {
      cancelAnimationFrame(frame);
      for (const m of MOVERS) window.removeEventListener(m, wake, { capture: true });
    };
  }, [field, dictator, d.phase, d.cancel]);

  if ((!dictator && d.phase === "idle") || !field || !box) return null;
  // on the body, so no sheet's transform or overflow moves or clips it
  return createPortal(
    <span className="dictate dictate-float" style={{ left: box.left, top: box.top }}>
      <MicButton phase={d.phase} err={d.err} onPress={() => d.press(field)} />
    </span>,
    document.body,
  );
}

const MIC = 22;

/** inside the field's right edge: the bottom corner of a box of lines or a
 *  shell, the middle of a single line */
function spot(field: HTMLElement, r: DOMRect): { left: number; top: number } {
  const shell = !isField(field);
  const multi = shell || (field instanceof HTMLTextAreaElement && r.height > MIC * 2);
  // clear of a textarea's scrollbar, and of the one xterm draws over its right edge
  const bar = shell ? 14 : field instanceof HTMLTextAreaElement ? field.offsetWidth - field.clientWidth : 0;
  return {
    left: Math.round(r.right - MIC - 4 - bar),
    top: Math.round(multi ? r.bottom - MIC - 4 : r.top + (r.height - MIC) / 2),
  };
}

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { leadOf } from "../checkouts";
import { openView } from "../clirun";
import { backendOf } from "../registry";
import { allCards, homeConn, isOnline, useStore, type CanopyState } from "../store";
import type { VoicePhase, VoiceState } from "../voice";
import { VoiceCall } from "../voicecall";
import { MicIcon } from "./Dictate";

const PHASE_WORDS: Record<VoicePhase, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Call ended",
};

const micReason = (): string | null => {
  if (!window.isSecureContext) return "The microphone needs https or localhost";
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") return "This browser cannot stream the microphone";
  return null;
};

/** One checkout per repo, the one its card shows: with peer sync most repos
 *  sit on two backends, and the model must not count or name them twice. */
const oneEach = (s: CanopyState) => allCards(s).map((card) => leadOf(card, s.checkoutPref[card.key], (b) => isOnline(s, b), backendOf));

/** The mic in the top bar: talk to canopy through an Eleven Realtime model.
 *  Shown only when the home backend has a voice key. */
export function VoiceButton() {
  const [model, setModel] = useState<string | null>(null);
  const [state, setState] = useState<VoiceState | null>(null);
  const call = useRef<VoiceCall | null>(null);
  // asked again when the home backend comes back, so a restart does not hide the mic for good
  const homeUp = useStore((s) => homeConn(s).status.state === "online");

  useEffect(() => () => call.current?.stop(), []);
  useEffect(() => {
    if (!homeUp) return;
    let live = true;
    api.voice().then(
      (v) => live && setModel(v.model),
      () => live && setModel(null),
    );
    return () => {
      live = false;
    };
  }, [homeUp]);

  // a clean hang-up closes the panel on its own; an error stays to be read
  useEffect(() => {
    if (state?.phase !== "ended" || state.error) return;
    const t = setTimeout(() => setState((s) => (s?.phase === "ended" && !s.error ? null : s)), 1500);
    return () => clearTimeout(t);
  }, [state]);

  if (!model) return null;
  const why = micReason();
  const on = state !== null && state.phase !== "ended";

  const start = () => {
    if (call.current && state?.phase !== "ended") return;
    const c = new VoiceCall({
      onState: setState,
      world: () => {
        const s = useStore.getState();
        return { repos: oneEach(s), asks: Object.values(s.asks), runs: Object.values(s.runs), jobs: Object.values(s.jobs), now: Date.now() };
      },
      acts: {
        openRepo: (id) => {
          openView("git");
          useStore.getState().openPanel(id);
        },
        openView,
      },
    });
    call.current = c;
    setState({ phase: "connecting", lines: [], error: null });
    void c.start();
  };
  const hangUp = () => call.current?.stop();

  return (
    <>
      <button
        type="button"
        className={`icon-btn voice-btn${on ? " on" : ""}`}
        title={why ?? (on ? "Hang up" : `Talk to canopy (${model.replace(/^eleven_realtime_/, "").replace(/_/g, " ")})`)}
        aria-label={on ? "Hang up" : "Talk to canopy"}
        aria-pressed={on}
        disabled={why !== null && !on}
        onClick={on ? hangUp : start}
      >
        <MicIcon />
      </button>
      {state && <VoicePanel state={state} onHangUp={hangUp} onClose={() => setState(null)} />}
    </>
  );
}

function VoicePanel({ state, onHangUp, onClose }: { state: VoiceState; onHangUp: () => void; onClose: () => void }) {
  const list = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.lines]);
  const ended = state.phase === "ended";
  return (
    <section className="voice-panel" aria-label="Voice conversation" data-phase={state.phase}>
      <header>
        <span className="voice-dot" aria-hidden="true" />
        <span role="status">{PHASE_WORDS[state.phase]}</span>
        {ended ? (
          <button type="button" className="mini" onClick={onClose}>
            Close
          </button>
        ) : (
          <button type="button" className="mini" onClick={onHangUp}>
            Hang up
          </button>
        )}
      </header>
      {state.lines.length > 0 && (
        <ol ref={list}>
          {state.lines.map((l) => (
            <li key={`${l.who}:${l.id}`} className={`voice-${l.who}`}>
              {l.who === "tool" ? l.text : l.text || "…"}
            </li>
          ))}
        </ol>
      )}
      {state.lines.length === 0 && !ended && <p className="voice-hint">Ask what needs you, which repos have changes, or to open one.</p>}
      {state.error && (
        <p className="voice-error" role="alert">
          {state.error}
        </p>
      )}
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { leadOf } from "../checkouts";
import { openView } from "../clirun";
import { backendOf } from "../registry";
import { allCards, homeConn, isOnline, useStore, type CanopyState } from "../store";
import { LiveCall } from "../livecall";
import type { VoicePhase, VoiceState } from "../voice";
import { VoiceCall, type CallHooks } from "../voicecall";
import { keepEngine, pickEngine, type VoiceEngine } from "../voicelive";
import { MicIcon } from "./Dictate";

const PHASE_WORDS: Record<VoicePhase, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Call ended",
};

/** Eleven's call streams the mic through an AudioWorklet; GPT-Live's
 *  sends it as a WebRTC track */
const micReason = (engine: VoiceEngine): string | null => {
  if (!window.isSecureContext) return "The microphone needs https or localhost";
  const can = engine === "live" ? typeof RTCPeerConnection !== "undefined" : typeof AudioWorkletNode !== "undefined";
  if (!navigator.mediaDevices?.getUserMedia || !can) return "This browser cannot stream the microphone";
  return null;
};

/** One checkout per repo, the one its card shows: with peer sync most repos
 *  sit on two backends, and the model must not count or name them twice. */
const oneEach = (s: CanopyState) => allCards(s).map((card) => leadOf(card, s.checkoutPref[card.key], (b) => isOnline(s, b), backendOf));

const ENGINE_NAME: Record<VoiceEngine, string> = { eleven: "Eleven", live: "GPT-Live" };

/** the model as the mic's title says it */
const spoken = (model: string): string => model.replace(/^eleven_realtime_/, "").replace(/_/g, " ");

/** The mic in the top bar: talk to canopy through an Eleven Realtime model
 *  or GPT-Live, whichever the home backend has a key for; with both, the
 *  panel switches between them and this browser keeps the pick. */
export function VoiceButton() {
  const [models, setModels] = useState<Record<VoiceEngine, string | null>>({ eleven: null, live: null });
  const [engine, setEngine] = useState<VoiceEngine | null>(null);
  const [state, setState] = useState<VoiceState | null>(null);
  const call = useRef<VoiceCall | LiveCall | null>(null);
  // asked again when the home backend comes back, so a restart does not hide the mic for good
  const homeUp = useStore((s) => homeConn(s).status.state === "online");

  useEffect(() => () => call.current?.stop(), []);
  useEffect(() => {
    if (!homeUp) return;
    let live = true;
    api.voice().then(
      (v) => {
        if (!live) return;
        // an older backend sends no `live`
        const next = { eleven: v.model, live: v.live ?? null };
        setModels(next);
        setEngine(pickEngine({ eleven: next.eleven !== null, live: next.live !== null }));
      },
      () => {
        if (!live) return;
        setModels({ eleven: null, live: null });
        setEngine(null);
      },
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

  const model = engine ? models[engine] : null;
  if (!engine || !model) return null;
  const why = micReason(engine);
  const on = state !== null && state.phase !== "ended";
  const other: VoiceEngine | null = engine === "eleven" ? (models.live ? "live" : null) : models.eleven ? "eleven" : null;

  const start = (use: VoiceEngine = engine) => {
    // a call is going on while its panel shows a phase other than ended;
    // a closed panel means the last call is over
    if (call.current && state !== null && state.phase !== "ended") return;
    // a call switched away from keeps closing on its own, unheard
    let mine: VoiceCall | LiveCall | null = null;
    const hooks: CallHooks = {
      onState: (s) => {
        if (call.current === mine) setState(s);
      },
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
    };
    const c = use === "live" ? new LiveCall(hooks) : new VoiceCall(hooks);
    mine = c;
    call.current = c;
    setState({ phase: "connecting", lines: [], error: null });
    void c.start();
  };
  const hangUp = () => call.current?.stop();
  // a call going on is hung up and the other engine called at once
  const switchTo = (next: VoiceEngine) => {
    keepEngine(next);
    setEngine(next);
    if (!on) return;
    const c = call.current;
    call.current = null;
    c?.stop();
    start(next);
  };

  return (
    <>
      <button
        type="button"
        className={`icon-btn voice-btn${on ? " on" : ""}`}
        title={why ?? (on ? "Hang up" : `Talk to canopy (${spoken(model)})`)}
        aria-label={on ? "Hang up" : "Talk to canopy"}
        aria-pressed={on}
        disabled={why !== null && !on}
        onClick={on ? hangUp : () => start()}
      >
        <MicIcon />
      </button>
      {state && (
        <VoicePanel
          state={state}
          engine={ENGINE_NAME[engine]}
          other={other && { name: ENGINE_NAME[other], model: spoken(models[other] ?? ""), go: () => switchTo(other) }}
          onHangUp={hangUp}
          onClose={() => setState(null)}
        />
      )}
    </>
  );
}

interface OtherEngine {
  name: string;
  model: string;
  go: () => void;
}

function VoicePanel({ state, engine, other, onHangUp, onClose }: { state: VoiceState; engine: string; other: OtherEngine | null; onHangUp: () => void; onClose: () => void }) {
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
        <span role="status">
          {PHASE_WORDS[state.phase]}
          <span className="voice-engine"> · {engine}</span>
        </span>
        {other && (
          <button type="button" className="mini" title={`Talk through ${other.model} instead`} onClick={other.go}>
            {other.name}
          </button>
        )}
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

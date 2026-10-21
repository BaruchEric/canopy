/**
 * One spoken conversation through GPT-Live, the browser half. The mic and
 * the answer travel as WebRTC media tracks straight between the page and
 * OpenAI; the `oai-events` data channel carries transcripts and the
 * backend's function calls, which the page runs from what it holds and
 * answers. The home backend starts the session (POST /api/voice/live) by
 * taking this page's offer to OpenAI with its key, which never reaches the
 * page. The pure half is voicelive.ts.
 */
import { api } from "./api";
import { VOICE_START, runVoiceTool, type VoiceState } from "./voice";
import type { CallHooks } from "./voicecall";
import { liveReduce, parseLiveEvent, type LiveEvent } from "./voicelive";

/** no transcript for this long and whoever was talking has stopped */
const QUIET_MS = 1200;
/** a goodbye that never comes still hangs up */
const GOODBYE_MS = 8000;
/** how long `session.close` may take to come back as `session.closed` */
const CLOSE_MS = 5000;
const ICE_MS = 10_000;

export class LiveCall {
  private readonly audio: HTMLAudioElement;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private closing: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  /** end_conversation ran: close once the goodbye has been said */
  private hangAfter = false;
  private done = false;
  private state: VoiceState = VOICE_START;

  /** Build it inside the click: Safari lets a media element made in a user
   *  gesture play sound. */
  constructor(private readonly hooks: CallHooks) {
    this.audio = new Audio();
    this.audio.autoplay = true;
  }

  async start(): Promise<void> {
    try {
      const pc = new RTCPeerConnection();
      this.pc = pc;
      pc.ontrack = (e) => {
        this.audio.srcObject = new MediaStream([e.track]);
        this.audio.play().catch(() => this.end("the browser would not play GPT-Live's voice"));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") this.end("the connection to GPT-Live failed");
      };
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (this.done) return this.release();
      for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);
      // the channel is made before the offer, so the offer carries it
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (m: MessageEvent<unknown>) => {
        if (typeof m.data === "string") this.onEvent(m.data);
      };
      dc.onclose = () => this.end(this.hangAfter ? null : "GPT-Live closed the call");
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      const offer = pc.localDescription?.sdp;
      if (!offer) throw new Error("the browser made no offer");
      if (this.done) return this.release();
      const answer = await api.voiceLive(offer);
      if (this.done) return this.release();
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (e) {
      const why = e instanceof DOMException && e.name === "NotAllowedError" ? "the microphone is blocked for this page" : e instanceof Error ? e.message : String(e);
      this.end(why);
    }
  }

  /** Hang up: asked of the session first, so it can finish, then let go. */
  stop(): void {
    if (this.done) return;
    if (!this.started || this.dc?.readyState !== "open") return this.end(null);
    if (this.closing) return;
    this.hangAfter = true;
    this.send({ type: "session.close" });
    this.closing = setTimeout(() => this.end(null), CLOSE_MS);
  }

  private set(next: VoiceState): void {
    if (next === this.state) return;
    this.state = next;
    this.hooks.onState(next);
  }

  private send(event: unknown): void {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(event));
  }

  private onEvent(raw: string): void {
    const e = parseLiveEvent(raw);
    if (!e) return;
    this.apply(e);
    switch (e.type) {
      case "session.started":
        this.started = true;
        return;
      case "session.input_transcript.delta":
      case "session.output_transcript.delta":
        this.hush();
        return;
      case "session.closed":
        this.end(this.state.error);
        return;
      case "response.event": {
        if (!e.call) return;
        const out = runVoiceTool(e.call.name, e.call.arguments, this.hooks.world(), {
          ...this.hooks.acts,
          hangUp: () => {
            this.hangAfter = true;
            // the goodbye is spoken after this answer; if it never is, go anyway
            setTimeout(() => this.stop(), GOODBYE_MS);
          },
        });
        // one call per response (parallel_tool_calls off), so each answer
        // goes back and the backend goes on at once
        this.send({ type: "response.item.create", item: { type: "function_call_output", call_id: e.call.id, output: JSON.stringify(out) } });
        this.send({ type: "response.create" });
        return;
      }
    }
  }

  private apply(e: LiveEvent): void {
    this.set(liveReduce(this.state, e));
  }

  /** each transcript fragment puts off the quiet; after a goodbye, quiet hangs up */
  private hush(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => {
      this.quiet = null;
      this.apply({ type: "quiet" });
      if (this.hangAfter && this.state.phase === "listening") this.stop();
    }, QUIET_MS);
  }

  private release(): void {
    if (this.quiet) clearTimeout(this.quiet);
    if (this.closing) clearTimeout(this.closing);
    this.quiet = null;
    this.closing = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    const dc = this.dc;
    this.dc = null;
    if (dc) {
      dc.onmessage = null;
      dc.onclose = null;
      dc.close();
    }
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    this.audio.pause();
    this.audio.srcObject = null;
  }

  private end(error: string | null): void {
    if (this.done) return;
    this.done = true;
    this.release();
    this.set({ ...this.state, phase: "ended", error: error ?? this.state.error });
  }
}

/** the offer goes once it holds every candidate, since nothing trickles after it */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", check);
      reject(new Error("the browser took too long to find a network path"));
    }, ICE_MS);
    function check() {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    pc.addEventListener("icegatheringstatechange", check);
  });
}

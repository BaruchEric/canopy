/**
 * One spoken conversation, the browser half: the mic through an
 * AudioWorklet, resampled to 24 kHz PCM and streamed up the socket; the
 * answer's PCM queued on the speaker; each tool call answered from the page
 * and sent back. The backend mints the secret (POST /api/voice/session); the
 * key never reaches the page. The pure half is voice.ts.
 */
import { VOICE_RATE } from "../../src/core/voicewire";
import { api } from "./api";
import {
  Resampler,
  VOICE_START,
  fromBase64,
  fromPcm16,
  parseVoiceEvent,
  runVoiceTool,
  toBase64,
  toPcm16,
  voiceReduce,
  type VoiceActs,
  type VoiceState,
  type VoiceWorld,
} from "./voice";

/** the worklet only copies each 128-sample block out to the page */
const TAP = `class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("canopy-voice-tap", Tap);`;

/** how much mic audio goes up per append: 100 ms */
const SEND_SAMPLES = VOICE_RATE / 10;

export interface CallHooks {
  onState: (s: VoiceState) => void;
  world: () => VoiceWorld;
  acts: Omit<VoiceActs, "hangUp">;
}

export class VoiceCall {
  private readonly ctx: AudioContext;
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private tap: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private resampler: Resampler | null = null;
  private pending: Float32Array[] = [];
  private pendingLen = 0;
  private playing = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  /** a tool answered during this response, so it needs a reply */
  private answered = false;
  private hangAfter = false;
  private done = false;
  private state: VoiceState = VOICE_START;

  /** Build it inside the click: Safari only lets an AudioContext made in a
   *  user gesture play sound. */
  constructor(private readonly hooks: CallHooks) {
    this.ctx = new AudioContext();
    void this.ctx.resume();
  }

  async start(): Promise<void> {
    try {
      const session = await api.voiceSession();
      if (this.done) return;
      this.stream = await navigator.mediaDevices.getUserMedia({
        // without echo cancellation the laptop's speaker reaches the mic and
        // the model hears itself talking, then stops to listen
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (this.done) return this.release();
      const url = URL.createObjectURL(new Blob([TAP], { type: "text/javascript" }));
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (this.done) return this.release();
      // the context runs at the device's rate (a 24 kHz context refuses a
      // 48 kHz mic in Firefox), and the page resamples
      this.resampler = new Resampler(this.ctx.sampleRate, VOICE_RATE);
      const ws = new WebSocket(session.socket, ["realtime", `openai-insecure-api-key.${session.secret}`]);
      this.ws = ws;
      ws.onmessage = (m) => this.onEvent(m.data);
      ws.onclose = (e) => this.end(e.code === 1000 || this.hangAfter ? null : `the voice service closed the call${e.reason ? `: ${e.reason}` : ""}`);
      ws.onerror = () => this.end("the voice service did not answer");
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.tap = new AudioWorkletNode(this.ctx, "canopy-voice-tap");
      this.tap.port.onmessage = (m: MessageEvent<Float32Array>) => this.onMic(m.data);
      // a node the graph does not pull may never run; a silent gain keeps it pulled
      this.sink = this.ctx.createGain();
      this.sink.gain.value = 0;
      source.connect(this.tap).connect(this.sink).connect(this.ctx.destination);
    } catch (e) {
      const why = e instanceof DOMException && e.name === "NotAllowedError" ? "the microphone is blocked for this page" : e instanceof Error ? e.message : String(e);
      this.end(why);
    }
  }

  /** hang up now */
  stop(): void {
    this.end(null);
  }

  private set(next: VoiceState): void {
    if (next === this.state) return;
    this.state = next;
    this.hooks.onState(next);
  }

  private send(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  private onMic(block: Float32Array): void {
    if (!this.resampler || this.ws?.readyState !== WebSocket.OPEN) return;
    const out = this.resampler.push(block);
    this.pending.push(out);
    this.pendingLen += out.length;
    if (this.pendingLen < SEND_SAMPLES) return;
    const joined = new Float32Array(this.pendingLen);
    let at = 0;
    for (const p of this.pending) {
      joined.set(p, at);
      at += p.length;
    }
    this.pending = [];
    this.pendingLen = 0;
    this.send({ type: "input_audio_buffer.append", audio: toBase64(toPcm16(joined)) });
  }

  private onEvent(data: unknown): void {
    const e = typeof data === "string" ? parseVoiceEvent(data) : null;
    if (!e) return;
    this.set(voiceReduce(this.state, e));
    switch (e.type) {
      case "response.output_audio.delta":
        if (e.delta) this.play(fromPcm16(fromBase64(e.delta)));
        return;
      case "input_audio_buffer.speech_started":
        // the server cancels its answer, but what is already queued here keeps playing
        this.flush();
        return;
      case "response.function_call_arguments.done": {
        const out = runVoiceTool(e.name ?? "", e.arguments ?? "", this.hooks.world(), { ...this.hooks.acts, hangUp: () => (this.hangAfter = true) });
        this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: e.call_id, output: JSON.stringify(out) } });
        this.answered = true;
        return;
      }
      case "response.done":
        if (this.hangAfter) {
          // let the goodbye finish playing
          const left = Math.max(0, this.nextAt - this.ctx.currentTime);
          setTimeout(() => this.end(null), left * 1000 + 250);
        } else if (this.answered) this.send({ type: "response.create" });
        this.answered = false;
        return;
    }
  }

  private play(samples: Float32Array): void {
    if (!samples.length || this.done) return;
    const buf = this.ctx.createBuffer(1, samples.length, VOICE_RATE);
    buf.copyToChannel(new Float32Array(samples), 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const at = Math.max(this.nextAt, this.ctx.currentTime + 0.05);
    src.start(at);
    this.nextAt = at + buf.duration;
    this.playing.add(src);
    src.onended = () => this.playing.delete(src);
  }

  private flush(): void {
    for (const src of this.playing) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.playing.clear();
    this.nextAt = 0;
  }

  private release(): void {
    this.flush();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.tap?.port.close();
    this.tap?.disconnect();
    this.sink?.disconnect();
    this.tap = null;
    this.sink = null;
    if (this.ctx.state !== "closed") void this.ctx.close();
  }

  private end(error: string | null): void {
    if (this.done) return;
    this.done = true;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
    }
    this.release();
    this.set({ ...this.state, phase: "ended", error: error ?? this.state.error });
  }
}

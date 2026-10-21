import { describe, expect, test } from "bun:test";
import { VOICE_START } from "./voice";
import { ENGINE_STORE, keepEngine, liveReduce, parseLiveEvent, pickEngine, type LiveEvent } from "./voicelive";

/** a localStorage stand-in, or one that throws the way a blocked one does */
const store = (start: string | null = null, blocked = false) => {
  let v = start;
  return {
    getItem: (k: string) => {
      if (blocked) throw new Error("blocked");
      return k === ENGINE_STORE ? v : null;
    },
    setItem: (k: string, next: string) => {
      if (blocked) throw new Error("blocked");
      if (k === ENGINE_STORE) v = next;
    },
    get value() {
      return v;
    },
  };
};

describe("parseLiveEvent", () => {
  test("keeps the fields read here and lifts a finished function call out of its envelope", () => {
    expect(parseLiveEvent(JSON.stringify({ type: "session.input_transcript.delta", event_id: "e", delta: "What is", start_ms: 1000, end_ms: 1200 }))).toEqual({
      type: "session.input_transcript.delta",
      delta: "What is",
      startMs: 1000,
    });
    const call = {
      type: "response.event",
      delegation_id: "item_1",
      event: { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "list_repos", arguments: '{"only":"changed"}' } },
    };
    expect(parseLiveEvent(JSON.stringify(call))).toEqual({ type: "response.event", call: { id: "call_1", name: "list_repos", arguments: '{"only":"changed"}' } });
    expect(parseLiveEvent(JSON.stringify({ type: "error", error: { message: "nope", code: null } }))).toEqual({ type: "error", message: "nope" });
    expect(parseLiveEvent(JSON.stringify({ type: "session.closed", reason: "expired" }))).toEqual({ type: "session.closed", reason: "expired" });
  });
  test("a message item, a text delta inside an envelope, or junk is no call", () => {
    const msg = { type: "response.event", event: { type: "response.output_item.done", item: { type: "message", id: "m" } } };
    expect(parseLiveEvent(JSON.stringify(msg))?.call).toBeUndefined();
    expect(parseLiveEvent(JSON.stringify({ type: "response.event", event: { type: "response.output_text.delta", delta: "x" } }))?.call).toBeUndefined();
    expect(parseLiveEvent("not json")).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ kind: "x" }))).toBeNull();
  });
});

describe("liveReduce", () => {
  const run = (events: LiveEvent[]) => events.reduce(liveReduce, VOICE_START);
  test("fragments join while one side talks, and a turn starts when the other does", () => {
    const v = run([
      { type: "session.started" },
      { type: "session.input_transcript.delta", delta: " Which repos", startMs: 1000 },
      { type: "session.input_transcript.delta", delta: " changed?", startMs: 1400 },
      { type: "session.delegation.created" },
      { type: "response.event", call: { id: "call_1", name: "list_repos", arguments: "{}" } },
      { type: "session.output_transcript.delta", delta: "Two repos", startMs: 3000 },
      { type: "session.output_transcript.delta", delta: " have changes.", startMs: 3300 },
    ]);
    expect(v.lines).toEqual([
      { id: "you:1000", who: "you", text: "Which repos changed?" },
      { id: "call_1", who: "tool", text: "listed repos" },
      { id: "canopy:3000", who: "canopy", text: "Two repos have changes." },
    ]);
    expect(v.phase).toBe("speaking");
    expect(liveReduce(v, { type: "quiet" }).phase).toBe("listening");
  });
  test("a sentence a tool line cut goes on above it; a finished one is not continued", () => {
    const v = run([
      { type: "session.output_transcript.delta", delta: "Hang on, I'll check", startMs: 100 },
      { type: "response.event", call: { id: "call_1", name: "overview", arguments: "{}" } },
      { type: "session.output_transcript.delta", delta: " that.", startMs: 900 },
      { type: "response.event", call: { id: "call_2", name: "list_repos", arguments: "{}" } },
      { type: "session.output_transcript.delta", delta: " Just canopy.", startMs: 2000 },
    ]);
    expect(v.lines).toEqual([
      { id: "canopy:100", who: "canopy", text: "Hang on, I'll check that." },
      { id: "call_1", who: "tool", text: "looked over every repo" },
      { id: "call_2", who: "tool", text: "listed repos" },
      { id: "canopy:2000", who: "canopy", text: "Just canopy." },
    ]);
  });
  test("phases: started listens, the user heard, a delegation thinks, and quiet leaves thinking alone", () => {
    expect(run([{ type: "session.started" }]).phase).toBe("listening");
    expect(run([{ type: "session.input_transcript.delta", delta: "hi" }]).phase).toBe("hearing");
    const thinking = run([{ type: "session.delegation.created" }]);
    expect(thinking.phase).toBe("thinking");
    expect(liveReduce(thinking, { type: "quiet" })).toBe(thinking);
  });
  test("an error is kept and the call goes on; a close says why when it was not asked for", () => {
    const v = run([{ type: "session.started" }, { type: "error", message: "audio cut by moderation" }]);
    expect(v).toMatchObject({ phase: "listening", error: "audio cut by moderation" });
    expect(liveReduce(VOICE_START, { type: "session.closed", reason: "expired" })).toMatchObject({ phase: "ended", error: "the call reached GPT-Live's time limit" });
    expect(liveReduce(VOICE_START, { type: "session.closed", reason: "close_requested" })).toMatchObject({ phase: "ended", error: null });
    expect(liveReduce(v, { type: "session.usage.updated" })).toBe(v);
  });
});

describe("pickEngine", () => {
  test("the kept pick while the backend has it, else Eleven, else GPT-Live", () => {
    expect(pickEngine({ eleven: true, live: true }, store("live"))).toBe("live");
    expect(pickEngine({ eleven: true, live: false }, store("live"))).toBe("eleven");
    expect(pickEngine({ eleven: true, live: true }, store(null))).toBe("eleven");
    expect(pickEngine({ eleven: false, live: true }, store("eleven"))).toBe("live");
    expect(pickEngine({ eleven: false, live: false }, store("live"))).toBeNull();
  });
  test("blocked storage keeps the default and a pick does not throw", () => {
    const s = store("live", true);
    expect(pickEngine({ eleven: true, live: true }, s)).toBe("eleven");
    expect(() => keepEngine("live", s)).not.toThrow();
    const ok = store();
    keepEngine("live", ok);
    expect(ok.value).toBe("live");
  });
});

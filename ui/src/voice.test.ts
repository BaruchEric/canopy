import { describe, expect, test } from "bun:test";
import type { Ask, Job, Repo, Run } from "../../src/core/types";
import {
  Resampler,
  VOICE_START,
  distance,
  fromBase64,
  fromPcm16,
  matchRepos,
  parseVoiceEvent,
  runVoiceTool,
  toBase64,
  toPcm16,
  voiceReduce,
  type VoiceActs,
  type VoiceEvent,
  type VoiceWorld,
} from "./voice";

describe("audio", () => {
  test("a 48 kHz stream cut into blocks resamples to half as many samples, continuous across blocks", () => {
    const ramp = Float32Array.from({ length: 1024 }, (_, i) => i / 1024);
    const whole = new Resampler(48_000, 24_000).push(ramp);
    const r = new Resampler(48_000, 24_000);
    const parts: number[] = [];
    for (let i = 0; i < ramp.length; i += 128) parts.push(...r.push(ramp.subarray(i, i + 128)));
    expect(whole.length).toBe(512);
    expect(parts.length).toBe(512);
    parts.forEach((v, i) => expect(v).toBeCloseTo(whole[i] ?? NaN, 6));
  });
  test("44.1 kHz comes out at the right length over a second", () => {
    const r = new Resampler(44_100, 24_000);
    let n = 0;
    for (let i = 0; i < 44_100; i += 128) n += r.push(new Float32Array(Math.min(128, 44_100 - i))).length;
    expect(Math.abs(n - 24_000)).toBeLessThanOrEqual(1);
  });
  test("the same rate passes through", () => {
    expect([...new Resampler(24_000, 24_000).push(Float32Array.of(0.5, -0.5))]).toEqual([0.5, -0.5]);
  });
  test("PCM16 is little-endian, clamped, and reads back", () => {
    const bytes = toPcm16(Float32Array.of(0, 1, -1, 2));
    expect([...bytes]).toEqual([0, 0, 0xff, 0x7f, 0x00, 0x80, 0xff, 0x7f]);
    const back = fromPcm16(toPcm16(Float32Array.of(0.25, -0.5)));
    expect(back[0]).toBeCloseTo(0.25, 3);
    expect(back[1]).toBeCloseTo(-0.5, 3);
  });
  test("base64 round-trips a buffer longer than one slice", () => {
    const big = Uint8Array.from({ length: 200_000 }, (_, i) => i % 251);
    expect(fromBase64(toBase64(big))).toEqual(big);
  });
});

describe("parseVoiceEvent", () => {
  test("keeps the type and the string fields, drops the rest", () => {
    expect(parseVoiceEvent(JSON.stringify({ type: "response.output_audio.delta", item_id: "i1", delta: "AAA", output_index: 0 }))).toEqual({ type: "response.output_audio.delta", item_id: "i1", delta: "AAA" });
    expect(parseVoiceEvent(JSON.stringify({ type: "error", error: { message: "bad", code: 1 } }))).toEqual({ type: "error", error: { message: "bad" } });
    expect(parseVoiceEvent(JSON.stringify({ type: "x", delta: 5 }))).toEqual({ type: "x" });
  });
  test("null for what is not an event", () => {
    expect(parseVoiceEvent("nope")).toBeNull();
    expect(parseVoiceEvent("[]")).toBeNull();
    expect(parseVoiceEvent(JSON.stringify({ kind: "x" }))).toBeNull();
  });
});

describe("voiceReduce", () => {
  const run = (events: VoiceEvent[]) => events.reduce(voiceReduce, VOICE_START);
  test("what was said sits above the answer, though its transcript lands after the answer starts", () => {
    const v = run([
      { type: "session.created" },
      { type: "input_audio_buffer.speech_started", item_id: "msg_1" },
      { type: "input_audio_buffer.speech_stopped", item_id: "msg_1" },
      { type: "response.created" },
      { type: "response.function_call_arguments.done", call_id: "c1", name: "list_repos" },
      { type: "conversation.item.input_audio_transcription.completed", item_id: "msg_1", transcript: " which repos changed? " },
      { type: "response.output_audio_transcript.delta", item_id: "it_2", delta: "Two repos" },
      { type: "response.output_audio_transcript.delta", item_id: "it_2", delta: " have changes." },
      { type: "response.output_audio.delta", item_id: "it_2", delta: "AAAA" },
    ]);
    expect(v.lines).toEqual([
      { id: "msg_1", who: "you", text: "which repos changed?" },
      { id: "c1", who: "tool", text: "listed repos" },
      { id: "it_2", who: "canopy", text: "Two repos have changes." },
    ]);
    expect(v.phase).toBe("speaking");
    expect(voiceReduce(v, { type: "response.done" }).phase).toBe("listening");
  });
  test("an error is kept, and an event it does not know changes nothing", () => {
    const v = run([{ type: "error", error: { message: "Realtime models are not available" } }]);
    expect(v.error).toBe("Realtime models are not available");
    expect(voiceReduce(v, { type: "rate_limits.updated" })).toBe(v);
  });
});

const repo = (name: string, files = 0, ahead = 0, behind = 0, over: Partial<Repo> = {}): Repo =>
  ({
    id: `dev/${name}`,
    name,
    path: `/r/${name}`,
    group: "dev",
    status: { branch: "main", upstream: "origin/main", ahead, behind, files: Array.from({ length: files }, (_, i) => ({ path: `f${i}` })), lastCommit: { hash: "h", subject: "fix it", at: 1_000 }, user: null },
    ...over,
  }) as Repo;

const world = (over: Partial<VoiceWorld> = {}): VoiceWorld => ({
  repos: [repo("canopy", 3, 1), repo("ripe", 1, 0, 2), repo("ArchiSketch"), repo("old", 9, 0, 0, { archived: "canopy" }), repo("tally", 0, 4)],
  asks: [{ id: "a1", agent: "claude:s1", kind: "permission", title: "Bash: rm -rf build", state: "open" } as Ask, { id: "a2", agent: "x", kind: "question", title: "done", state: "answered" } as Ask],
  runs: [
    { id: "r1", repoId: "dev/canopy", verb: "Fix the tests", status: "waiting", startedAt: 1_000_000, prompt: { id: "p", kind: "proposal", plan: "", auto: false } } as Run,
    { id: "r2", repoId: "dev/ripe", verb: "Build", status: "working", startedAt: 2_000_000, prompt: null } as Run,
    { id: "r3", repoId: "dev/tally", verb: "Review", status: "done", startedAt: 0, endedAt: 3_000_000, prompt: null } as Run,
  ],
  jobs: [{ id: "j1", repoId: "dev/canopy", title: "Install", status: "working", startedAt: 1_000_000 } as Job],
  now: 3_600_000,
  ...over,
});

const acts = () => {
  const seen: string[] = [];
  const a: VoiceActs = { openRepo: (id) => seen.push(`repo ${id}`), openView: (v) => seen.push(`view ${v}`), hangUp: () => seen.push("hang up") };
  return { a, seen };
};

describe("runVoiceTool", () => {
  test("overview counts live repos only", () => {
    expect(runVoiceTool("overview", "{}", world(), acts().a)).toEqual({ repos: 4, with_changes: 2, ahead: 2, behind: 1, asks_waiting: 1, runs_waiting: 1, runs_working: 1, jobs_working: 1 });
  });
  test("list_repos defaults to changed, busiest first, and filters by name", () => {
    const out = runVoiceTool("list_repos", "", world(), acts().a) as { total: number; repos: { name: string; changed_files: number }[] };
    expect(out.total).toBe(2);
    expect(out.repos.map((r) => [r.name, r.changed_files])).toEqual([["canopy", 3], ["ripe", 1]]);
    const ahead = runVoiceTool("list_repos", JSON.stringify({ only: "ahead" }), world(), acts().a) as { repos: { name: string }[] };
    expect(ahead.repos.map((r) => r.name)).toEqual(["canopy", "tally"]);
    const named = runVoiceTool("list_repos", JSON.stringify({ only: "all", name: "arch sketch" }), world(), acts().a) as { repos: { name: string }[] };
    expect(named.repos.map((r) => r.name)).toEqual(["ArchiSketch"]);
  });
  test("list_repos never sends the file list", () => {
    expect(JSON.stringify(runVoiceTool("list_repos", "{}", world(), acts().a))).not.toContain("f0");
  });
  test("needs_me has open asks and waiting runs", () => {
    expect(runVoiceTool("needs_me", "{}", world(), acts().a)).toEqual({
      asks: [{ kind: "permission", title: "Bash: rm -rf build", from: "claude:s1" }],
      waiting_runs: [{ repo: "canopy", doing: "Fix the tests", waiting_for: "proposal" }],
    });
  });
  test("list_runs is active work by default, and the latest of everything when asked", () => {
    const active = runVoiceTool("list_runs", "{}", world(), acts().a) as { runs: { repo: string }[]; jobs: unknown[] };
    expect(active.runs.map((r) => r.repo)).toEqual(["ripe", "canopy"]);
    expect(active.jobs).toHaveLength(1);
    const all = runVoiceTool("list_runs", JSON.stringify({ active_only: false }), world(), acts().a) as { runs: { repo: string; since: string }[] };
    expect(all.runs[0]).toMatchObject({ repo: "tally", since: "10 minutes" });
  });
  test("open_repo opens one match, asks between several, and offers the closest for none", () => {
    const { a, seen } = acts();
    expect(runVoiceTool("open_repo", JSON.stringify({ name: "Arch" }), world(), a)).toEqual({ opened: "ArchiSketch" });
    expect(seen).toEqual(["repo dev/ArchiSketch"]);
    const two = world({ repos: [repo("canopy"), repo("canopy-deploy")] });
    expect(runVoiceTool("open_repo", JSON.stringify({ name: "can" }), two, a)).toEqual({ opened: null, which_one: ["canopy", "canopy-deploy"] });
    expect(runVoiceTool("open_repo", JSON.stringify({ name: "canopy" }), two, a)).toEqual({ opened: "canopy" });
    // a near miss is a guess: it goes back to the model, and nothing opens
    expect(runVoiceTool("open_repo", JSON.stringify({ name: "rype" }), world(), a)).toEqual({ opened: null, did_you_mean: ["ripe"], ask_the_user_first: true });
    expect(runVoiceTool("open_repo", JSON.stringify({ name: "Arch Sketch" }), world(), a)).toMatchObject({ did_you_mean: ["ArchiSketch"] });
    expect(seen).toEqual(["repo dev/ArchiSketch", "repo dev/canopy"]);
    // the same repo checked out on two backends is one repo
    const both = world({ repos: [repo("ripe"), repo("ripe", 0, 0, 0, { id: "mini:dev/ripe" })] });
    expect(runVoiceTool("open_repo", JSON.stringify({ name: "ripe" }), both, a)).toEqual({ opened: "ripe" });
    const none = runVoiceTool("open_repo", JSON.stringify({ name: "tallies app" }), world(), a) as { closest: string[] };
    expect(none.closest[0]).toBe("tally");
    expect(runVoiceTool("open_repo", JSON.stringify({ name: "old" }), world(), a)).toMatchObject({ opened: null });
  });
  test("open_view takes only a real view; end_conversation hangs up", () => {
    const { a, seen } = acts();
    expect(runVoiceTool("open_view", JSON.stringify({ view: "agents" }), world(), a)).toEqual({ opened: "agents" });
    expect(runVoiceTool("open_view", JSON.stringify({ view: "settings" }), world(), a)).toMatchObject({ error: "no view named settings" });
    runVoiceTool("end_conversation", "", world(), a);
    expect(seen).toEqual(["view agents", "hang up"]);
  });
  test("a tool it does not have, or arguments that are not JSON", () => {
    expect(runVoiceTool("commit", "{}", world(), acts().a)).toEqual({ error: "there is no tool named commit" });
    expect(runVoiceTool("list_repos", "{oops", world(), acts().a)).toMatchObject({ total: 2 });
  });
});

test("matchRepos and distance", () => {
  expect(matchRepos([repo("ripe")], "")).toEqual({ how: "none", repos: [] });
  expect(matchRepos([repo("ripe")], "zzzz")).toEqual({ how: "none", repos: [] });
  expect(distance("rype", "ripe")).toBe(1);
  expect(distance("", "abc")).toBe(3);
});

import { describe, expect, test } from "bun:test";
import type { Repo, Run } from "../../src/core/types";
import { captureVoiceContext, sendVoicePrompt } from "./voicecontext";
import { runVoiceTool, type VoiceActs, type VoiceWorld } from "./voice";

const repo = (id: string): Repo => ({ id, name: "api", path: `/r/${id}`, group: "", source: "root", status: null });
const run = (id: string, repoId: string): Run => ({ id, repoId, action: "chat", verb: "Chat", progress: "", expectsChange: false, chat: true, harness: "codex", note: "Fix uploads", status: "idle", startedAt: 1, steps: [{ id: "u", kind: "user", at: 2, text: "Keep the existing API" }, { id: "a", kind: "text", at: 3, text: "I found the bug" }], prompt: null });
const page = () => ({ repos: [repo("a/api"), repo("b/api")], runs: { a: run("a", "a/api"), b: run("b", "b/api") }, sheet: null, front: null, activePanel: "b/api" });

describe("voice invocation context", () => {
  test("the open chat wins over another active repository and includes its conversation", () => {
    const context = captureVoiceContext({ ...page(), sheet: { kind: "run", runId: "a" } }, new URLSearchParams());
    expect(context).toMatchObject({ kind: "chat", repo: { id: "a/api" }, chat: { id: "a", note: "Fix uploads", messages: [{ who: "user", text: "Keep the existing API" }, { who: "assistant", text: "I found the bug" }] } });
  });
  test("repo focus, solo routes and unrelated views do not inherit a hidden panel", () => {
    expect(captureVoiceContext(page(), new URLSearchParams())).toMatchObject({ kind: "repo", repo: { id: "b/api" } });
    expect(captureVoiceContext(page(), new URLSearchParams("repo=a%2Fapi"))).toMatchObject({ kind: "repo", repo: { id: "a/api" } });
    expect(captureVoiceContext(page(), new URLSearchParams("view=health"))).toEqual({ kind: "global", view: "health" });
    expect(captureVoiceContext({ ...page(), sheet: { kind: "run", runId: "gone" } }, new URLSearchParams())).toEqual({ kind: "global", view: "git" });
  });
  test("an inline chat the user focused has its own invocation context", () => {
    expect(captureVoiceContext(page(), new URLSearchParams("view=agents"), "a")).toMatchObject({ kind: "chat", chat: { id: "a" }, repo: { id: "a/api" } });
  });
  test("the active shell supplies its repository instead of a hidden dock panel", () => {
    const s = { ...page(), front: { kind: "strip" as const }, activeTerm: "shell", terms: [{ id: "shell", repoId: "a/api", name: "api", path: "/r/a/api", place: "strip" as const }] };
    expect(captureVoiceContext(s, new URLSearchParams())).toMatchObject({ kind: "repo", repo: { id: "a/api" } });
  });
  test("work continues in the invoked chat even after another chat opens", async () => {
    const state = page();
    const context = captureVoiceContext({ ...state, sheet: { kind: "run", runId: "a" } }, new URLSearchParams());
    const sent: string[] = [];
    await sendVoicePrompt(context, "fix it", { ...state, sayRun: async (id, text) => { sent.push(`${id}: ${text}`); }, openChat: async () => { throw new Error("wrong chat"); } });
    expect(sent).toEqual(["a: fix it"]);
    await expect(sendVoicePrompt(context, "fix it", { ...state, runs: { a: { ...state.runs.a, status: "working" } }, sayRun: async () => { throw new Error("must not send"); }, openChat: async () => {} })).rejects.toThrow("still working");
  });
  test("a missing invocation target cannot fall through to a different repository", async () => {
    const state = page();
    const context = captureVoiceContext({ ...state, sheet: { kind: "run", runId: "a" } }, new URLSearchParams());
    await expect(sendVoicePrompt(context, "fix it", { ...state, runs: {}, sayRun: async () => {}, openChat: async () => { throw new Error("wrong chat"); } })).rejects.toThrow("no longer available");
  });
  test("orchestration waits for acceptance, retains chat identity, and reports failures", async () => {
    const state = page();
    const context = captureVoiceContext({ ...state, sheet: { kind: "run", runId: "a" } }, new URLSearchParams());
    const world: VoiceWorld = { repos: state.repos, runs: Object.values(state.runs), asks: [], jobs: [], now: 1, context };
    const accepted = Promise.withResolvers<void>();
    const sent: unknown[] = [];
    const acts: VoiceActs = { openRepo: () => {}, openView: () => {}, hangUp: () => {}, orchestrate: async (target, prompt) => { sent.push([target, prompt]); await accepted.promise; } };
    let settled = false;
    const answer = Promise.resolve(runVoiceTool("orchestrate", '{"prompt":"continue fixing uploads"}', world, acts)).then((r) => { settled = true; return r; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(sent).toEqual([[context, "continue fixing uploads"]]);
    accepted.resolve();
    expect(await answer).toMatchObject({ accepted: true, chat_id: "a" });
    expect(await runVoiceTool("orchestrate", '{"prompt":"continue"}', world, { ...acts, orchestrate: async () => { throw new Error("offline"); } })).toEqual({ accepted: false, error: "offline" });
    expect(runVoiceTool("orchestrate", '{"prompt":"continue", "name":"api"}', world, acts)).toMatchObject({ accepted: false, ask_the_user_first: true });
    expect(runVoiceTool("current_context", "{}", { ...world, runs: [{ ...state.runs.a, status: "working" }] }, acts)).toMatchObject({ kind: "chat", chat: { id: "a", status: "working" } });
  });
});

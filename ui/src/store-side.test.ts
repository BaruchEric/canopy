/** A side question in the page's store (FR-077): asking one starts a chat
 *  beside the run and shows it there, the run hears nothing, and the column
 *  opens and closes without touching the chat. The backend is a fetch that
 *  answers the two routes used. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Repo, Run } from "../../src/core/types";
import { useStore } from "./store";

const pristine = useStore.getState();
const realFetch = globalThis.fetch;

const repo = (id: string): Repo => ({ id, name: id, path: `/dev/${id}`, group: "", source: "launch", status: null });
const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  repoId: "app",
  action: "ask",
  verb: "ask",
  progress: "asking",
  expectsChange: false,
  chat: false,
  harness: "claude",
  note: "migrate the billing checkout",
  status: "working",
  session: "sess-1",
  startedAt: 1,
  steps: [],
  prompt: null,
  ...over,
});
const side = (id: string, parent: string, over: Partial<Run> = {}): Run =>
  run(id, { action: "chat", verb: "chat", chat: true, status: "idle", startedAt: 9, note: "what is the retry default?", sideOf: { run: parent, title: "migrate the billing checkout" }, agentSettings: { harness: "claude", model: "default", effort: "default" }, ...over });

interface Call {
  path: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
let refuse: string | null = null;

beforeEach(() => {
  calls = [];
  refuse = null;
  useStore.setState({ ...pristine, repos: [repo("app")], runs: { p: run("p") }, sideShown: {}, sheet: null }, true);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url), "http://x");
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ path: u.pathname, body });
    if (refuse) return Response.json({ error: refuse }, { status: 409 });
    const model = typeof body["model"] === "string" ? body["model"] : "default";
    if (u.pathname === "/api/runs/side") return Response.json(side("s1", String(body["id"]), { note: String(body["text"]), agentSettings: { harness: "claude", model, effort: "default" } }), { status: 201 });
    const live = useStore.getState().runs[String(body["id"])];
    if (u.pathname === "/api/runs/model" && live) return Response.json({ ...live, agentSettings: { harness: "claude", model, effort: "default" } });
    return Response.json({ error: "no such run" }, { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useStore.setState(pristine, true);
});

describe("asking a side question", () => {
  test("starts the chat on the side route, keeps it, and shows it beside the run", async () => {
    const before = useStore.getState().runs["p"];
    await useStore.getState().askSide("p", "what is the retry default?", "haiku");
    expect(calls.map((c) => c.path)).toEqual(["/api/runs/side"]);
    expect(calls[0]?.body).toMatchObject({ id: "p", text: "what is the retry default?", model: "haiku" });
    const s = useStore.getState();
    expect(s.runs["s1"]).toMatchObject({ chat: true, sideOf: { run: "p" }, agentSettings: { model: "haiku" } });
    expect(s.sideShown).toEqual({ p: "s1" });
    // the run itself is as it was: nothing was said to it
    expect(s.runs["p"]).toBe(before);
  });

  test("names no model unless one was picked, so the repo's chat setting stands", async () => {
    await useStore.getState().askSide("p", "what is the retry default?");
    expect(calls[0]?.body).not.toHaveProperty("model");
  });

  test("a step the stream brought first is not overwritten by the answer", async () => {
    const ahead = side("s1", "p", { status: "working", steps: [{ id: "1", at: 1, kind: "user", text: "what is the retry default?" }] });
    const realSet = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      useStore.setState((s) => ({ runs: { ...s.runs, s1: ahead } }));
      return realSet(url, init);
    }) as unknown as typeof fetch;
    await useStore.getState().askSide("p", "what is the retry default?");
    expect(useStore.getState().runs["s1"]).toBe(ahead);
    expect(useStore.getState().sideShown).toEqual({ p: "s1" });
  });

  test("a refusal reaches the caller in the backend's words, and nothing is shown", async () => {
    refuse = "the run has no session to fork yet: ask once it has begun";
    await expect(useStore.getState().askSide("p", "what is the retry default?")).rejects.toThrow("no session to fork yet");
    expect(useStore.getState().sideShown).toEqual({});
    expect(Object.keys(useStore.getState().runs)).toEqual(["p"]);
  });
});

describe("the column beside a run", () => {
  test("showSide opens it on a side question and closes it, and the chat stays either way", () => {
    useStore.setState({ runs: { p: run("p"), s1: side("s1", "p"), s2: side("s2", "p") } });
    useStore.getState().showSide("p", "s1");
    useStore.getState().showSide("p", "s2");
    expect(useStore.getState().sideShown).toEqual({ p: "s2" });
    useStore.getState().showSide("p", null);
    expect(useStore.getState().sideShown).toEqual({});
    expect(Object.keys(useStore.getState().runs)).toEqual(["p", "s1", "s2"]);
  });

  test("the browser keeps which column is open, for the next load", async () => {
    const kept = new Map<string, string>();
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) },
    });
    try {
      useStore.setState({ runs: { p: run("p"), q: run("q"), s1: side("s1", "p") } });
      useStore.getState().showSide("p", "s1");
      expect(JSON.parse(kept.get("canopy.sideShown") ?? "null")).toEqual({ p: "s1" });
      await useStore.getState().askSide("q", "and the port?");
      expect(JSON.parse(kept.get("canopy.sideShown") ?? "null")).toEqual({ p: "s1", q: "s1" });
      useStore.getState().showSide("p", null);
      expect(JSON.parse(kept.get("canopy.sideShown") ?? "null")).toEqual({ q: "s1" });
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  test("openSide shows it beside its run while that run is on the page", () => {
    useStore.setState({ runs: { p: run("p"), s1: side("s1", "p") } });
    useStore.getState().openSide("s1");
    expect(useStore.getState().sideShown).toEqual({ p: "s1" });
    expect(useStore.getState().sheet).toEqual({ kind: "run", runId: "p" });
  });

  test("openSide shows the side question's own console once its run is gone", () => {
    useStore.setState({ runs: { s1: side("s1", "p") } });
    useStore.getState().openSide("s1");
    expect(useStore.getState().sideShown).toEqual({});
    expect(useStore.getState().sheet).toEqual({ kind: "run", runId: "s1" });
  });
});

describe("a side question's model", () => {
  test("modelRun sends the pick and keeps the run the backend answers with", async () => {
    useStore.setState({ runs: { p: run("p"), s1: side("s1", "p") } });
    await useStore.getState().modelRun("s1", "sonnet");
    expect(calls).toEqual([{ path: "/api/runs/model", body: { id: "s1", model: "sonnet" } }]);
    expect(useStore.getState().runs["s1"]?.agentSettings?.model).toBe("sonnet");
  });

  test("a kept record changes no model, and a refusal reaches the caller", async () => {
    useStore.setState({ runs: { p: run("p"), k: side("k", "p", { kept: true }), s1: side("s1", "p") } });
    await useStore.getState().modelRun("k", "sonnet");
    expect(calls).toEqual([]);
    refuse = "it is mid-reply: pick the model once it has answered";
    await expect(useStore.getState().modelRun("s1", "sonnet")).rejects.toThrow("mid-reply");
    expect(useStore.getState().runs["s1"]?.agentSettings?.model).toBe("default");
  });
});

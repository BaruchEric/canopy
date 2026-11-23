/** Several runs on one repo in the page's store (FR-073): which run a card
 *  shows, where a chat's message goes, and what a run going there no longer
 *  stops. The backend is a fetch that answers the three routes used. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Repo, Run } from "../../src/core/types";
import { runFor, runsFor, useStore } from "./store";

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
  note: "",
  status: "working",
  startedAt: 1,
  steps: [],
  prompt: null,
  ...over,
});
const chat = (id: string, status: Run["status"], startedAt: number, over: Partial<Run> = {}): Run =>
  run(id, { action: "chat", verb: "chat", chat: true, status, startedAt, ...over });
const byId = (...runs: Run[]): Record<string, Run> => Object.fromEntries(runs.map((r) => [r.id, r]));

interface Call {
  path: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
let started = 0;

beforeEach(() => {
  calls = [];
  started = 0;
  useStore.setState({ ...pristine, repos: [repo("app"), repo("_incubator/seed")], runs: {}, flowRuns: {}, flows: {}, sheet: null }, true);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url), "http://x");
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ path: u.pathname, body });
    if (u.pathname === "/api/repos/run") {
      started += 1;
      const note = typeof body["note"] === "string" ? body["note"] : "";
      return Response.json(chat(`new${started}`, note ? "working" : "idle", 100 + started, { repoId: u.searchParams.get("id") ?? "", note }), { status: 201 });
    }
    const id = typeof body["id"] === "string" ? body["id"] : "";
    const live = useStore.getState().runs[id];
    if (u.pathname === "/api/runs/say" && live) return Response.json({ ...live, status: "working" });
    if (u.pathname === "/api/runs/name" && live) return Response.json({ ...live, name: body["name"], nameBy: "hand" });
    return Response.json({ error: "no such run" }, { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useStore.setState(pristine, true);
});

describe("the runs going on a repo", () => {
  test("runsFor lists them oldest first, without a coordinator, a flow's step, an ended run or another repo's", () => {
    useStore.setState({
      runs: byId(
        chat("c2", "idle", 5),
        run("job", { startedAt: 3 }),
        chat("c1", "idle", 1),
        run("done", { status: "done", startedAt: 9 }),
        run("coord", { action: "coordinate", verb: "coordinate", chat: true, startedAt: 2 }),
        run("step", { startedAt: 4 }),
        run("other", { repoId: "elsewhere" }),
      ),
      flowRuns: { step: "f1" },
    });
    expect(runsFor(useStore.getState(), "app").map((r) => r.id)).toEqual(["c1", "job", "c2"]);
    expect(runsFor(useStore.getState(), "nowhere")).toEqual([]);
  });

  test("the card shows the run that needs a person most, and a live run over a newer finished one", () => {
    useStore.setState({ runs: byId(chat("c", "idle", 9), run("job", { startedAt: 3 }), run("done", { status: "done", startedAt: 20 })) });
    expect(runFor(useStore.getState(), "app")?.id).toBe("job");
    useStore.setState({ runs: byId(chat("c", "idle", 9), run("job", { startedAt: 3 }), run("ask", { status: "waiting", startedAt: 2 })) });
    expect(runFor(useStore.getState(), "app")?.id).toBe("ask");
    useStore.setState({ runs: byId(run("old", { status: "done", startedAt: 1 }), run("new", { status: "failed", startedAt: 2 })) });
    expect(runFor(useStore.getState(), "app")?.id).toBe("new");
  });
});

describe("a chat on a repo that has runs going", () => {
  test("a plain chat shows the newest chat going, and starts one where none is", async () => {
    useStore.setState({ runs: byId(run("job"), chat("c1", "idle", 2), chat("c2", "working", 5)) });
    expect(await useStore.getState().openChat("app")).toBe("c2");
    expect(useStore.getState().sheet).toEqual({ kind: "run", runId: "c2" });
    expect(calls).toEqual([]);

    useStore.setState({ runs: byId(run("job")), sheet: null });
    expect(await useStore.getState().openChat("app")).toBe("new1");
    expect(calls.map((c) => c.path)).toEqual(["/api/repos/run"]);
    expect(calls[0]?.body).toMatchObject({ action: "chat", note: "" });
    expect(useStore.getState().sheet).toEqual({ kind: "run", runId: "new1" });
    expect(Object.keys(useStore.getState().runs).sort()).toEqual(["job", "new1"]);
  });

  test("a new chat starts beside the chats going", async () => {
    useStore.setState({ runs: byId(chat("c1", "idle", 2)) });
    expect(await useStore.getState().openChat("app", "", true)).toBe("new1");
    expect(calls.map((c) => c.path)).toEqual(["/api/repos/run"]);
    expect(runsFor(useStore.getState(), "app").map((r) => r.id)).toEqual(["c1", "new1"]);
  });

  test("a message goes into the newest chat between turns, else into a new chat, whatever else is at work", async () => {
    useStore.setState({ runs: byId(run("job"), chat("c1", "idle", 2), chat("c2", "idle", 5), chat("busy", "working", 9)) });
    expect(await useStore.getState().openChat("app", "merge the branch")).toBe("c2");
    expect(calls).toEqual([{ path: "/api/runs/say", body: { id: "c2", text: "merge the branch" } }]);
    expect(useStore.getState().sheet).toEqual({ kind: "run", runId: "c2" });

    calls = [];
    useStore.setState({ runs: byId(run("job"), chat("busy", "working", 9)) });
    expect(await useStore.getState().openChat("app", "merge the branch")).toBe("new1");
    expect(calls.map((c) => [c.path, c.body["note"]])).toEqual([["/api/repos/run", "merge the branch"]]);
  });

  test("text for the repo's agent goes the same way, and never refuses for a run at work", async () => {
    useStore.setState({ runs: byId(run("job"), chat("c1", "idle", 2)), terms: [] });
    expect(await useStore.getState().sendToAgent("app", "look at this")).toBe("said");
    expect(calls).toEqual([{ path: "/api/runs/say", body: { id: "c1", text: "look at this" } }]);

    calls = [];
    useStore.setState({ runs: byId(run("job")), terms: [] });
    expect(await useStore.getState().sendToAgent("app", "look at this")).toBe("started");
    expect(calls.map((c) => c.path)).toEqual(["/api/repos/run"]);
  });
});

describe("starting beside the runs going", () => {
  test("a job's plan opens with runs going, and a seed shows the one run it takes", () => {
    useStore.setState({ runs: byId(run("job"), chat("c1", "idle", 2), run("seeded", { repoId: "_incubator/seed" })) });
    useStore.getState().plan("app", "ask");
    expect(useStore.getState().sheet).toEqual({ kind: "plan", repoId: "app", action: "ask" });
    useStore.getState().plan("_incubator/seed", "ask");
    expect(useStore.getState().sheet).toEqual({ kind: "run", runId: "seeded" });
  });

  test("a workflow's plan opens beside the runs going, one at work among them; a seed shows its run", () => {
    const branch = { name: "run/x", target: "main", base: "b", dir: "/w", origin: "o", state: "working" as const };
    useStore.setState({ runs: byId(chat("c1", "idle", 2), run("onbranch", { branch })) });
    useStore.getState().planFlow("app", "ship");
    expect(useStore.getState().sheet).toEqual({ kind: "flow-plan", repoId: "app", workflow: "ship" });
    useStore.setState({ sheet: null, runs: byId(chat("c1", "idle", 2), run("job"), run("seeded", { repoId: "_incubator/seed" })) });
    useStore.getState().planFlow("app", "ship");
    expect(useStore.getState().sheet).toEqual({ kind: "flow-plan", repoId: "app", workflow: "ship" });
    useStore.getState().planFlow("_incubator/seed", "ship");
    expect(useStore.getState().sheet).toEqual({ kind: "run", runId: "seeded" });
  });
});

describe("a run's name", () => {
  test("renameRun sends the name and keeps the run the backend answers with", async () => {
    useStore.setState({ runs: byId(chat("c1", "idle", 2, { name: "look around", nameBy: "words" })) });
    await useStore.getState().renameRun("c1", "peer sync");
    expect(calls).toEqual([{ path: "/api/runs/name", body: { id: "c1", name: "peer sync" } }]);
    expect(useStore.getState().runs["c1"]).toMatchObject({ name: "peer sync", nameBy: "hand" });
  });

  test("a kept run is not renamed", async () => {
    useStore.setState({ runs: byId(chat("k", "done", 2, { kept: true })) });
    await useStore.getState().renameRun("k", "peer sync");
    expect(calls).toEqual([]);
  });

  test("a start keeps the copy the stream brought first, with the name it carries", async () => {
    globalThis.fetch = (async () => {
      // the stream's broadcast lands before the start's own answer
      useStore.setState((s) => ({ runs: { ...s.runs, n: chat("n", "working", 50, { name: "slow build", nameBy: "model" }) } }));
      return Response.json(chat("n", "working", 50, { name: "look at why the build", nameBy: "words" }), { status: 201 });
    }) as unknown as typeof fetch;
    expect(await useStore.getState().startRun("app", "chat", "look at why the build is slow")).toBe("n");
    expect(useStore.getState().runs["n"]?.name).toBe("slow build");
  });
});

import { describe, expect, test } from "bun:test";
import { stallResumeMessage, stalledWhy } from "../core/stall";
import type { LandingRun, Run } from "../core/types";
import { StallHub, type StallDeps } from "./stalls";

const rec = (over: Partial<LandingRun> = {}): LandingRun => ({
  id: "b1",
  runId: "r1",
  repoId: "api",
  repoPath: "/r/api",
  branch: "run/x-b1",
  target: "main",
  base: "c0",
  dir: "/w/b1",
  note: "fix it",
  verb: "ask",
  harness: "claude",
  state: "working",
  startedAt: 1,
  ...over,
});

const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  repoId: "api",
  action: "ask",
  verb: "ask",
  progress: "asking",
  expectsChange: true,
  chat: false,
  harness: "claude",
  session: `s-${id}`,
  note: "",
  status: "stopped",
  startedAt: 1,
  steps: [],
  prompt: null,
  stall: { warned: 1, stopped: 2 },
  branch: { name: "run/x-b1", target: "main", base: "c0", dir: "/w/b1", state: "working", origin: "b1" },
  ...over,
});

/** A hub over stand-ins: the watchdog hands back `stopping` once; each
 *  run's end settles when `end(id)` is called. */
function world(over: Partial<StallDeps> = {}) {
  const records = new Map<string, LandingRun>([["b1", rec()]]);
  let stopping: Run[] = [];
  const ends = new Map<string, () => void>();
  const endP = new Map<string, Promise<void>>();
  const resumed: { rec: LandingRun; message: string }[] = [];
  const carried: [string, string][] = [];
  const left: [string, string][] = [];
  let n = 0;
  const hub = new StallHub({
    watchdog: () => {
      const out = stopping;
      stopping = [];
      return out;
    },
    ended: (id) => {
      if (!endP.has(id)) endP.set(id, new Promise<void>((r) => ends.set(id, r)));
      return endP.get(id) ?? null;
    },
    record: (id) => records.get(id),
    countStall: (id) => {
      const r = records.get(id);
      if (!r) return 0;
      const next = { ...r, stalls: (r.stalls ?? 0) + 1 };
      records.set(id, next);
      return next.stalls;
    },
    resume: async (r, message) => {
      resumed.push({ rec: r, message });
      return run(`resumed${++n}`, { status: "working" });
    },
    carried: (from, to) => carried.push([from.id, to.id]),
    left: (r, why) => left.push([r.id, why]),
    // co1 is a coordinator still going; any other parent has ended
    coordinatorActive: (id) => id === "co1",
    ...over,
  });
  const stall = (r: Run) => {
    stopping = [r];
    hub.tick();
  };
  const end = (id: string) => {
    if (!endP.has(id)) endP.set(id, Promise.resolve());
    ends.get(id)?.();
  };
  return { hub, records, resumed, carried, left, stall, end };
}

describe("StallHub", () => {
  test("a first stall on a branch: starting at once, resumed once the run's end is read, and followed", async () => {
    const w = world();
    w.stall(run("r1"));
    expect(w.hub.starting("r1")).toBe(true);
    expect(w.resumed).toEqual([]);
    w.end("r1");
    await w.hub.idle();
    expect(w.resumed).toHaveLength(1);
    expect(w.resumed[0]?.message).toBe(stallResumeMessage());
    expect(w.carried).toEqual([["r1", "resumed1"]]);
    expect(w.hub.starting("r1")).toBe(false);
    expect(w.hub.latest("r1")).toBe("resumed1");
    expect(w.records.get("b1")?.stalls).toBe(1);
  });

  test("the second stall on the branch is left for Eric, not resumed", async () => {
    const w = world();
    w.stall(run("r1"));
    w.end("r1");
    await w.hub.idle();
    w.stall(run("resumed1"));
    expect(w.hub.starting("resumed1")).toBe(false);
    w.end("resumed1");
    await w.hub.idle();
    expect(w.resumed).toHaveLength(1);
    expect(w.left).toEqual([["resumed1", stalledWhy("again")]]);
    expect(w.records.get("b1")?.stalls).toBe(2);
    // the chain still leads to the last run
    expect(w.hub.latest("r1")).toBe("resumed1");
  });

  test("no Claude session to resume: left for Eric", async () => {
    const w = world();
    w.stall(run("r1", { harness: "codex" }));
    w.end("r1");
    await w.hub.idle();
    expect(w.resumed).toEqual([]);
    expect(w.left).toEqual([["r1", stalledWhy("no-session")]]);
  });

  test("a resume that will not start is left for Eric with why, and is no longer starting", async () => {
    const w = world({ resume: async () => { throw new Error("api is not in the tree"); } });
    w.stall(run("r1"));
    w.end("r1");
    await w.hub.idle();
    expect(w.left).toEqual([["r1", stalledWhy("not-resumed", "api is not in the tree")]]);
    expect(w.hub.starting("r1")).toBe(false);
    expect(w.hub.latest("r1")).toBe("r1");
  });

  test("a flow's step and a checkout job are only stopped", async () => {
    const w = world();
    w.stall(run("f1", { flowStep: { workflow: "fix", step: "Fix", source: "bundled" } }));
    w.stall(run("j1", { branch: undefined }));
    await w.hub.idle();
    expect(w.resumed).toEqual([]);
    expect(w.left).toEqual([]);
    expect(w.records.get("b1")?.stalls).toBeUndefined();
  });

  test("a run's child has no such owner, so the watchdog treats it as any branch run", async () => {
    const w = world();
    w.stall(run("k1", { parent: "p1", depth: 1 }));
    expect(w.hub.starting("k1")).toBe(true);
    w.end("k1");
    await w.hub.idle();
    expect(w.resumed.length).toBe(1);
  });

  test("a coordinator's child and a group's member are only stopped: their owner reads the stop", async () => {
    const w = world();
    w.stall(run("c1", { parent: "co1" }));
    w.stall(run("g1", { group: "g1" }));
    expect([w.hub.starting("c1"), w.hub.starting("g1")]).toEqual([false, false]);
    await w.hub.idle();
    expect(w.resumed).toEqual([]);
    expect(w.left).toEqual([]);
    expect(w.records.get("b1")?.stalls).toBeUndefined();
  });

  test("a child whose coordinator has ended has no owner left, so it is resumed like any branch run", async () => {
    const w = world();
    w.stall(run("c2", { parent: "co2" }));
    expect(w.hub.starting("c2")).toBe(true);
    w.end("c2");
    await w.hub.idle();
    expect(w.resumed).toHaveLength(1);
    expect(w.carried).toEqual([["c2", "resumed1"]]);
    expect(w.records.get("b1")?.stalls).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import { asAgentCard, asChanMessage, chanTarget, dmPeer, fleetNotice, flowNotice, parseSse, readQuery, registryCard, runNotice, shellHandle } from "./tailchan";
import type { Fleet, Flow, Run } from "./types";

describe("chanTarget", () => {
  test("a channel with or without #, a handle with @", () => {
    expect(chanTarget("#Builds")).toEqual({ channel: "builds" });
    expect(chanTarget("jobs")).toEqual({ channel: "jobs" });
    expect(chanTarget("@claude-4f763a")).toEqual({ to: "claude-4f763a" });
  });
  test("refuses what the broker would", () => {
    expect(chanTarget("dm.a+b")).toBeNull();
    expect(chanTarget("#a b")).toBeNull();
    expect(chanTarget("@")).toBeNull();
    expect(chanTarget("")).toBeNull();
  });
});

test("readQuery takes a DM's channel name as well as a target", () => {
  expect(readQuery("dm.claude-1+eric")).toBe("channel=dm.claude-1%2Beric");
  expect(readQuery("@eric")).toBe("to=eric");
  expect(readQuery("#canopy")).toBe("channel=canopy");
  expect(readQuery("dm.bad")).toBeNull();
});

test("dmPeer names the other side of a DM", () => {
  expect(dmPeer("dm.claude-1+eric", "eric")).toBe("claude-1");
  expect(dmPeer("dm.claude-1+eric", "claude-1")).toBe("eric");
  expect(dmPeer("dm.a+b", "eric")).toBeNull();
  expect(dmPeer("canopy", "eric")).toBeNull();
});

describe("shellHandle", () => {
  const id = "4f763a90aa00bb11cc22dd33ee44ff55";
  test("the repo slugged, then four hex of the shell", () => {
    expect(shellHandle("canopy", id)).toBe("canopy-4f76");
    expect(shellHandle("My App (v2)", id)).toBe("my-app-v2-4f76");
    expect(shellHandle("__init", id)).toBe("init-4f76");
  });
  test("fits the broker's 40 and never starts or ends on a separator", () => {
    const h = shellHandle("a".repeat(29) + "-bbbbbbbbbb", id);
    expect(h.length).toBeLessThanOrEqual(40);
    expect(h).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    expect(shellHandle("a".repeat(29) + "-b", id)).toBe(`${"a".repeat(29)}-4f76`);
    expect(shellHandle("!!!", id)).toBe("shell-4f76");
  });
});

describe("parseSse", () => {
  test("whole events out, the cut one left", () => {
    const { events, rest } = parseSse('event: ready\ndata: {"a":1}\n\n: ping\n\nid: 7\nevent: message\ndata: {"id":7}\n\nid: 8\nda');
    expect(events).toEqual([
      { event: "ready", data: '{"a":1}' },
      { event: "message", data: '{"id":7}', id: "7" },
    ]);
    expect(rest).toBe("id: 8\nda");
  });
  test("CRLF and multi-line data", () => {
    expect(parseSse("data: a\r\ndata: b\r\n\r\n").events).toEqual([{ event: "message", data: "a\nb" }]);
  });
});

test("asChanMessage checks the fields it relies on", () => {
  const ok = { id: 1, channel: "c", handle: "h", node: "n", kind: "text", body: "hi", meta: { silent: true }, ts: 5 };
  expect(asChanMessage(ok)).toEqual(ok);
  expect(asChanMessage({ ...ok, meta: null })?.meta).toEqual({});
  expect(asChanMessage({ ...ok, id: "1" })).toBeNull();
  expect(asChanMessage(null)).toBeNull();
});

const run = (over: Partial<Run>): Run => ({
  id: "r1",
  repoId: "canopy",
  action: "commit",
  verb: "commit",
  progress: "",
  expectsChange: true,
  chat: false,
  note: "",
  status: "working",
  startedAt: 0,
  steps: [],
  prompt: null,
  ...over,
});

describe("runNotice", () => {
  test("a prompt is a DM, once", () => {
    const r = run({ status: "waiting", prompt: { id: "p", kind: "permission", tool: "Bash", title: "run git push", detail: "" } });
    expect(runNotice(r, "working", "canopy")).toEqual({ to: "human", text: "canopy: commit wants to run git push" });
    expect(runNotice(r, "waiting", "canopy")).toBeNull();
    expect(runNotice(run({ status: "waiting", prompt: { id: "q", kind: "question", questions: [] } }), "working", "x")?.text).toBe("x: commit has a question");
  });
  test("an end is a channel line with its outcome or its error", () => {
    expect(runNotice(run({ status: "done", outcome: "changed" }), "working", "canopy")).toEqual({ to: "channel", text: "canopy: commit done, changed" });
    expect(runNotice(run({ status: "failed", error: "boom" }), "working", "canopy")?.text).toBe("canopy: commit failed: boom");
    expect(runNotice(run({ status: "stopped" }), "done", "canopy")).toBeNull();
  });
  test("working and a chat between turns say nothing", () => {
    expect(runNotice(run({ status: "working" }), undefined, "c")).toBeNull();
    expect(runNotice(run({ status: "idle", chat: true }), "working", "c")).toBeNull();
  });
});

test("flowNotice: a gate is a DM, an end a line", () => {
  const flow = (over: Partial<Flow>): Flow => ({
    id: "f",
    repoId: "canopy",
    workflow: "ship",
    verb: "ship",
    note: "",
    status: "working",
    steps: [{ name: "tests", status: "gated" }],
    current: 0,
    startedAt: 0,
    ...over,
  });
  expect(flowNotice(flow({ status: "gated" }), "working", "canopy")).toEqual({ to: "human", text: 'canopy: ship waits at a gate after "tests"' });
  expect(flowNotice(flow({ status: "done", outcome: "unchanged" }), "working", "canopy")?.text).toBe("canopy: ship done, unchanged");
  expect(flowNotice(flow({ status: "working" }), "gated", "canopy")).toBeNull();
});

test("fleetNotice counts what ran and what was skipped", () => {
  const fleet: Fleet = {
    id: "fl",
    workflow: "ship",
    verb: "ship",
    note: "",
    repos: [{ repoId: "a", flowId: "1" }, { repoId: "b", skipped: "dirty" }, { repoId: "c", flowId: "2" }],
    status: "done",
    startedAt: 0,
  };
  expect(fleetNotice(fleet, "working")).toEqual({ to: "channel", text: "fleet ship done: 2 repos, 1 skipped" });
  expect(fleetNotice(fleet, "done")).toBeNull();
  expect(fleetNotice({ ...fleet, status: "working" }, undefined)).toBeNull();
});

describe("the registry's cards", () => {
  const card = {
    id: "claude:abc",
    handle: "app-0123",
    node: "macmini-2018",
    harness: "claude",
    session: "abc",
    origin: "canopy-shell",
    cwd: "/dev/app",
    repo: "https://github.com/me/app",
    branch: "main",
    model: "opus",
    mode: "default",
    state: "waiting",
    waiting: "your turn",
    caps: ["os:linux", "container"],
    offers: [],
    notifyIdle: false,
    where: { os: "linux", container: true, pid: 41, term: null, canopy: { backend: "mini", term: "0123" } },
    transcript: "/home/bun/.claude/projects/-dev-app/abc.jsonl",
    startedAt: 1,
    seenAt: 2,
    endedAt: null,
  };

  test("a broker card reads back field for field", () => {
    expect(asAgentCard(card)).toEqual(card as never);
  });

  test("the keys are checked and the rest defaulted", () => {
    expect(asAgentCard({ ...card, state: "gone" })).toBeNull();
    expect(asAgentCard({ ...card, id: "" })).toBeNull();
    expect(asAgentCard({ ...card, seenAt: "2" })).toBeNull();
    expect(asAgentCard({ id: "scan:mini:c:9", node: "mini", state: "idle", seenAt: 5, harness: "gemini", origin: "?" })).toEqual({
      id: "scan:mini:c:9",
      handle: "",
      node: "mini",
      harness: "other",
      session: null,
      origin: "elsewhere",
      cwd: "",
      repo: null,
      branch: null,
      model: null,
      mode: null,
      state: "idle",
      waiting: null,
      caps: [],
      offers: [],
      notifyIdle: false,
      where: { os: "", container: false, pid: null, term: null, canopy: null },
      transcript: null,
      startedAt: 5,
      seenAt: 5,
      endedAt: null,
    });
  });

  test("an #agents event carries one; anything else carries none", () => {
    const m = { id: 9, channel: "agents", handle: "tailchan", node: "tailchan", kind: "event", body: JSON.stringify({ type: "agent", card }), meta: { silent: true }, ts: 3 };
    expect(registryCard(m)?.id).toBe("claude:abc");
    expect(registryCard({ ...m, channel: "asks" })).toBeNull();
    expect(registryCard({ ...m, kind: "text" })).toBeNull();
    expect(registryCard({ ...m, body: "{" })).toBeNull();
    expect(registryCard({ ...m, body: JSON.stringify({ type: "ask", ask: {} }) })).toBeNull();
  });
});

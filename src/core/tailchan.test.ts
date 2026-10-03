import { describe, expect, test } from "bun:test";
import { asAgentCard, asAsk, asChanMessage, askOf, asPresence, chanTarget, repoChannel, dmPeer, fleetNotice, flowNotice, parseSse, readQuery, registryCard, retroNotice, runNotice, shellHandle, sproutNotice } from "./tailchan";
import type { Fleet, Flow, Run, Sprout } from "./types";

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
  harness: "claude",
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
    // only the broker's own: a card another handle got onto #agents is none
    expect(registryCard({ ...m, handle: "app-0123", node: "macmini-2018" })).toBeNull();
    expect(registryCard({ ...m, handle: "tailchan", node: "macmini-2018" })).toBeNull();
  });
});

describe("repoChannel, by the CLI hook's rule (fixtures off its own pipeline)", () => {
  const cases: [string, string][] = [
    ["https://github.com/Eric/Demo", "repo.eric-demo"],
    ["https://github.com/eric/canopy", "repo.eric-canopy"],
    ["https://gitlab.com/group/sub/Name.With_Dots", "repo.sub-name.with_dots"],
    ["https://github.com/some-org/a-very-long-repository-name-that-goes-on-and-on-and-on-forever", "repo.some-org-a-very-long-repository-name-that-goes-on-and-on-an"],
    ["https://github.com/x/foo!", "repo.x-foo-"],
    ["https://git.example.com:8443/team/app", "repo.team-app"],
    ["https://github.com/Ünï/cödé", "repo.--n---c--d--"],
    ["https://github.com/owner/abcdefghijabcdefghijabcdefghijabcdefghijabcdefghij0123456", "repo.owner-abcdefghijabcdefghijabcdefghijabcdefghijabcdefghij012"],
  ];
  for (const [url, channel] of cases) test(url, () => expect(repoChannel(url)).toBe(channel));
  test("nothing for no url", () => {
    expect(repoChannel(null)).toBeNull();
    expect(repoChannel("")).toBeNull();
  });
  test("every one is a channel the broker takes", () => {
    for (const [url] of cases) expect(chanTarget(`#${repoChannel(url)}`)).not.toBeNull();
  });
});

describe("asks as the broker posts them", () => {
  const raw = {
    id: "6b72",
    agent: "claude:s1",
    handle: "app-0123",
    node: "macmini-2018",
    kind: "question",
    tool: "AskUserQuestion",
    title: "question: which?",
    detail: "{}",
    questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "the first" }, { nope: 1 }], multiSelect: true }, { bad: true }],
    route: "remote",
    waitUntil: 2_000,
    state: "answered",
    answer: { behavior: "allow", answers: { "Which?": "A", n: 2 }, always: false },
    answeredBy: "phone@canopy",
    createdAt: 1_000,
    answeredAt: 1_500,
  };

  test("asAsk reads one field by field", () => {
    expect(asAsk(raw)).toEqual({
      id: "6b72",
      agent: "claude:s1",
      handle: "app-0123",
      node: "macmini-2018",
      kind: "question",
      tool: "AskUserQuestion",
      title: "question: which?",
      detail: "{}",
      questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "the first" }], multiSelect: true }],
      route: "remote",
      waitUntil: 2_000,
      state: "answered",
      answer: { behavior: "allow", answers: { "Which?": "A" } },
      answeredBy: "phone@canopy",
      createdAt: 1_000,
      answeredAt: 1_500,
    });
  });

  test("asAsk refuses what canopy cannot key or route on", () => {
    expect(asAsk({ ...raw, id: "" })).toBeNull();
    expect(asAsk({ ...raw, kind: "vote" })).toBeNull();
    expect(asAsk({ ...raw, state: "pending" })).toBeNull();
    expect(asAsk({ ...raw, createdAt: "soon" })).toBeNull();
    expect(asAsk(null)).toBeNull();
  });

  test("askOf reads the #asks event and nothing else", () => {
    const m = { id: 1, channel: "asks", handle: "tailchan", node: "tailchan", kind: "event", body: JSON.stringify({ type: "ask", ask: raw }), meta: { silent: true }, ts: 1 };
    expect(askOf(m)?.id).toBe("6b72");
    expect(askOf({ ...m, channel: "agents" })).toBeNull();
    expect(askOf({ ...m, kind: "text" })).toBeNull();
    expect(askOf({ ...m, body: JSON.stringify({ type: "agent", card: {} }) })).toBeNull();
    expect(askOf({ ...m, body: "not json" })).toBeNull();
    // an ask an agent posted itself is no ask: it would sit in the inbox as
    // the broker's, and an answer to it would go to the broker
    expect(askOf({ ...m, handle: "claude-4f763a", node: "macmini-2018" })).toBeNull();
    expect(askOf({ ...m, node: "ericmac" })).toBeNull();
  });

  test("asPresence", () => {
    expect(asPresence({ state: "here", at: 5, pinned: false, by: "canopy" })).toEqual({ state: "here", at: 5, pinned: false, by: "canopy" });
    expect(asPresence({ state: "gone" })).toBeNull();
  });
});

describe("sproutNotice", () => {
  const base: Sprout = {
    id: "sp_000000000001",
    slug: "coins",
    title: "Coin counter",
    status: "clarifying",
    repoId: "_incubator/coins",
    seedPath: "/root/_incubator/coins",
    prepared: true,
    inputs: [],
    clarified: true,
    reclarify: false,
    flows: [],
    spent: { runs: 0, workMs: 0 },
    createdAt: 0,
    updatedAt: 0,
  };
  test("questions are a DM once, while they wait", () => {
    const q = (question: string) => ({ question, header: "", options: [], multiSelect: false });
    const asking = { ...base, questions: [q("Who?"), q("Where?")] };
    expect(sproutNotice(asking, { status: "clarifying", asking: false })).toEqual({ to: "human", text: "Coin counter: 2 questions before research, in canopy's inbox" });
    expect(sproutNotice(asking, { status: "clarifying", asking: true })).toBeNull();
  });
  test("a park is a DM with why; going live or being turned down goes to the channel", () => {
    expect(sproutNotice({ ...base, status: "parked", parked: "the scout workflow is not installed" }, { status: "clarifying", asking: false })).toEqual({
      to: "human",
      text: "Coin counter is parked: the scout workflow is not installed",
    });
    expect(sproutNotice({ ...base, status: "live" }, { status: "deploying", asking: false })?.to).toBe("channel");
    expect(sproutNotice({ ...base, status: "rejected" }, { status: "researching", asking: false })?.text).toBe("Coin counter was turned down at eval");
    expect(sproutNotice({ ...base, status: "handed-off" }, { status: "deploying", asking: false })).toEqual({ to: "channel", text: "Coin counter is handed off as a branch" });
  });
  test("every other move is quiet", () => {
    expect(sproutNotice({ ...base, status: "researching" }, { status: "queued", asking: false })).toBeNull();
    expect(sproutNotice({ ...base, status: "parked", parked: "x" }, { status: "parked", asking: false })).toBeNull();
  });
  test("a retro that left lessons is a channel line once; one with none, a failed one or an old one is quiet", () => {
    const retro = { for: "end" as const, state: "done" as const, at: 1, endedAt: 1_000_000, flowsSeen: 1, tries: 1, advice: [{ key: "a", lesson: "A." }, { key: "b", lesson: "B." }] };
    const s: Sprout = { ...base, status: "live", retro };
    const now = 1_000_000 + 60_000;
    expect(retroNotice(s, { retro: "running" }, now)).toEqual({ to: "channel", text: "Coin counter: the retro left 2 lessons, in canopy's inbox" });
    expect(retroNotice(s, { retro: "done" }, now)).toBeNull();
    expect(retroNotice({ ...s, retro: { ...retro, advice: [] } }, { retro: "running" }, now)).toBeNull();
    expect(retroNotice({ ...s, retro: { ...retro, state: "failed", reason: "x" } }, { retro: "running" }, now)).toBeNull();
    // not seen since a restart: a fresh end is told, an old one is not
    expect(retroNotice(s, undefined, now)?.to).toBe("channel");
    expect(retroNotice(s, undefined, now + 3_600_000)).toBeNull();
  });
});

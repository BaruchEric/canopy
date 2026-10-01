import { describe, expect, test } from "bun:test";
import type { AgentCard, Ask, Flow, Repo, Run } from "../../src/core/types";
import {
  askWord,
  asksOf,
  detailText,
  endingWord,
  inboxTitle,
  leftWord,
  mergeAsks,
  mergeInbox,
  inboxTick,
  recentAsks,
  replaceAsks,
  toAskAnswer,
  toRunAnswer,
} from "./inbox";

const ask = (over: Partial<Ask> = {}): Ask => ({
  id: "a1",
  agent: "claude:s1",
  handle: "app-0123",
  node: "macmini-2018",
  kind: "permission",
  tool: "Bash",
  title: "Bash: rm -rf build",
  detail: JSON.stringify({ command: "rm -rf build" }),
  route: "remote",
  waitUntil: 160_000,
  state: "open",
  createdAt: 100_000,
  ...over,
});

const card: AgentCard = {
  id: "claude:s1",
  handle: "app-0123",
  node: "macmini-2018",
  harness: "claude",
  session: "s1",
  origin: "canopy-shell",
  cwd: "/dev/app",
  repo: "https://github.com/me/app",
  branch: "main",
  model: null,
  mode: null,
  state: "waiting",
  waiting: "Bash",
  caps: [],
  offers: [],
  notifyIdle: false,
  where: { os: "linux", container: true, pid: 4, term: null, canopy: { backend: "mini", term: "0123" } },
  transcript: null,
  startedAt: 1,
  seenAt: 2,
  endedAt: null,
};

const repo = (id: string, extra: Partial<Repo> = {}): Repo => ({ id, name: id.split("|").pop() ?? id, path: `/dev/${id}`, group: "", source: "launch", status: null, ...extra });

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  repoId: "app",
  action: "ask",
  verb: "tidy",
  progress: "",
  expectsChange: true,
  chat: false,
  harness: "claude",
  note: "",
  status: "waiting",
  startedAt: 50_000,
  steps: [{ id: "s", at: 120_000, kind: "tool", tool: { name: "Bash", title: "ls", status: "running" } }],
  prompt: { id: "p1", kind: "permission", tool: "Bash", title: "run ls", detail: "ls -la" },
  ...over,
});

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: "mac|f1",
  repoId: "mac|lib",
  workflow: "ship",
  verb: "ship",
  note: "",
  status: "gated",
  steps: [{ name: "test", status: "gated", runId: "fr", reason: "the check failed" }],
  current: 0,
  startedAt: 10_000,
  ...over,
});

const repos = [repo("app", { link: "https://github.com/me/app", remotes: ["git@github.com:me/app.git"] }), repo("mac|lib")];
const ctx = { repos, cards: { "claude:s1": card }, backendOf: (id: string) => (id.includes("|") ? id.split("|")[0]! : "mini") };

describe("mergeInbox", () => {
  test("open asks, waiting runs and gated flows, oldest first", () => {
    const items = mergeInbox(
      [ask(), ask({ id: "a2", state: "answered", createdAt: 1 })],
      { r1: run(), r2: run({ id: "r2", status: "working", prompt: null }), fr: run({ id: "fr", status: "done", prompt: null, endedAt: 90_000 }) },
      { "mac|f1": flow() },
      130_000,
      ctx,
    );
    expect(items.map((i) => i.key)).toEqual(["flow:mac|f1", "ask:a1", "run:r1"]);
    const [gate, a, r] = items;
    expect(gate).toMatchObject({ source: "flow", kind: "gate", who: "ship", repo: "lib", where: "canopy workflow on mac", title: 'waits at a gate after "test"', detail: "the check failed", at: 90_000, left: null });
    expect(a).toMatchObject({ source: "ask", kind: "permission", who: "app-0123", repoId: "app", repo: "app", where: "canopy shell on mini", left: 30_000, until: 160_000 });
    expect(r).toMatchObject({ source: "run", kind: "permission", who: "claude tidy", where: "canopy run on mini", title: "run ls", detail: "ls -la", promptId: "p1", at: 120_000 });
  });

  test("a flow's step run is named by its flow, a question by its first question", () => {
    const q = run({ id: "fr", prompt: { id: "p2", kind: "question", questions: [{ question: "Which?", header: "", options: [], multiSelect: false }] } });
    const items = mergeInbox([], { fr: q }, { "mac|f1": flow({ status: "waiting" }) }, 0, ctx);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ who: "ship · test", kind: "question", title: "question: Which?", questions: q.prompt?.kind === "question" ? q.prompt.questions : [] });
  });

  test("an ask from an agent the registry does not know says where by its node", () => {
    const [a] = mergeInbox([ask({ agent: "codex:x", handle: "" })], {}, {}, 0, { repos, cards: {} });
    expect(a).toMatchObject({ who: "codex:x", where: "on macmini-2018", repo: "", repoId: null });
  });

  test("an ask past its wait is at zero, not below", () => {
    expect(mergeInbox([ask()], {}, {}, 999_999, ctx)[0]?.left).toBe(0);
  });
});

describe("words", () => {
  test("askWord", () => {
    expect(askWord(ask())).toBe("asks to use Bash");
    expect(askWord(ask({ kind: "question" }))).toBe("has a question");
    expect(askWord(ask({ kind: "guard", tool: null }))).toBe("hit a guard on a tool");
  });

  test("endingWord says who answered and where", () => {
    expect(endingWord(ask({ state: "answered", answer: { behavior: "allow" }, answeredBy: "Erics-Phone@canopy" }))).toBe("allowed by Erics-Phone@canopy");
    expect(endingWord(ask({ state: "answered", answer: { behavior: "allow", always: true }, answeredBy: "x@canopy" }))).toBe("allowed always by x@canopy");
    expect(endingWord(ask({ state: "answered", answer: { behavior: "deny" } }))).toBe("denied");
    expect(endingWord(ask({ kind: "question", state: "answered", answer: { behavior: "allow", answers: {} }, answeredBy: "p@c" }))).toBe("answered by p@c");
    expect(endingWord(ask({ state: "expired" }))).toBe("expired to the terminal");
    expect(endingWord(ask({ kind: "guard", state: "expired" }))).toBe("expired, so the guard held it");
    expect(endingWord(ask({ state: "withdrawn", why: "terminal" }))).toBe("answered at the terminal");
    expect(endingWord(ask({ state: "withdrawn", why: "ended" }))).toBe("session ended");
    expect(endingWord(ask({ state: "withdrawn" }))).toBe("withdrawn");
    expect(endingWord(ask({ state: "local" }))).toBe("asked at the terminal");
  });

  test("leftWord counts down to the terminal", () => {
    expect(leftWord(45_000, "permission")).toBe("0:45 left");
    expect(leftWord(29 * 60_000 + 12_000, "permission")).toBe("29:12 left");
    expect(leftWord(3_600_000 + 5_000, "question")).toBe("1:00:05 left");
    expect(leftWord(0, "permission")).toBe("going back to the terminal…");
    expect(leftWord(-5, "guard")).toBe("about to be held");
    expect(leftWord(null, "gate")).toBe("");
  });

  test("inboxTitle lists what waits", () => {
    expect(inboxTitle([])).toBe("Nothing is waiting on you");
    const items = mergeInbox([ask()], {}, {}, 0, ctx);
    expect(inboxTitle(items)).toBe("1 waiting on you\napp-0123 in app: Bash: rm -rf build");
  });

  test("detailText shows a command as a command", () => {
    expect(detailText(JSON.stringify({ command: "ls -la" }))).toBe("ls -la");
    expect(detailText(JSON.stringify({ command: "ls", description: "list" }))).toBe("# list\nls");
    expect(detailText(JSON.stringify({ command: ["git", "status"] }))).toBe("git status");
    expect(detailText(JSON.stringify({ file_path: "/x" }))).toBe('{\n  "file_path": "/x"\n}');
    expect(detailText("plain words")).toBe("plain words");
  });
});

describe("answers go back the way the item came", () => {
  test("a run's", () => {
    expect(toRunAnswer({ behavior: "allow" })).toEqual({ kind: "allow" });
    expect(toRunAnswer({ behavior: "allow", always: true })).toEqual({ kind: "allow-all" });
    expect(toRunAnswer({ behavior: "deny", message: "no" })).toEqual({ kind: "deny" });
    expect(toRunAnswer({ answers: { q: "a" } })).toEqual({ kind: "answers", answers: { q: "a" } });
    expect(toRunAnswer({ choice: "continue" })).toBeNull();
  });
  test("the broker's", () => {
    expect(toAskAnswer({ behavior: "allow", always: true })).toEqual({ behavior: "allow", always: true });
    expect(toAskAnswer({ behavior: "deny", message: "  not now " })).toEqual({ behavior: "deny", message: "not now" });
    expect(toAskAnswer({ behavior: "deny", message: "  " })).toEqual({ behavior: "deny" });
    expect(toAskAnswer({ answers: { q: "a" } })).toEqual({ behavior: "allow", answers: { q: "a" } });
    expect(toAskAnswer({ choice: "stop" })).toBeNull();
  });
});

describe("the open inbox's clock", () => {
  test("by the second while an ask counts down, else slower, but never still", () => {
    expect(inboxTick([{ until: 5 }, { until: null }])).toBe(1_000);
    expect(inboxTick([{ until: null }])).toBe(15_000);
    expect(inboxTick([])).toBe(15_000);
  });
});

describe("holding asks", () => {
  test("mergeAsks never lets an open reading undo a close", () => {
    const held = { a1: ask({ state: "answered" }) };
    expect(mergeAsks(held, [ask()])).toBe(held);
    const next = mergeAsks(held, [ask({ id: "a2" })], ["a1"]);
    expect(Object.keys(next)).toEqual(["a2"]);
    expect(mergeAsks(held, [], ["nope"])).toBe(held);
  });

  test("a whole list read never reopens a close an event brought, nor drops what an event brought while it was on its way", () => {
    const held = { a1: ask({ state: "answered" }), a3: ask({ id: "a3" }), a4: ask({ id: "a4" }) };
    // a1 closed and a3 opened by events while the list (read before both) was on its way
    const since = (id: string) => id === "a1" || id === "a3";
    const got = replaceAsks(held, [ask(), ask({ id: "a5" })], since);
    expect(got).toEqual({ a1: ask({ state: "answered" }), a5: ask({ id: "a5" }), a3: ask({ id: "a3" }) });
    // a4, which no event touched and the list lacks, is gone
    expect("a4" in got).toBe(false);
    // and with no events since, an open reading still never undoes a close
    expect(replaceAsks({ a1: ask({ state: "expired" }) }, [ask()])).toEqual({ a1: ask({ state: "expired" }) });
    // an ask an event said was gone stays gone
    expect(replaceAsks({}, [ask({ id: "g" })], (id) => id === "g")).toEqual({});
  });

  test("recentAsks is the closed ones, newest first, without the ones sent to the terminal at once", () => {
    const list = [ask({ id: "o" }), ask({ id: "x", state: "expired", createdAt: 5 }), ask({ id: "y", state: "answered", answeredAt: 9 }), ask({ id: "l", state: "local" })];
    expect(recentAsks(list).map((a) => a.id)).toEqual(["y", "x"]);
  });

  test("asksOf is one agent's open asks", () => {
    expect(asksOf([ask(), ask({ id: "b", agent: "codex:z" }), ask({ id: "c", state: "expired" })], "claude:s1").map((a) => a.id)).toEqual(["a1"]);
  });
});

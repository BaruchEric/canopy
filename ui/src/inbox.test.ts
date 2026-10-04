import { describe, expect, test } from "bun:test";
import type { AdviceOffer, AgentCard, Ask, Flow, Repo, Run, Sprout } from "../../src/core/types";
import {
  askPermission,
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
  scopeOffers,
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

  test("a run's permission carries what it asked, its project folder and its flow step", () => {
    const p = { id: "p1", kind: "permission" as const, tool: "Bash", title: "ls", detail: "ls", command: "ls", description: "List files" };
    const [plain] = mergeInbox([], { r1: run({ prompt: p }) }, {}, 0, ctx);
    expect(plain).toMatchObject({ permission: p, repoPath: "/dev/app" });
    expect(plain?.flowStep).toBeUndefined();
    // the run's own word wins; a flow's step is the fallback for an older server
    const [stepped] = mergeInbox([], { fr: run({ id: "fr", repoId: "mac|lib", prompt: p }) }, { "mac|f1": flow({ status: "waiting" }) }, 0, ctx);
    expect(stepped?.flowStep).toEqual({ workflow: "ship", step: "test" });
    const [named] = mergeInbox([], { r1: run({ prompt: p, flowStep: { workflow: "scout", step: "Eval" } }) }, {}, 0, ctx);
    expect(named?.flowStep).toEqual({ workflow: "scout", step: "Eval" });
    // a remote repo's folder is not this machine's
    const [remote] = mergeInbox([], { r1: run({ prompt: p }) }, {}, 0, { ...ctx, repos: [repo("app", { host: "mini" })] });
    expect(remote?.repoPath).toBeUndefined();
  });

  test("scopeOffers: a flow step's run offers its step first, then its workflow, then the repo", () => {
    expect(scopeOffers({ repo: "seed-1", repoPath: "/dev/_incubator/seed-1", flowStep: { workflow: "scout", step: "Eval" } })).toEqual([
      { kind: "step", label: "scout · Eval, in every project" },
      { kind: "workflow", label: "every step of scout" },
      { kind: "repo", label: "runs in seed-1" },
    ]);
    expect(scopeOffers({ repo: "app" })).toEqual([{ kind: "repo", label: "runs in app" }]);
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

  test("askPermission reads an ask's tool input for the plain words", () => {
    expect(askPermission(ask({ detail: JSON.stringify({ command: "rm -rf build", description: "Clear the build" }) }))).toEqual({
      kind: "permission",
      tool: "Bash",
      title: "Bash: rm -rf build",
      detail: JSON.stringify({ command: "rm -rf build", description: "Clear the build" }),
      command: "rm -rf build",
      description: "Clear the build",
    });
    expect(askPermission(ask({ tool: "Edit", title: "Edit: a.ts", detail: JSON.stringify({ file_path: "/dev/app/a.ts" }) }))).toMatchObject({
      tool: "Edit",
      paths: ["/dev/app/a.ts"],
    });
    expect(askPermission(ask({ detail: "not json" }))).toMatchObject({ tool: "Bash" });
    expect(askPermission(ask({ detail: "not json" }))?.command).toBeUndefined();
    expect(askPermission(ask({ tool: null }))).toBeUndefined();
    expect(askPermission(ask({ kind: "guard" }))).toBeUndefined();
  });

  test("an ask's item carries its permission", () => {
    const [item] = mergeInbox([ask()], {}, {}, 0, ctx);
    expect(item?.permission?.command).toBe("rm -rf build");
  });
});

describe("answers go back the way the item came", () => {
  test("a run's", () => {
    expect(toRunAnswer({ behavior: "allow" })).toEqual({ kind: "allow" });
    expect(toRunAnswer({ behavior: "allow", always: true })).toEqual({ kind: "allow-all" });
    expect(toRunAnswer({ behavior: "allow", remember: { rule: "Bash(ls:*)", scope: "step" } })).toEqual({ kind: "allow", remember: { rule: "Bash(ls:*)", scope: "step" } });
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

describe("the incubator in the inbox", () => {
  const sprout: Sprout = {
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
    questions: [{ question: "Who counts?", header: "", options: [], multiSelect: false }],
    questionsAt: 20_000,
    flows: [],
    spent: { runs: 0, workMs: 0 },
    createdAt: 0,
    updatedAt: 0,
  };
  test("open questions are one clarify item; a sprout without them is none", () => {
    const items = mergeInbox([], {}, {}, 30_000, { ...ctx, sprouts: [sprout, { ...sprout, id: "sp_000000000002", questions: [] }] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "sprout:sp_000000000001", source: "sprout", kind: "clarify", who: "clarify", repo: "Coin counter", where: "canopy incubator", title: "1 question before research", at: 20_000 });
    expect(items[0]?.questions?.[0]?.question).toBe("Who counts?");
  });
  test("a park with no gated flow behind it is one park item; a gated flow's park stays the flow's", () => {
    const parked: Sprout = { ...sprout, status: "parked", parked: "add VERCEL_TOKEN to mini's .env", questions: [], updatedAt: 25_000, flows: [{ workflow: "build-new", flowId: "fb", outcome: "done" }] };
    const items = mergeInbox([], {}, {}, 30_000, { ...ctx, sprouts: [parked] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "sprout:sp_000000000001", source: "sprout", kind: "park", who: "incubator", repo: "Coin counter", title: "is parked", detail: "add VERCEL_TOKEN to mini's .env", at: 25_000 });
    const behind: Sprout = { ...parked, flows: [{ workflow: "scout", flowId: "fs" }] };
    const gated = mergeInbox([], {}, { fs: flow({ id: "fs", status: "gated" }) }, 30_000, { ...ctx, sprouts: [behind] });
    expect(gated.map((i) => i.source)).toEqual(["flow"]);
  });
  test("a hand-off waiting for a yes is one item with its head, the flagged changes first in its detail", () => {
    const handOff = {
      head: "h".repeat(40),
      base: "b".repeat(40),
      remote: "https://github.com/eric/clms.git",
      branch: "new/coin",
      commits: [{ sha: "c".repeat(40), subject: "count coins" }],
      moreCommits: 0,
      files: [{ path: ".github/workflows/ci.yml", added: 4, removed: 0 }],
      moreFiles: 0,
      flagged: [".github/workflows/ci.yml: GitHub Actions or repo settings"],
      at: 27_000,
    };
    const waiting: Sprout = { ...sprout, status: "approving", questions: [], handOff };
    const items = mergeInbox([], {}, {}, 30_000, { ...ctx, sprouts: [waiting] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "sprout:sp_000000000001", kind: "hand-off", who: "hand-off", title: "waits for your yes to push new/coin, 1 change to look at first", head: "h".repeat(40), at: 27_000 });
    expect(items[0]?.detail.split("\n")[3]).toBe("! .github/workflows/ci.yml: GitHub Actions or repo settings");
    expect(toRunAnswer({ handOff: true })).toBeNull();
    expect(toAskAnswer({ handOff: true })).toBeNull();
  });
  test("a gate a budget parked says so", () => {
    const items = mergeInbox([], {}, { f: flow({ id: "f", parkedFor: "budget" }) }, 30_000, ctx);
    expect(items[0]?.budget).toBe(true);
  });
  test("a gate the stage runner's absence parked says so, and is no budget", () => {
    const items = mergeInbox([], {}, { f: flow({ id: "f", parkedFor: "stage" }) }, 30_000, ctx);
    expect(items[0]?.stage).toBe(true);
    expect(items[0]?.budget).toBeUndefined();
    expect(items[0]?.stageCheck).toBeUndefined();
    const check = mergeInbox([], {}, { f: flow({ id: "f", parkedFor: "stage", stageCheck: true }) }, 30_000, ctx);
    expect(check[0]).toMatchObject({ stage: true, stageCheck: true });
  });
  test("going on assumptions is no answer to a run or an ask", () => {
    expect(toRunAnswer({ skip: true })).toBeNull();
    expect(toAskAnswer({ skip: true })).toBeNull();
  });
  test("retro advice on offer is one item; none on offer is none, and its answer goes to no run or ask", () => {
    const offer = (key: string, lastAt: number): AdviceOffer => ({ key, lesson: `Lesson ${key}.`, count: 2, titles: ["Coin counter"], lastAt });
    expect(mergeInbox([], {}, {}, 30_000, { ...ctx, advice: [] })).toEqual([]);
    const items = mergeInbox([], {}, {}, 30_000, { ...ctx, advice: [offer("a", 12_000), offer("b", 9_000)] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "advice:incubator", source: "advice", kind: "advice", who: "retro", repo: "", where: "canopy incubator", title: "2 lessons from retros", at: 9_000 });
    expect(items[0]?.advice?.map((o) => o.key)).toEqual(["a", "b"]);
    expect(mergeInbox([], {}, {}, 30_000, { ...ctx, advice: [offer("a", 1)] })[0]?.title).toBe("1 lesson from retros");
    expect(toRunAnswer({ advice: "a", accept: true })).toBeNull();
    expect(toAskAnswer({ advice: "a", accept: false })).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import type { AgentCard, Repo, RepoStatus, TermInfo } from "../../src/core/types";
import { split, type Reg } from "./backends";
import { agentRows, heldShellAt, machinesOf, nextWaitingRow, pickRepos, sessionsKey, showingIn, stepTab, tabsIn, untabbed } from "./sessions";
import type { TermTab } from "./term";

const reg: Reg = { home: "mac", names: ["mac", "mini"] };
const backendOf = (id: string) => split(reg, id)[0];

function status(over: Partial<RepoStatus> = {}): RepoStatus {
  return { branch: "main", upstream: null, ahead: 0, behind: 0, files: [], lastCommit: null, user: null, ...over };
}

function repo(id: string, path: string, over: Partial<Repo> = {}): Repo {
  return { id, name: path.slice(path.lastIndexOf("/") + 1), path, group: "", source: "launch", status: status(), ...over };
}

function shell(id: string, repoId: string, over: Partial<TermInfo> = {}): TermInfo {
  return { id, repoId, path: "", place: "strip", attached: true, viewers: [], startedAt: 1, ...over };
}

const tab = (id: string, repoId: string, over: Partial<TermTab> = {}): TermTab => ({ id, repoId, name: repoId, path: "", place: "strip", ...over });

let n = 0;
function card(over: Partial<AgentCard> = {}): AgentCard {
  n++;
  return {
    id: `claude:s${n}`,
    handle: "",
    node: "ericmac",
    harness: "claude",
    session: `s${n}`,
    origin: "elsewhere",
    cwd: "/Users/e/dev/app",
    repo: null,
    branch: "main",
    model: null,
    mode: null,
    state: "idle",
    waiting: null,
    caps: [],
    offers: [],
    notifyIdle: false,
    where: { os: "darwin", container: false, pid: 40 + n, term: null, canopy: null },
    transcript: null,
    startedAt: 1_000 + n,
    seenAt: 2_000,
    endedAt: null,
    ...over,
  };
}

const app = repo("app", "/Users/e/dev/app");
const notes = repo("notes", "/Users/e/dev/notes");
const starred = repo("star", "/Users/e/dev/star", { favorite: true, status: status({ branch: "wip" }) });
const dirty = repo("dirt", "/Users/e/dev/dirt", { favorite: true, status: status({ files: [{ path: "a", index: "M", work: " " } as never] }) });
const miniApp = repo("mini|app", "/home/bun/dev/app");
const repos = [app, notes, starred, dirty, miniApp];
const base = { home: "mac", shown: ["mini"], repos, shells: [], tabs: [], cards: [], backendOf };

describe("the machines tree", () => {
  test("home first, then the others; a backend with nothing worth a row still shows", () => {
    const m = machinesOf(base);
    expect(m.map((x) => [x.name, x.home])).toEqual([
      ["mac", true],
      ["mini", false],
    ]);
    expect(m[1]?.repos).toEqual([]);
  });

  test("a row for a shell, a starred repo, or the one kept; sorted by name", () => {
    const m = machinesOf({ ...base, shells: [shell("t1", "notes")] }, ["app"]);
    expect(m[0]?.repos.map((r) => r.id)).toEqual(["app", "dirt", "notes", "star"]);
    expect(m[0]?.repos.find((r) => r.id === "star")?.branch).toBe("wip");
  });

  test("a task's session and the ranger are not shells", () => {
    const m = machinesOf({ ...base, shells: [shell("t1", "notes", { task: "dev" }), shell("t2", "app", { ranger: true })] });
    expect(m[0]?.repos.map((r) => r.id)).toEqual(["dirt", "star"]);
  });

  test("a tab the backend has not reported yet counts once", () => {
    const m = machinesOf({ ...base, shells: [shell("t1", "notes")], tabs: [tab("t1", "notes"), tab("t2", "notes")] });
    expect(m[0]?.repos.find((r) => r.id === "notes")?.shells).toBe(2);
  });

  test("tones: waiting beats working beats a shell beats changes", () => {
    const m = machinesOf({
      ...base,
      shells: [shell("t1", "notes")],
      cards: [card({ state: "working" }), card({ state: "waiting" }), card({ cwd: "/Users/e/dev/star/sub", state: "working" })],
    });
    const tone = (id: string) => m[0]?.repos.find((r) => r.id === id)?.tone;
    expect(tone("app")).toBe("waiting");
    expect(tone("star")).toBe("working");
    expect(tone("notes")).toBe("live");
    expect(tone("dirt")).toBe("dirty");
    expect(m[0]?.tone).toBe("waiting");
    expect(m[1]?.tone).toBe("quiet");
  });

  test("a canopy card lands only on its own backend; others match by folder", () => {
    const onMini = card({ cwd: "/home/bun/dev/app", where: { os: "linux", container: true, pid: 1, term: null, canopy: { backend: "mini", term: "x" } } });
    const elsewhere = card({ cwd: "/home/bun/dev/app" });
    const ended = card({ state: "ended" });
    const m = machinesOf({ ...base, cards: [onMini, elsewhere, ended] });
    expect(m[0]?.repos.some((r) => r.id === "app")).toBe(false);
    expect(m[1]?.repos.map((r) => [r.id, r.agents])).toEqual([["mini|app", 2]]);
  });
});

describe("a repo row's held shell", () => {
  test("a strip shell before a panel one, newest first; never one with a tab here, a task or the ranger", () => {
    const shells = [
      shell("p", "app", { place: "panel", startedAt: 9 }),
      shell("s1", "app", { startedAt: 1 }),
      shell("s2", "app", { startedAt: 5 }),
      shell("t", "app", { task: "dev", startedAt: 10 }),
      shell("r", "app", { ranger: true, startedAt: 11 }),
      shell("o", "notes", { startedAt: 12 }),
    ];
    expect(heldShellAt("app", shells, [])?.id).toBe("s2");
    expect(heldShellAt("app", shells, [{ id: "s2" }])?.id).toBe("s1");
    expect(heldShellAt("app", shells, [{ id: "s1" }, { id: "s2" }])?.id).toBe("p");
    expect(heldShellAt("app", shells, [{ id: "s1" }, { id: "s2" }, { id: "p" }])).toBeNull();
    expect(heldShellAt("beta", shells, [])).toBeNull();
  });
});

describe("the agents list", () => {
  test("live agents only, waiting first", () => {
    const idle = card({ state: "idle" });
    const wait = card({ state: "waiting" });
    const done = card({ state: "ended" });
    expect(agentRows([idle, done, wait]).map((c) => c.id)).toEqual([wait.id, idle.id]);
  });

  test("next waiting wraps and skips the rest", () => {
    const a = card({ state: "waiting" });
    const b = card({ state: "working" });
    const c = card({ state: "waiting" });
    const rows = [a, b, c];
    expect(nextWaitingRow(rows, null)).toBe(a.id);
    expect(nextWaitingRow(rows, a.id)).toBe(c.id);
    expect(nextWaitingRow(rows, c.id)).toBe(a.id);
    expect(nextWaitingRow([b], null)).toBeNull();
  });
});

describe("tabs and keys", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("stepping wraps both ways; with none showing it starts at an end", () => {
    expect(stepTab(tabs, "c", 1)).toBe("a");
    expect(stepTab(tabs, "a", -1)).toBe("c");
    expect(stepTab(tabs, null, 1)).toBe("a");
    expect(stepTab(tabs, null, -1)).toBe("c");
    expect(stepTab([], "a", 1)).toBeNull();
  });

  test("keys fire only outside a field and without modifiers", () => {
    const k = (key: string, over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...over });
    expect(sessionsKey(k("]"), false)).toBe("next-tab");
    expect(sessionsKey(k("["), false)).toBe("prev-tab");
    expect(sessionsKey(k("n"), false)).toBe("new");
    expect(sessionsKey(k("w"), false)).toBe("next-waiting");
    expect(sessionsKey(k("w"), true)).toBeNull();
    expect(sessionsKey(k("n", { metaKey: true }), false)).toBeNull();
    expect(sessionsKey(k("x"), false)).toBeNull();
  });

  test("the new-shell picker puts names that start with the query first", () => {
    const list = [repo("a", "/x/canopy"), repo("b", "/x/scan"), repo("c", "/x/tally"), repo("d", "/x/canary", { forge: {} as never })];
    expect(pickRepos(list, "can").map((r) => r.name)).toEqual(["canopy", "scan"]);
    expect(pickRepos(list, "  ")).toEqual([]);
  });
});

describe("the tab row's scope", () => {
  const tabs = [tab("a", "app"), tab("b", "mini|app"), tab("c", "notes"), tab("d", "app")];

  test("every tab, one machine's, or one repo's, in order", () => {
    expect(tabsIn(tabs, null, backendOf).map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
    expect(tabsIn(tabs, { repo: "app" }, backendOf).map((t) => t.id)).toEqual(["a", "d"]);
    expect(tabsIn(tabs, { machine: "mac" }, backendOf).map((t) => t.id)).toEqual(["a", "c", "d"]);
    expect(tabsIn(tabs, { machine: "mini" }, backendOf).map((t) => t.id)).toEqual(["b"]);
  });

  test("the showing tab stays when it is in; else the last one in", () => {
    const app = tabsIn(tabs, { repo: "app" }, backendOf);
    expect(showingIn(app, "a")).toBe("a");
    expect(showingIn(app, "c")).toBe("d");
    expect(showingIn([], "c")).toBeNull();
  });
});

describe("shells with no tab here", () => {
  test("strip shells only, never a tab's, a task's or the ranger's; oldest first", () => {
    const shells = [
      shell("b", "app", { startedAt: 5 }),
      shell("a", "app", { startedAt: 1 }),
      shell("p", "app", { place: "panel" }),
      shell("t", "app", { task: "dev" }),
      shell("r", "app", { ranger: true }),
      shell("x", "app"),
    ];
    expect(untabbed(shells, [{ id: "x" }]).map((t) => t.id)).toEqual(["a", "b"]);
  });
});

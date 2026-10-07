import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PANEL_TERM,
  agentFor,
  agentsOn,
  activeFilterCount,
  canAnswer,
  archivedCount,
  cardOf,
  changed,
  closedIn,
  closedSectionsOf,
  connOf,
  favoriteCount,
  inboxItems,
  isFavorite,
  isOnline,
  layoutOf,
  loadDock,
  multi,
  panelTermHeightFor,
  pruneByRepo,
  scopedRepos,
  sectionsFor,
  setRetryFirst,
  toggleIn,
  unfoldIn,
  useStore,
  visibleCards,
  visibleRepos,
} from "./store";
import { applyQuery } from "./filters";
import { cellOf, columnOf, panelsOf, type DockLayout } from "./grid";
import { projectFront } from "./front";
import { onBackendSignal } from "./api";
import { setBase, setRegistry } from "./registry";
import { hasOtherBackend, RETRY_FIRST } from "./backends";
import {
  DEFAULT_AGENT,
  type AgentCard,
  type AgentSettings,
  type Ask,
  type KeptShell,
  type PeerSeen,
  type RememberedRule,
  type Repo,
  type ScanResult,
  type SourceState,
  type Sprout,
  type TaskInfo,
  type TermInfo,
} from "../../src/core/types";

describe("closedSectionsOf", () => {
  test("a layout from before the launch and peers sections folds them", () => {
    expect(closedSectionsOf(["search", "history", "claude"], ["search", "history", "claude"])).toEqual([
      "search",
      "history",
      "claude",
      "launch",
      "peers",
      "preview",
      "agents",
    ]);
  });
  test("a section the reader unfolded stays unfolded once the layout knows it", () => {
    const saved = ["search", "history", "claude"];
    expect(closedSectionsOf(saved, ["search", "history", "claude", "launch", "peers", "preview", "agents"])).toBe(saved);
  });
  test("a stored fold is not doubled", () => {
    expect(closedSectionsOf(["launch"], [])).toEqual(["launch", "search", "history", "claude", "peers", "preview", "agents"]);
  });
});

describe("per-repo folds", () => {
  test("a repo nobody has touched folds the defaults", () => {
    expect(sectionsFor({}, "a")).toEqual(["search", "history", "claude", "launch", "peers", "preview", "agents"]);
    expect(closedIn({ closedSections: {} }, "a", "history")).toBe(true);
    expect(closedIn({ closedSections: {} }, "a", "changes")).toBe(false);
  });
  test("a toggle touches one repo and leaves the rest alone", () => {
    const one = toggleIn({}, "a", "history");
    expect(sectionsFor(one, "a")).toEqual(["search", "claude", "launch", "peers", "preview", "agents"]);
    expect(sectionsFor(one, "b")).toEqual(["search", "history", "claude", "launch", "peers", "preview", "agents"]);
    const two = toggleIn(one, "a", "changes");
    expect(closedIn({ closedSections: two }, "a", "changes")).toBe(true);
    expect(closedIn({ closedSections: two }, "b", "changes")).toBe(false);
  });
  test("unfolding hands back the same object when nothing is folded", () => {
    const closed = { a: ["search"] };
    expect(unfoldIn(closed, "a", "history")).toBe(closed);
    expect(sectionsFor(unfoldIn(closed, "a", "search"), "a")).toEqual([]);
    expect(sectionsFor(unfoldIn({}, "b", "launch"), "b")).toEqual(["search", "history", "claude", "peers", "preview", "agents"]);
  });
});

describe("changed", () => {
  test("names only the fields whose value moved", () => {
    const arr = ["x"];
    expect(changed({ a: 1, b: arr, c: null }, { a: 1, b: arr, c: null })).toEqual({});
    expect(changed({ a: 2, b: ["x"], c: null }, { a: 1, b: arr, c: null })).toEqual({ a: 2, b: ["x"] });
  });
});

describe("pruneByRepo", () => {
  const repos = [{ id: "a" }, { id: "b" }] as Repo[];
  test("drops the entries whose repo left the scan", () => {
    expect(pruneByRepo({ a: 1, gone: 2 }, repos)).toEqual({ a: 1 });
  });
  test("is the same object when every entry still has a repo", () => {
    const map = { a: ["search"], b: [] };
    expect(pruneByRepo(map, repos)).toBe(map);
  });
});

describe("panelTermHeightFor", () => {
  test("a repo's own height, else the default", () => {
    expect(panelTermHeightFor({ panelTermHeights: { a: 240 } }, "a")).toBe(240);
    expect(panelTermHeightFor({ panelTermHeights: { a: 240 } }, "b")).toBe(PANEL_TERM.initial);
  });
});

describe("moving a panel", () => {
  const pristine = useStore.getState();
  afterEach(() => useStore.setState({ panels: pristine.panels, activePanel: pristine.activePanel }));
  test("movePanel reorders the open panels and keeps the active one", () => {
    useStore.setState({ panels: ["a", "b", "c"], activePanel: "b" });
    useStore.getState().movePanel("c", 0);
    expect(useStore.getState().panels).toEqual(["c", "a", "b"]);
    expect(useStore.getState().activePanel).toBe("b");
  });
});

describe("shells this window ends or restores", () => {
  const app = { id: "app", name: "app", path: "/dev/app", group: "", source: "launch", status: null } as unknown as Repo;
  const tab = (id: string, exit?: number | null) => ({ id, repoId: "app", name: "app", path: "/dev/app", place: "strip" as const, ...(exit === undefined ? {} : { exit }) });
  const info = (id: string): TermInfo => ({ id, repoId: "app", path: "/dev/app", place: "strip", attached: false, viewers: [], startedAt: 1 });
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const answer = (body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    calls.length = 0;
  });

  test("a closed tab is not taken back from a list that still names its shell", () => {
    globalThis.fetch = answer({ ok: true });
    const closing = "c".repeat(32);
    const other = "d".repeat(32);
    useStore.setState({ repos: [app], panels: [], terms: [tab(closing)], activeTerm: closing });
    useStore.getState().closeTerm(closing);
    expect(calls).toEqual([`DELETE /api/terms?term=${closing}`]);
    // the list the closing socket set off, which the server sent before the end landed
    useStore.getState().applyEvent({ type: "terms", terms: [info(closing), info(other)] });
    expect(useStore.getState().terms.map((t) => t.id)).toEqual([other]);
  });

  test("restoring over a tab whose shell went starts that tab's view over", async () => {
    const id = "e".repeat(32);
    const kept: KeptShell = { id, repoId: "app", path: "/dev/app", place: "strip", startedAt: 1, savedAt: 2, lines: 3, agent: null };
    globalThis.fetch = answer({ ...info(id), restoredAt: 3 });
    useStore.setState({ repos: [app], panels: [], terms: [tab(id, 1)], kept: [kept], activeTerm: id });
    await useStore.getState().restoreShell(id);
    const after = useStore.getState().terms.find((t) => t.id === id);
    expect(after?.exit).toBeUndefined();
    expect(after?.gen).toBe(1);
    expect(useStore.getState().kept).toEqual([]);
  });

  test("closing a task tab sends no DELETE, and a click revives an ended one", () => {
    globalThis.fetch = answer({ ok: true });
    const id = "a".repeat(32);
    const def = { name: "dev", termId: id, live: true } as unknown as TaskInfo;
    useStore.setState({ repos: [app], panels: [], terms: [], hiddenTerms: [], activeTerm: null });
    useStore.getState().openTaskTab("app", def, "strip");
    expect(useStore.getState().terms[0]).toMatchObject({ id, task: "dev" });
    useStore.getState().endTerm(id, null);
    useStore.getState().openTaskTab("app", def, "strip");
    const revived = useStore.getState().terms.find((t) => t.id === id);
    expect(revived?.exit).toBeUndefined();
    expect(revived?.gen).toBe(1);
    useStore.getState().closeTerm(id);
    expect(calls).toEqual([]);
    expect(useStore.getState().terms).toEqual([]);
  });

  test("closing a panel leaves its shells running and its reopening brings them back", () => {
    globalThis.fetch = answer({ ok: true });
    const shell = "f".repeat(32);
    const panelTab = { id: shell, repoId: "app", name: "app", path: "/dev/app", place: "panel" as const };
    const held: TermInfo = { ...info(shell), place: "panel" };
    useStore.setState({ repos: [app], panels: ["app"], activePanel: "app", terms: [panelTab], shells: [held], hiddenTerms: [] });
    useStore.getState().closePanel("app");
    // opening the panel may ask to start its tasks; closing it ends nothing
    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    expect(useStore.getState().terms).toEqual([]);
    // the server still lists it; with its panel closed it waits
    useStore.getState().applyEvent({ type: "terms", terms: [held] });
    expect(useStore.getState().terms).toEqual([]);
    useStore.getState().openPanel("app");
    expect(useStore.getState().terms.map((t) => t.id)).toEqual([shell]);
  });
});

describe("popping a panel out and back", () => {
  const app = { id: "app", name: "app", path: "/dev/app", group: "", source: "launch", status: null } as unknown as Repo;
  const shell = "9".repeat(32);
  const panelTab = { id: shell, repoId: "app", name: "app", path: "/dev/app", place: "panel" as const };
  const held: TermInfo = { id: shell, repoId: "app", path: "/dev/app", place: "panel", attached: false, viewers: [], startedAt: 1 };
  const realFetch = globalThis.fetch;
  const g = globalThis as unknown as { window?: unknown };
  beforeEach(() => {
    // opening a panel asks to start its tasks
    globalThis.fetch = (async () => new Response(JSON.stringify({ tasks: [], errors: [] }), { status: 200 })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete g.window;
    useStore.setState({ repos: [], panels: [], activePanel: null, terms: [], shells: [], hiddenTerms: [], popped: {}, recalled: [], loaded: false });
  });
  /** a window whose window.open answers with `win`, recording each call */
  const stubWindow = (win: { focus: () => void } | null) => {
    const opened: { url: string; name: string }[] = [];
    g.window = {
      location: { href: "http://a.test/", search: "" },
      open: (url: string, name: string) => {
        opened.push({ url, name });
        return win;
      },
    };
    return opened;
  };

  test("pop out opens the panel's own window, then takes it out of the dock with its slot", () => {
    const opened = stubWindow({ focus: () => {} });
    useStore.setState({ repos: [app], panels: ["x", "app", "y"], activePanel: "app", terms: [panelTab], shells: [held], hiddenTerms: [], popped: {} });
    useStore.getState().popOut("app");
    const s = useStore.getState();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.name).toBe("canopy:pop:app");
    const u = new URL(opened[0]?.url ?? "");
    expect([u.searchParams.get("repo"), u.searchParams.get("view"), u.searchParams.get("popped")]).toEqual(["app", "solo", "1"]);
    expect(s.panels).toEqual(["x", "y"]);
    expect(s.popped).toEqual({ app: 1 });
    // the shell runs on, held, with no tab in the dock
    expect(s.terms).toEqual([]);
    expect(s.shells).toEqual([held]);
  });

  test("a blocked pop-out leaves the panel where it was", () => {
    stubWindow(null);
    useStore.setState({ repos: [app], panels: ["x", "app", "y"], activePanel: "app", terms: [panelTab], shells: [held], hiddenTerms: [], popped: {} });
    useStore.getState().popOut("app");
    const s = useStore.getState();
    expect(s.panels).toEqual(["x", "app", "y"]);
    expect(s.popped).toEqual({});
    expect(s.terms).toEqual([panelTab]);
  });

  test("returning puts the panel back at its slot, in front, with its shell", () => {
    useStore.setState({ repos: [app], panels: ["x", "y"], activePanel: "x", terms: [], shells: [held], hiddenTerms: [], popped: { app: 1 } });
    useStore.getState().returnPanel("app");
    const s = useStore.getState();
    expect(s.panels).toEqual(["x", "app", "y"]);
    expect(s.popped).toEqual({});
    expect(s.activePanel).toBe("app");
    expect(s.terms.map((t) => t.id)).toEqual([shell]);
    // a panel no window popped is not this one's to bring back
    useStore.getState().returnPanel("x");
    expect(useStore.getState().panels).toEqual(["x", "app", "y"]);
  });

  test("a pop-out shows its own panel's shells, a plain solo window none", () => {
    const lib = { ...app, id: "lib", name: "lib", path: "/dev/lib" } as unknown as Repo;
    const theirs: TermInfo = { ...held, id: "8".repeat(32), repoId: "lib", path: "/dev/lib" };
    const strip: TermInfo = { ...held, id: "7".repeat(32), place: "strip" };
    const live = [held, theirs, strip];
    g.window = { location: { href: "http://a.test/?repo=app&view=solo&popped=1", search: "?repo=app&view=solo&popped=1" } };
    useStore.setState({ repos: [app, lib], panels: ["lib"], activePanel: "lib", terms: [], shells: [], hiddenTerms: [], popped: {} });
    useStore.getState().applyEvent({ type: "terms", terms: live });
    expect(useStore.getState().terms.map((t) => t.id)).toEqual([shell]);
    // the same window without the marker keeps none
    g.window = { location: { href: "http://a.test/?repo=app&view=solo", search: "?repo=app&view=solo" } };
    useStore.setState({ terms: [], shells: [] });
    useStore.getState().applyEvent({ type: "terms", terms: live });
    expect(useStore.getState().terms).toEqual([]);
  });

  test("a popped panel docked again here is no longer out, and a later bye leaves it be", () => {
    useStore.setState({ repos: [app], panels: ["x", "y"], activePanel: "x", terms: [], shells: [held], hiddenTerms: [], popped: { app: 1 } });
    useStore.getState().openPanel("app");
    expect(useStore.getState().popped).toEqual({});
    // closed in the dock, then its window goes: the panel stays closed
    useStore.getState().closePanel("app");
    useStore.getState().returnPanel("app");
    expect(useStore.getState().panels).toEqual(["x", "y"]);
    // any other way into the dock does the same (a shell, the bench)
    useStore.setState({ popped: { app: 1 } });
    useStore.getState().bringProject("app");
    expect(useStore.getState().popped).toEqual({});
  });

  test("closing a panel forgets any slot it had", () => {
    // a dock and a slot at once, as a layout from before this saved it
    useStore.setState({ repos: [app], panels: ["x", "app"], activePanel: "app", terms: [], shells: [], hiddenTerms: [], popped: { app: 1, y: 0 } });
    useStore.getState().closePanel("app");
    expect(useStore.getState().popped).toEqual({ y: 0 });
    useStore.getState().returnPanel("app");
    expect(useStore.getState().panels).toEqual(["x"]);
  });

  test("a window claiming a docked panel takes it out and keeps its slot", () => {
    useStore.setState({ repos: [app], panels: ["x", "app", "y"], activePanel: "app", terms: [panelTab], shells: [held], hiddenTerms: [], popped: {} });
    useStore.getState().claimPanel("app");
    let s = useStore.getState();
    expect(s.panels).toEqual(["x", "y"]);
    expect(s.popped).toEqual({ app: 1 });
    expect(s.terms).toEqual([]);
    expect(s.shells).toEqual([held]);
    // a claim on a panel already out changes nothing
    useStore.getState().claimPanel("app");
    s = useStore.getState();
    expect(s.panels).toEqual(["x", "y"]);
    expect(s.popped).toEqual({ app: 1 });
  });

  test("a panel docked by hand ignores the hello of its pop-out still open", () => {
    useStore.setState({ repos: [app], panels: ["x", "y"], activePanel: "x", terms: [], shells: [held], hiddenTerms: [], popped: { app: 1 } });
    useStore.getState().openPanel("app");
    expect(useStore.getState().recalled).toEqual(["app"]);
    // the old window reloads and says hello: the panel stays docked
    useStore.getState().heardHello("app");
    const s = useStore.getState();
    expect(s.panels).toEqual(["x", "y", "app"]);
    expect(s.popped).toEqual({});
  });

  test("a panel the bye timer or the sweep brought back is a later hello's again", () => {
    // a pop-out back from the back-forward cache, or one slow to reload
    useStore.setState({ repos: [app], panels: ["x", "y"], activePanel: "x", terms: [], shells: [held], hiddenTerms: [], popped: { app: 1 } });
    useStore.getState().returnPanel("app");
    expect(useStore.getState().recalled).toEqual([]);
    useStore.getState().heardHello("app");
    const s = useStore.getState();
    expect(s.panels).toEqual(["x", "y"]);
    expect(s.popped).toEqual({ app: 1 });
  });

  test("popping out again after a hand dock makes the new window's hello count", () => {
    stubWindow({ focus: () => {} });
    useStore.setState({ repos: [app], panels: ["x", "y"], activePanel: "x", terms: [], shells: [held], hiddenTerms: [], popped: { app: 1 } });
    useStore.getState().openPanel("app");
    useStore.getState().popOut("app");
    expect(useStore.getState().recalled).toEqual([]);
    expect(useStore.getState().popped).toEqual({ app: 2 });
    // its window goes into the back-forward cache, the bye returns it, Back
    useStore.getState().returnPanel("app");
    useStore.getState().heardHello("app");
    expect(useStore.getState().panels).toEqual(["x", "y"]);
  });

  test("closing a popped panel by hand also recalls it, and only a popped one", () => {
    useStore.setState({ repos: [app], panels: ["x", "app"], activePanel: "app", terms: [], shells: [], hiddenTerms: [], popped: { app: 1 } });
    useStore.getState().closePanel("x");
    expect(useStore.getState().recalled).toEqual([]);
    useStore.getState().closePanel("app");
    expect(useStore.getState().recalled).toEqual(["app"]);
  });

  test("a pop-out's close forgets its slot, so its bye brings nothing back", () => {
    useStore.setState({ repos: [app], panels: ["x", "y"], activePanel: "x", terms: [], shells: [held], hiddenTerms: [], popped: { app: 1, y: 0 } });
    useStore.getState().forgetPopped("app");
    expect(useStore.getState().popped).toEqual({ y: 0 });
    useStore.getState().returnPanel("app");
    expect(useStore.getState().panels).toEqual(["x", "y"]);
  });

  test("a home panel whose repo left the scan does not come back", () => {
    useStore.setState({ repos: [], loaded: true, panels: ["x"], activePanel: "x", terms: [], shells: [], hiddenTerms: [], popped: { app: 0 } });
    useStore.getState().returnPanel("app");
    expect(useStore.getState().panels).toEqual(["x"]);
    // before the first tree, an empty list of repos says nothing yet
    useStore.setState({ loaded: false });
    useStore.getState().returnPanel("app");
    expect(useStore.getState().panels).toEqual(["app", "x"]);
  });
});

describe("a panel's tasks start once per open, by any path", () => {
  const realFetch = globalThis.fetch;
  const started: string[] = [];
  const repo = (id: string) => ({ id, name: id, path: `/dev/${id}`, group: "", source: "launch", status: null }) as unknown as Repo;
  const settle = () => new Promise((r) => setTimeout(r, 10));
  afterEach(() => {
    globalThis.fetch = realFetch;
    started.length = 0;
  });

  test("a click, the top bar, the launch section and a restored panel each start it once", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url), "http://x");
      if (init?.method === "POST" && u.pathname === "/api/repos/tasks" && String(init.body).includes('"panel"')) started.push(u.searchParams.get("id") ?? "");
      return new Response(JSON.stringify({ tasks: [], errors: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    // a reload brings a panel back before the scan says what its repo is
    useStore.setState({ repos: [], panels: ["p-a"], activePanel: "p-a" });
    await settle();
    expect(started).toEqual([]);
    useStore.setState({ repos: ["p-a", "p-b", "p-c", "p-d"].map(repo) });
    await settle();
    expect(started).toEqual(["p-a"]);
    useStore.getState().showTasks("p-b");
    useStore.getState().showLaunch("p-c");
    useStore.getState().openPanel("p-d");
    await settle();
    expect(started).toEqual(["p-a", "p-b", "p-c", "p-d"]);
    // a rescan, or a panel opened again while open, asks nothing more
    useStore.setState({ repos: ["p-a", "p-b", "p-c", "p-d"].map(repo) });
    useStore.getState().openPanel("p-b");
    await settle();
    expect(started).toEqual(["p-a", "p-b", "p-c", "p-d"]);
    // closed and opened again is a new open
    useStore.getState().closePanel("p-b");
    useStore.getState().showTasks("p-b");
    await settle();
    expect(started).toEqual(["p-a", "p-b", "p-c", "p-d", "p-b"]);
  });
});

describe("a panel opens its own shell", () => {
  const pristine = useStore.getState();
  const repo = (id: string) => ({ id, name: id, path: `/dev/${id}`, group: "", source: "launch", status: null }) as unknown as Repo;
  const held = (id: string, repoId: string) =>
    ({ id, repoId, path: `/dev/${repoId}`, place: "panel", attached: false, viewers: [], startedAt: 0 }) as TermInfo;
  const online = () => {
    const s = useStore.getState();
    return { ...s.conns, [s.home]: { ...connOf(s), status: { state: "online" as const } } };
  };
  afterEach(() => useStore.setState(pristine, true));

  test("once per open, starting the agent at intermediate, and never beside a shell the backend holds", () => {
    const settings = { ...pristine.settings, level: "intermediate" as const };
    useStore.setState({ terms: [], settings, conns: online(), repos: ["a", "b"].map(repo), shells: [held("h".repeat(32), "b")], panels: ["a", "b"] });
    const s = useStore.getState();
    expect(s.terms.map((t) => [t.repoId, t.place, t.start])).toEqual([["a", "panel", "agent"]]);
    // a rescan asks nothing more
    useStore.setState({ repos: ["a", "b"].map(repo) });
    expect(useStore.getState().terms).toHaveLength(1);
  });

  test("a shell opened to take a prompt carries it for its first socket", () => {
    useStore.setState({ terms: [], conns: online(), repos: [repo("e")], panels: ["e"], shells: [held("e".repeat(32), "e")] });
    useStore.getState().openTerm("e", "panel", "agent", "fix it");
    expect(useStore.getState().terms.map((t) => [t.start, t.prompt])).toEqual([["agent", "fix it"]]);
  });

  test("a harness or a profile picked at launch rides on the tab", () => {
    useStore.setState({ terms: [], conns: online(), repos: [repo("e")], panels: ["e"], shells: [held("e".repeat(32), "e")] });
    useStore.getState().openTerm("e", "panel", "agent", undefined, { harness: "codex" });
    useStore.getState().openTerm("e", "panel", "agent", undefined, { profile: "deep" });
    expect(useStore.getState().terms.map((t) => [t.start, t.harness, t.profile])).toEqual([
      ["agent", "codex", undefined],
      ["agent", undefined, "deep"],
    ]);
  });

  test("a plain shell at advanced, and none for a backend not online", () => {
    useStore.setState({ terms: [], settings: { ...pristine.settings, level: "advanced" }, repos: [repo("c")], panels: ["c"] });
    expect(useStore.getState().terms).toEqual([]);
    useStore.setState({ conns: online(), repos: [repo("c")] });
    expect(useStore.getState().terms.map((t) => [t.repoId, t.start])).toEqual([["c", undefined]]);
  });
});

describe("a project's bench in front", () => {
  const realFetch = globalThis.fetch;
  const repo = (id: string) => ({ id, name: id, path: `/dev/${id}`, group: "", source: "launch", status: null }) as unknown as Repo;
  beforeEach(() => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ tasks: [], errors: [] }), { status: 200 })) as unknown as typeof fetch;
    useStore.setState({ repos: [repo("f-a"), repo("f-b")], panels: [], activePanel: null, terms: [], front: { kind: "strip" } });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a task brought to the front opens its panel's bench and takes the front from the strip, leaving the folds alone", () => {
    useStore.setState({ closedSections: { "f-a": ["tasks"] } });
    useStore.getState().bringTask("f-a", "dev");
    const s = useStore.getState();
    expect(s.panels).toContain("f-a");
    expect(s.activePanel).toBe("f-a");
    expect(closedIn(s, "f-a", "tasks")).toBe(true);
    expect(s.front).toEqual(projectFront("f-a", "dev"));
  });

  test("the strip takes the front back, and a tasks section going keeps the bench", () => {
    useStore.getState().bringTask("f-a");
    expect(useStore.getState().front).toEqual(projectFront("f-a"));
    useStore.getState().setFront({ kind: "strip" });
    expect(useStore.getState().front).toEqual({ kind: "strip" });
    useStore.getState().bringTask("f-b", "test");
    useStore.getState().dropBenchTask("f-b");
    expect(useStore.getState().front).toEqual(projectFront("f-b"));
    useStore.getState().bringProject(null);
    expect(useStore.getState().front).toBeNull();
  });

  test("a part fills the bench and gives it back; another project's bench starts whole", () => {
    useStore.getState().bringProject("f-a");
    useStore.getState().soloBench("f-a", "shell");
    expect(useStore.getState().front).toEqual(projectFront("f-a", null, null, "shell"));
    // a task asked for in the same bench takes the room for its log
    useStore.getState().bringTask("f-a", "dev");
    expect(useStore.getState().front).toEqual(projectFront("f-a", "dev", null, "log"));
    // another project's part asks nothing of this bench
    useStore.getState().soloBench("f-b", "app");
    expect(useStore.getState().front).toEqual(projectFront("f-a", "dev", null, "log"));
    useStore.getState().soloBench("f-a", null);
    expect(useStore.getState().front).toEqual(projectFront("f-a", "dev"));
    useStore.getState().soloBench("f-a", "app");
    useStore.getState().bringProject("f-b");
    expect(useStore.getState().front).toEqual(projectFront("f-b"));
    useStore.getState().bringProject(null);
    useStore.getState().soloBench("f-a", "app");
    expect(useStore.getState().front).toBeNull();
  });

  test("closing the panel ends its bench; another panel's close leaves it", () => {
    useStore.getState().openPanel("f-b");
    useStore.getState().bringProject("f-a");
    useStore.getState().closePanel("f-b");
    expect(useStore.getState().front).toEqual(projectFront("f-a"));
    useStore.getState().closePanel("f-a");
    expect(useStore.getState().front).toBeNull();
  });
});


describe("a peers event re-reads the mode", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const seen = (at: number): PeerSeen[] => [{ name: "mini", ok: true, at }];
  const settle = () => new Promise((r) => setTimeout(r, 10));

  test("the mode follows the config, and the event's seen list lands at once", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ self: "mac", peers: [], seen: seen(2), sync: "on" }), { status: 200 })) as unknown as typeof fetch;
    useStore.setState({ peerSync: "off", peerSeen: [] });
    useStore.getState().applyEvent({ type: "peers", seen: seen(1) });
    expect(useStore.getState().peerSeen).toEqual(seen(1));
    await settle();
    expect(useStore.getState().peerSync).toBe("on");
    expect(useStore.getState().peerSeen).toEqual(seen(2));
  });

  test("an answer that comes back late never overwrites a newer one", async () => {
    const answers: Array<(sync: string, at: number) => void> = [];
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        answers.push((sync, at) => resolve(new Response(JSON.stringify({ self: "mac", peers: [], seen: seen(at), sync }), { status: 200 })));
      })) as unknown as typeof fetch;
    useStore.setState({ peerSync: "off", peerSeen: [] });
    useStore.getState().applyEvent({ type: "peers", seen: seen(1) });
    useStore.getState().applyEvent({ type: "peers", seen: seen(2) });
    answers[1]?.("dry", 2);
    await settle();
    answers[0]?.("on", 1);
    await settle();
    expect(useStore.getState().peerSync).toBe("dry");
    expect(useStore.getState().peerSeen).toEqual(seen(2));
  });
});

/* ---------- several backends ---------- */

type Answer = (path: string, init?: RequestInit) => unknown;

/** A fetch stub by URL: relative urls are the home backend `a`, and
 *  `http://b.test/...` is `b`. A route either answers JSON, or throws, or
 *  returns a Response of its own. */
function stubFetch(home: Answer, b: Answer, calls: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const onB = u.startsWith("http://b.test");
    const path = onB ? u.slice("http://b.test".length) : u;
    if (!onB && /^https?:/.test(u)) throw new Error(`unexpected ${u}`);
    const body = (onB ? b : home)(path, init);
    if (body instanceof Response) return body;
    if (body instanceof Promise) return body as Promise<Response>;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

class FakeEventSource {
  static opened: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(
    public url: string,
    public opts?: { withCredentials?: boolean },
  ) {
    FakeEventSource.opened.push(this);
  }
  addEventListener(): void {}
  close(): void {
    this.closed = true;
  }
}

const source = (id: string, label: string): SourceState => ({ id, label, kind: "local", path: `/${label}`, launch: true, repos: 1, scannedAt: 1 });
const repo = (id: string, extra: Partial<Repo> = {}) =>
  ({ id, name: id, path: `/dev/${id}`, group: "", source: "launch", status: null, ...extra }) as unknown as Repo;
const scanOf = (root: string, repos: Repo[]): ScanResult => ({ root, sources: [source("launch", "launch")], repos, scannedAt: 1, backend: { openers: true, sshHost: null } });
const runOf = (id: string, repoId: string) => ({ id, repoId, action: "chat", status: "done", startedAt: 1 });
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** What every backend answers at load, for a tree and a run of its own. */
function backendAnswers(tree: unknown, runs: unknown[], extra: Record<string, unknown> = {}): Answer {
  return (path) => {
    const p = path.split("?")[0] ?? "";
    if (p in extra) return extra[p];
    switch (p) {
      case "/api/tree":
        return tree;
      case "/api/runs":
        return runs;
      case "/api/workspaces":
      case "/api/flows":
      case "/api/fleets":
      case "/api/jobs":
      case "/api/terms":
      case "/api/helpers":
      case "/api/devices":
        return [];
      case "/api/agents":
      case "/api/launchers":
        return {};
      case "/api/verdict":
        return { ready: false };
      case "/api/client":
        return { address: "", local: false, shared: false };
      case "/api/terms/kept":
        return { keeping: false, kept: [] };
      case "/api/history":
        return { available: false, reason: "none", fetchedAt: 1 };
      case "/api/peers":
        return { self: null, peers: [], seen: [], sync: "off" };
      case "/api/tailchan":
        return { ready: false, reason: "none" };
      case "/api/about":
        return { version: "0", startedAt: 1 };
      default:
        return { ok: true };
    }
  };
}

const twoBackends = { self: "a", backends: [{ name: "a", tailnet: "http://a.test" }, { name: "b", tailnet: "http://b.test" }] };

describe("several backends", () => {
  const pristine = useStore.getState();
  const realFetch = globalThis.fetch;
  const g = globalThis as unknown as { EventSource?: unknown; localStorage?: unknown };
  const realES = g.EventSource;
  const calls: string[] = [];
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    FakeEventSource.opened = [];
    g.EventSource = FakeEventSource;
    useStore.setState(pristine, true);
  });
  afterEach(() => {
    cleanup?.();
    cleanup = null;
    globalThis.fetch = realFetch;
    g.EventSource = realES;
    delete g.localStorage;
    calls.length = 0;
    setRegistry("", []);
    setBase("b", "");
    setRetryFirst(RETRY_FIRST);
    onBackendSignal(() => {});
    useStore.setState(pristine, true);
  });

  async function start(home: Answer, b: Answer): Promise<void> {
    globalThis.fetch = stubFetch(home, b, calls);
    cleanup = await useStore.getState().init();
  }

  test("a registry of one talks to nothing but the page's own origin", async () => {
    await start(backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": { self: "a", backends: [] } }), () => {
      throw new Error("b asked");
    });
    await settle();
    expect(calls.filter((u) => /^https?:/.test(u))).toEqual([]);
    // what a page asked before there were several backends, plus the list
    expect([...new Set(calls.map((u) => u.split("?")[0]))].sort()).toEqual(
      [
        "/api/backends",
        "/api/tree",
        "/api/workspaces",
        "/api/runs",
        "/api/agents",
        "/api/flows",
        "/api/fleets",
        "/api/verdict",
        "/api/launchers",
        "/api/jobs",
        "/api/terms",
        "/api/client",
        "/api/helpers",
        "/api/devices",
        "/api/terms/kept",
        "/api/history",
        "/api/peers",
        "/api/tailchan",
        "/api/registry",
        "/api/asks",
        "/api/incubator",
        "/api/incubator/advice",
        "/api/incubator/stages",
        "/api/tasks",
      ].sort(),
    );
    const s = useStore.getState();
    expect(Object.keys(s.conns)).toEqual(["a"]);
    expect(multi(s)).toBe(false);
    expect(FakeEventSource.opened.length).toBe(1);
    expect(FakeEventSource.opened[0]?.url.startsWith("/api/events")).toBe(true);
    expect(FakeEventSource.opened[0]?.opts?.withCredentials).toBeFalsy();
    expect(connOf(s).status.state).toBe("online");
  });

  test("a registry that lists only self is the same as no registry: no backends chip either", async () => {
    await start(backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": { self: "a", backends: [{ name: "a", tailnet: "http://a.test" }] } }), () => {
      throw new Error("b asked");
    });
    await settle();
    expect(calls.filter((u) => /^https?:/.test(u))).toEqual([]);
    const s = useStore.getState();
    expect(s.backendOrder).toEqual(["a"]);
    expect(multi(s)).toBe(false);
    expect(hasOtherBackend(s.settings.backends, s.home)).toBe(false);
  });

  test("two backends: each one's repos and runs, and a stream to each", async () => {
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [runOf("r1", "proj")], { "/api/backends": twoBackends }),
      backendAnswers(scanOf("/b", [repo("proj")]), [runOf("r1", "proj")]),
    );
    await settle();
    const s = useStore.getState();
    expect(s.repos.map((r) => r.id)).toEqual(["proj", "b|proj"]);
    expect(Object.keys(s.runs).sort()).toEqual(["b|r1", "r1"]);
    expect(s.runs["b|r1"]?.repoId).toBe("b|proj");
    expect(multi(s)).toBe(true);
    expect(s.backendOrder).toEqual(["a", "b"]);
    expect(FakeEventSource.opened.length).toBe(2);
    const bs = FakeEventSource.opened.find((e) => e.url.startsWith("http://b.test"));
    expect(bs?.url.startsWith("http://b.test/api/events")).toBe(true);
    expect(bs?.opts?.withCredentials).toBe(true);
    expect(connOf(s, "b").status.state).toBe("online");
  });

  test("remembered rules are read per backend, kept by each one's event, and forgotten where they live", async () => {
    const rule = (id: string, path: string): RememberedRule => ({ id, rule: "Bash(ls:*)", scope: { kind: "repo", path }, at: 1 });
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [], {
        "/api/backends": twoBackends,
        "/api/remembered": { rules: [rule("ra", "/a/proj")] },
      }),
      // b is an older canopy with no remembered rules to say
      backendAnswers(scanOf("/b", [repo("proj")]), [], {
        "/api/remembered": () => {
          throw new Error("404");
        },
        "/api/remembered/forget": { rules: [] },
      }),
    );
    await settle();
    await useStore.getState().loadRemembered();
    expect(useStore.getState().remembered).toEqual({ a: [rule("ra", "/a/proj")] });
    expect(Object.keys(useStore.getState().remembered)).toEqual(["a"]);
    useStore.getState().applyEvent({ type: "remembered", rules: [rule("rb", "/b/proj")] }, "b");
    expect(useStore.getState().remembered).toEqual({ a: [rule("ra", "/a/proj")], b: [rule("rb", "/b/proj")] });
    await useStore.getState().forgetRemembered("b", "rb");
    expect(useStore.getState().remembered["b"]).toEqual([]);
    expect(calls.some((u) => u.startsWith("http://b.test/api/remembered/forget"))).toBe(true);
  });

  test("an event from b changes b's checkout and leaves home's alone", async () => {
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }),
      backendAnswers(scanOf("/b", [repo("proj")]), []),
    );
    await settle();
    const home = useStore.getState().repos.find((r) => r.id === "proj");
    useStore.getState().applyEvent({ type: "repo", repo: repo("b|proj", { name: "changed", source: "b|launch" }) }, "b");
    const after = useStore.getState().repos;
    expect(after.find((r) => r.id === "proj")).toBe(home);
    expect(after.find((r) => r.id === "b|proj")?.name).toBe("changed");
  });

  test("the agent registry is home's alone, and a card joins the repo card by its remote", async () => {
    const card = (id: string, over: Partial<AgentCard> = {}): AgentCard => ({
      id,
      handle: "proj-0123",
      node: "a",
      harness: "claude",
      session: "s",
      origin: "canopy-shell",
      cwd: "/a/proj",
      repo: "https://github.com/me/proj",
      branch: "main",
      model: null,
      mode: null,
      state: "working",
      waiting: null,
      caps: [],
      offers: [],
      notifyIdle: false,
      where: { os: "linux", container: false, pid: 1, term: null, canopy: null },
      transcript: null,
      startedAt: 1,
      seenAt: 2,
      endedAt: null,
      ...over,
    });
    const proj = repo("proj", { remotes: ["git@github.com:me/proj.git"], link: "https://github.com/me/proj" });
    await start(
      backendAnswers(scanOf("/a", [proj]), [], { "/api/backends": twoBackends, "/api/registry": { ready: true, cards: [card("claude:one")] } }),
      backendAnswers(scanOf("/b", []), []),
    );
    await settle();
    let s = useStore.getState();
    expect(s.registryReady).toBe(true);
    expect(agentsOn(s, "proj").map((c) => c.id)).toEqual(["claude:one"]);
    // b's broker is not this page's registry
    useStore.getState().applyEvent({ type: "registry", cards: [card("claude:two")] }, "b");
    expect(Object.keys(useStore.getState().registry)).toEqual(["claude:one"]);
    // home's is: a new card lands, a lagging reading of one held does not
    useStore.getState().applyEvent({ type: "registry", cards: [card("claude:two", { state: "waiting" }), card("claude:one", { state: "idle", seenAt: 1 })] }, "a");
    s = useStore.getState();
    expect(s.registry["claude:one"]?.state).toBe("working");
    expect(agentsOn(s, "proj").map((c) => [c.id, c.state])).toEqual([
      ["claude:two", "waiting"],
      ["claude:one", "working"],
    ]);
    useStore.getState().applyEvent({ type: "registry", cards: [], gone: ["claude:two"] }, "a");
    expect(Object.keys(useStore.getState().registry)).toEqual(["claude:one"]);
    // a panel for a repo the board leaves out, archived or outside the
    // workspace, still shows the agents working in it
    useStore.setState((st) => ({
      repos: st.repos.map((r) => (r.id === "proj" ? { ...r, archived: "canopy" as const } : r)),
      settings: { ...st.settings, hideArchived: true },
    }));
    expect(visibleCards(useStore.getState()).some((c) => c.checkouts.some((r) => r.id === "proj"))).toBe(false);
    expect(agentsOn(useStore.getState(), "proj").map((c) => c.id)).toEqual(["claude:one"]);
    useStore.setState((st) => ({ settings: { ...st.settings, hideArchived: false }, workspaces: [{ name: "w", repos: [] }], activeWs: "w" }));
    expect(agentsOn(useStore.getState(), "proj").map((c) => c.id)).toEqual(["claude:one"]);
    useStore.setState({ activeWs: null, workspaces: [] });
  });

  test("asks are home's alone, and an answer goes back the way its item came", async () => {
    const open: Ask = {
      id: "a1",
      agent: "claude:one",
      handle: "proj-0123",
      node: "a",
      kind: "permission",
      tool: "Bash",
      title: "Bash: ls",
      detail: "{}",
      route: "remote",
      waitUntil: Date.now() + 60_000,
      state: "open",
      createdAt: 1,
    };
    const waiting = { ...runOf("b|r1", "b|proj"), status: "waiting", steps: [], prompt: { id: "p1", kind: "permission", tool: "Bash", title: "ls", detail: "ls" } };
    const posted: { path: string; body: unknown; key: string | null }[] = [];
    const record = (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const key = new Headers(init.headers).get("x-canopy-answer-key");
        posted.push({ path, body: JSON.parse(String(init.body ?? "null")), key });
      }
      return undefined;
    };
    await start(
      (path, init) =>
        record(path, init) ??
        backendAnswers(scanOf("/a", [repo("proj")]), [], {
          "/api/backends": twoBackends,
          "/api/asks": { ready: true, canAnswer: true, asks: [open], presence: { state: "here", at: 1, pinned: false } },
          "/api/asks/answer": { ...open, state: "answered", answer: { behavior: "allow" }, answeredBy: "x@canopy" },
        })(path, init),
      (path, init) => record(`b:${path}`, init) ?? backendAnswers(scanOf("/b", [repo("proj")]), [{ ...waiting, id: "r1", repoId: "proj" }], { "/api/runs/answer": { ...waiting, id: "r1", repoId: "proj", status: "working", prompt: null } })(path, init),
    );
    await settle();
    let s = useStore.getState();
    expect(s.asksReady).toBe(true);
    // without a key of its own this page shows the asks read-only
    expect(canAnswer(s)).toBe(false);
    useStore.getState().setAnswerKey("  phone-secret ");
    s = useStore.getState();
    expect(s.answerKey).toBe("phone-secret");
    expect(canAnswer(s)).toBe(true);
    expect(() => useStore.getState().setAnswerKey("two words")).toThrow("one word");
    expect(inboxItems(s).map((i) => i.key)).toEqual(["ask:a1", "run:b|r1"]);
    // b's broker is not this page's
    useStore.getState().applyEvent({ type: "asks", asks: [{ ...open, id: "a2" }] }, "b");
    expect(Object.keys(useStore.getState().asks)).toEqual(["a1"]);
    // an answer to b's run goes to b, as a run's answer
    const run = inboxItems(useStore.getState()).find((i) => i.source === "run")!;
    await useStore.getState().answerInbox(run, { behavior: "allow", always: true });
    expect(posted.find((p) => p.path.startsWith("b:/api/runs/answer"))?.body).toMatchObject({ id: "r1", promptId: "p1", answer: { kind: "allow-all" } });
    // a run's answer carries no key, to any backend
    expect(posted.find((p) => p.path.startsWith("b:/api/runs/answer"))?.key).toBeNull();
    // an answer to an ask goes to home, with this browser's id and key
    const a = inboxItems(useStore.getState()).find((i) => i.source === "ask")!;
    await useStore.getState().answerInbox(a, { behavior: "deny", message: "not now" });
    expect(posted.find((p) => p.path === "/api/asks/answer")?.body).toMatchObject({ id: "a1", behavior: "deny", message: "not now" });
    expect(posted.find((p) => p.path === "/api/asks/answer")?.key).toBe("phone-secret");
    // the feed says how it ended at once, even when the answer beats the event
    expect(useStore.getState().feed.some((l) => l.kind === "ask" && l.text.includes("allowed by x@canopy"))).toBe(true);
    const lines = useStore.getState().feed.length;
    // and the event that follows says nothing twice
    useStore.getState().applyEvent({ type: "asks", asks: [{ ...open, state: "answered", answer: { behavior: "allow" }, answeredBy: "x@canopy" }] });
    expect(useStore.getState().feed.length).toBe(lines);
    useStore.getState().setAnswerKey(null);
    expect(useStore.getState().answerKey).toBeNull();
    s = useStore.getState();
    expect(s.asks["a1"]?.state).toBe("answered");
    expect(inboxItems(s).some((i) => i.key === "ask:a1")).toBe(false);
  });

  const sproutOf = (id: string, updatedAt: number): Sprout => ({
    id, slug: id, title: id, status: "queued", repoId: `_incubator/${id}`, seedPath: `/a/${id}`, prepared: true, inputs: [],
    clarified: true, reclarify: false, flows: [], spent: { runs: 0, workMs: 0 }, createdAt: 1, updatedAt,
  });

  test("a sprout list that lands after a newer event does not undo it", async () => {
    const old = sproutOf("sp_000000000001", 1);
    let release: (r: Response) => void = () => {};
    let mode: "first" | "hold" = "first";
    await start(
      (path, init) => {
        if (path.split("?")[0] === "/api/incubator" && mode === "hold") return new Promise<Response>((r) => (release = r));
        return backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends, "/api/incubator": [old] })(path, init);
      },
      backendAnswers(scanOf("/b", [repo("proj")]), []),
    );
    await settle();
    mode = "hold";
    const load = useStore.getState().loadSprouts();
    // events while the list is on its way
    useStore.getState().applyEvent({ type: "incubator", sprout: { ...old, title: "newer", updatedAt: 9 } });
    useStore.getState().applyEvent({ type: "incubator", sprout: sproutOf("sp_000000000002", 9) });
    release(new Response(JSON.stringify([old]), { status: 200 }));
    await load;
    const held = useStore.getState().sprouts;
    expect(held[old.id]?.title).toBe("newer");
    expect(Object.keys(held).sort()).toEqual([old.id, "sp_000000000002"]);
  });

  test("an action's answer older than an event that came first does not undo it", async () => {
    const asking: Sprout = { ...sproutOf("sp_000000000001", 5), status: "clarifying", questions: [{ question: "Q?", header: "", options: [], multiSelect: false }], questionsAt: 5 };
    let release: (r: Response) => void = () => {};
    await start(
      (path, init) => {
        if (path.startsWith("/api/incubator/stop")) return new Promise<Response>((r) => (release = r));
        return backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends, "/api/incubator": [asking] })(path, init);
      },
      backendAnswers(scanOf("/b", [repo("proj")]), []),
    );
    await settle();
    const stopping = useStore.getState().stopSprout(asking.id);
    // the stop's own event, and then a newer one, land before its answer does
    useStore.getState().applyEvent({ type: "incubator", sprout: { ...asking, status: "stopped", questions: undefined, updatedAt: 8 } });
    useStore.getState().applyEvent({ type: "incubator", sprout: { ...asking, status: "stopped", questions: undefined, title: "renamed", updatedAt: 9 } });
    const feed = useStore.getState().feed.length;
    release(new Response(JSON.stringify({ ...asking, status: "stopped", questions: undefined, updatedAt: 7 }), { status: 200 }));
    await stopping;
    expect(useStore.getState().sprouts[asking.id]?.title).toBe("renamed");
    expect(useStore.getState().sprouts[asking.id]?.updatedAt).toBe(9);
    expect(useStore.getState().feed.length).toBe(feed);
  });

  test("a failed sprout reload keeps the sprouts held", async () => {
    const one = sproutOf("sp_000000000001", 1);
    let fail = false;
    await start(
      (path, init) => {
        if (fail && path.split("?")[0] === "/api/incubator") return new Response("nope", { status: 500 });
        return backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends, "/api/incubator": [one] })(path, init);
      },
      backendAnswers(scanOf("/b", [repo("proj")]), []),
    );
    await settle();
    fail = true;
    await useStore.getState().loadSprouts();
    expect(Object.keys(useStore.getState().sprouts)).toEqual([one.id]);
    expect(useStore.getState().sproutsReady).toBe(true);
  });

  test("the incubator is home's alone; its questions are in the inbox and answered there", async () => {
    const asking: Sprout = {
      id: "sp_000000000001",
      slug: "coins",
      title: "Coin counter",
      status: "clarifying",
      repoId: "_incubator/coins",
      seedPath: "/a/_incubator/coins",
      prepared: true,
      inputs: [],
      clarified: true,
      reclarify: false,
      questions: [{ question: "Who counts?", header: "", options: [], multiSelect: false }],
      questionsAt: 5,
      flows: [],
      spent: { runs: 0, workMs: 0 },
      createdAt: 1,
      updatedAt: 5,
    };
    const answered: Sprout = { ...asking, status: "queued", questions: undefined, questionsAt: undefined, updatedAt: 6 };
    const posted: { path: string; body: unknown }[] = [];
    await start(
      (path, init) => {
        if (init?.method === "POST") posted.push({ path, body: JSON.parse(String(init.body ?? "null")) });
        return backendAnswers(scanOf("/a", [repo("proj")]), [], {
          "/api/backends": twoBackends,
          "/api/incubator": [asking],
          "/api/incubator/stages": { isolated: false, mode: "runner", waiting: "the stage runner is not answering" },
          "/api/incubator/answer": answered,
        })(path, init);
      },
      backendAnswers(scanOf("/b", [repo("proj")]), []),
    );
    await settle();
    let s = useStore.getState();
    expect(s.sproutsReady).toBe(true);
    expect(Object.keys(s.sprouts)).toEqual([asking.id]);
    const item = inboxItems(s).find((i) => i.source === "sprout");
    if (!item) throw new Error("no sprout item in the inbox");
    expect(item.key).toBe(`sprout:${asking.id}`);
    expect(s.stages).toEqual({ isolated: false, mode: "runner", waiting: "the stage runner is not answering" });
    // b's incubator is not this page's
    useStore.getState().applyEvent({ type: "incubator", sprout: { ...asking, id: "sp_000000000002" } }, "b");
    expect(Object.keys(useStore.getState().sprouts)).toEqual([asking.id]);
    useStore.getState().applyEvent({ type: "stages", stages: { isolated: true, mode: "runner", waiting: null } }, "b");
    expect(useStore.getState().stages?.isolated).toBe(false);
    useStore.getState().applyEvent({ type: "stages", stages: { isolated: true, mode: "runner", waiting: null } });
    expect(useStore.getState().stages).toEqual({ isolated: true, mode: "runner", waiting: null });
    // going on assumptions is a skip, to home
    await useStore.getState().answerInbox(item, { skip: true });
    expect(posted.find((p) => p.path.startsWith("/api/incubator/answer"))).toEqual({ path: `/api/incubator/answer?id=${asking.id}`, body: { skip: true } });
    s = useStore.getState();
    expect(s.sprouts[asking.id]?.status).toBe("queued");
    expect(inboxItems(s).some((i) => i.source === "sprout")).toBe(false);
    expect(s.feed.some((l) => l.kind === "incubator" && l.text === "waiting its turn for research")).toBe(true);
    useStore.getState().applyEvent({ type: "incubator-gone", id: asking.id });
    expect(useStore.getState().sprouts).toEqual({});
  });

  test("a scan from b prunes only b's panels", async () => {
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }),
      backendAnswers(scanOf("/b", [repo("proj")]), []),
    );
    await settle();
    useStore.setState({ panels: ["proj", "b|proj"], activePanel: "b|proj" });
    const bScan = { ...scanOf("/b", []), sources: [source("b|launch", "launch")] };
    useStore.getState().applyEvent({ type: "scan", result: bScan }, "b");
    const s = useStore.getState();
    expect(s.panels).toEqual(["proj"]);
    expect(s.activePanel).toBe("proj");
    expect(s.repos.map((r) => r.id)).toEqual(["proj"]);
    expect(s.root).toBe("/a");
  });

  test("a repo leaving the scan drops its popped slot, and only that backend's", async () => {
    await start(backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }), backendAnswers(scanOf("/b", [repo("proj")]), []));
    await settle();
    useStore.setState({ popped: { proj: 0, "b|proj": 1, "b|gone": 2 } });
    // an event's ids come already qualified, as the stream hands them over
    useStore.getState().applyEvent({ type: "scan", result: { ...scanOf("/b", [repo("b|proj")]), sources: [source("b|launch", "launch")] } }, "b");
    expect(useStore.getState().popped).toEqual({ proj: 0, "b|proj": 1 });
    useStore.setState({ popped: {} });
  });

  test("a repo leaving the scan drops its loaded tasks and the server answers for the top bar list", async () => {
    const t = (repoId: string) => ({ name: "dev", cmd: "x", repoId, source: "detected" as const, termId: "0".repeat(32), status: "running" as const, live: true, restarts: 0, viewers: [] });
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }),
      backendAnswers(scanOf("/b", [repo("proj")]), [], {
        "/api/tasks": [{ ...t("proj"), gone: "repo" }],
      }),
    );
    await settle();
    useStore.setState({ tasks: { proj: [t("proj")], "b|proj": [t("b|proj")] }, taskErrors: { "b|proj": ["x"] }, taskAll: [t("proj"), t("b|proj")] });
    useStore.getState().applyEvent({ type: "scan", result: { ...scanOf("/b", []), sources: [source("b|launch", "launch")] } }, "b");
    const s = useStore.getState();
    expect(Object.keys(s.tasks)).toEqual(["proj"]);
    expect(s.taskErrors).toEqual({});
    await settle();
    // the server still lists b's task, marked gone, and it stays for the popover
    const all = useStore.getState().taskAll.filter((x) => x.repoId === "b|proj");
    expect(all.map((x) => x.gone)).toEqual(["repo"]);
  });

  test("a backend that has not answered keeps its panels and its saved shell tabs", async () => {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const bTab = { id: `b|${"a".repeat(32)}`, repoId: "b|x", name: "x", path: "/dev/x", place: "strip" };
    store.set("canopy.layout", JSON.stringify({ panels: ["proj", "b|x"], terms: [bTab] }));
    useStore.setState({ panels: ["proj", "b|x"] });
    // b's answers never come
    await start(backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }), () => new Promise(() => {}));
    await settle();
    useStore.getState().applyEvent({ type: "scan", result: { ...scanOf("/a", [repo("proj")]), scannedAt: 2 } });
    const s = useStore.getState();
    expect(s.panels).toEqual(["proj", "b|x"]);
    // home's panel opens a shell of its own; the other backend's tab stays parked
    expect(s.terms.map((t) => t.repoId)).toEqual(["proj"]);
    expect(s.parkedTerms.map((t) => t.id)).toEqual([bTab.id]);
    expect(layoutOf(s).terms.map((t) => t.id).filter((id) => id.includes("|"))).toEqual([bTab.id]);
    const saved = JSON.parse(store.get("canopy.layout") ?? "{}") as { terms?: { id: string }[]; panels?: string[] };
    // besides the shell home's open panel starts for itself
    expect(saved.terms?.map((t) => t.id).filter((id) => id.includes("|"))).toEqual([bTab.id]);
    expect(saved.panels).toEqual(["proj", "b|x"]);
  });

  test("b's parked tab comes in once b answers with its shell", async () => {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const plain = "a".repeat(32);
    const bTab = { id: `b|${plain}`, repoId: "b|x", name: "x", path: "/dev/x", place: "strip" };
    store.set("canopy.layout", JSON.stringify({ terms: [bTab] }));
    const held = { id: plain, repoId: "x", path: "/dev/x", place: "strip", attached: false, viewers: [], startedAt: 1 };
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }),
      backendAnswers(scanOf("/b", [repo("x")]), [], { "/api/terms": [held] }),
    );
    await settle();
    const s = useStore.getState();
    expect(s.terms.map((t) => t.id)).toEqual([bTab.id]);
    expect(s.parkedTerms).toEqual([]);
    expect(s.shells.map((t) => t.id)).toEqual([bTab.id]);
  });

  test("b not answering marks it offline, a sign-in page marks it signin, home stays online", async () => {
    await start(backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }), () => {
      throw new Error("down");
    });
    await settle();
    expect(connOf(useStore.getState(), "b").status.state).toBe("offline");
    expect(connOf(useStore.getState(), "a").status.state).toBe("online");
    expect(isOnline(useStore.getState(), "a")).toBe(true);
    expect(isOnline(useStore.getState(), "b")).toBe(false);

    globalThis.fetch = stubFetch(
      backendAnswers(scanOf("/a", [repo("proj")]), []),
      () => new Response(JSON.stringify({ error: "sign in", login: "https://gate.test/login" }), { status: 401 }),
      calls,
    );
    await useStore.getState().retryBackend("b");
    await settle();
    const b = connOf(useStore.getState(), "b").status;
    expect(b.state).toBe("signin");
    expect(b.login).toBe("https://gate.test/login");
    expect(connOf(useStore.getState(), "a").status.state).toBe("online");
  });

  test("a backend down at load comes in by itself once it answers", async () => {
    setRetryFirst(15);
    let up = false;
    const bAnswers = backendAnswers(scanOf("/b", [repo("proj")]), []);
    await start(backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }), (path) => {
      if (!up) throw new Error("down");
      return bAnswers(path);
    });
    await settle();
    expect(connOf(useStore.getState(), "b").status.state).toBe("offline");
    up = true;
    // tries so far waited 15, 30, 60ms; the next lands within 120ms
    await settle(300);
    const s = useStore.getState();
    expect(connOf(s, "b").status.state).toBe("online");
    expect(s.repos.map((r) => r.id)).toEqual(["proj", "b|proj"]);
    // online, it stops trying: no more tree reads at b
    const reads = calls.filter((u) => u.startsWith("http://b.test/api/tree")).length;
    await settle(200);
    expect(calls.filter((u) => u.startsWith("http://b.test/api/tree")).length).toBe(reads);
  });

  test("a hidden backend is not tried again", async () => {
    setRetryFirst(15);
    await start(backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }), () => {
      throw new Error("down");
    });
    await settle();
    useStore.getState().hideBackend("b", true);
    const asked = calls.filter((u) => u.startsWith("http://b.test")).length;
    expect(asked).toBeGreaterThan(0);
    await settle(200);
    expect(calls.filter((u) => u.startsWith("http://b.test")).length).toBe(asked);
  });

  test("agentFor resolves through the repo's own backend's routing", async () => {
    const deep = { ...DEFAULT_AGENT, model: "opus" } as AgentSettings;
    const review = { ...DEFAULT_AGENT, harness: "codex", model: "gpt-5.5" } as AgentSettings;
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [], {
        "/api/backends": twoBackends,
        "/api/agents": { profiles: { deep }, roles: { chat: { profile: "deep" } }, repos: {} },
      }),
      backendAnswers(scanOf("/b", [repo("proj")]), [], {
        "/api/agents": { profiles: { review }, roles: {}, repos: { "/dev/proj": { all: { profile: "review" } } } },
      }),
    );
    await settle();
    const s = useStore.getState();
    const home = s.repos.find((r) => r.id === "proj");
    const there = s.repos.find((r) => r.id === "b|proj");
    if (!home || !there) throw new Error("repos missing");
    expect(agentFor(s, home)).toEqual(DEFAULT_AGENT);
    expect(agentFor(s, home, "chat")).toEqual(deep);
    expect(agentFor(s, there)).toEqual(review);
    // b's repo pick covers its chats too, codex and all
    expect(agentFor(s, there, "chat")).toEqual(review);
  });

  test("agentFor reads an older backend's plain settings as the repo's pick", async () => {
    const quick = { ...DEFAULT_AGENT, model: "haiku" } as AgentSettings;
    const slow = { ...DEFAULT_AGENT, model: "opus" } as AgentSettings;
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends, "/api/agents": { "/dev/proj": quick } }),
      backendAnswers(scanOf("/b", [repo("proj")]), [], { "/api/agents": { "/dev/proj": slow } }),
    );
    await settle();
    const s = useStore.getState();
    const home = s.repos.find((r) => r.id === "proj");
    const there = s.repos.find((r) => r.id === "b|proj");
    if (!home || !there) throw new Error("repos missing");
    expect(agentFor(s, home)).toEqual(quick);
    expect(agentFor(s, there)).toEqual(slow);
  });

  test("a shell opened at b's repo is b's", async () => {
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }),
      backendAnswers(scanOf("/b", [repo("proj")]), []),
    );
    await settle();
    useStore.getState().openTerm("b|proj", "strip");
    const tab = useStore.getState().terms.at(-1);
    expect(tab?.id.startsWith("b|")).toBe(true);
    expect(tab?.id.length).toBe(34);
    expect(tab?.repoId).toBe("b|proj");
  });

  test("hiding b drops its slice and parks its tabs; showing it connects again", async () => {
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }),
      backendAnswers(scanOf("/b", [repo("proj")]), [runOf("r1", "proj")]),
    );
    await settle();
    useStore.getState().openTerm("b|proj", "strip");
    const tab = useStore.getState().terms.at(-1);
    useStore.getState().hideBackend("b", true);
    let s = useStore.getState();
    expect(s.repos.map((r) => r.id)).toEqual(["proj"]);
    expect(Object.keys(s.runs)).toEqual([]);
    expect(s.terms).toEqual([]);
    expect(s.parkedTerms.map((t) => t.id)).toEqual([tab?.id ?? ""]);
    expect(s.backendOrder).toEqual(["a"]);
    expect(s.settings.hiddenBackends).toEqual(["b"]);
    expect(FakeEventSource.opened.find((e) => e.url.startsWith("http://b.test"))?.closed).toBe(true);
    useStore.getState().hideBackend("b", false);
    await settle();
    s = useStore.getState();
    expect(s.backendOrder).toEqual(["a", "b"]);
    expect(s.repos.map((r) => r.id)).toEqual(["proj", "b|proj"]);
    expect(s.settings.hiddenBackends).toEqual([]);
  });

  test("an answer that lands after b is hidden does not bring b back", async () => {
    const pending: Array<(body: unknown) => void> = [];
    const later = () =>
      new Promise<Response>((resolve) => {
        pending.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 })));
      });
    const b = backendAnswers(scanOf("/b", [repo("proj")]), [runOf("r1", "proj")]);
    await start(backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }), (path, init) => {
      const p = path.split("?")[0] ?? "";
      if (p === "/api/about" || p === "/api/history" || p === "/api/peers") return later();
      return b(path, init);
    });
    await settle();
    expect(useStore.getState().repos.map((r) => r.id)).toEqual(["proj", "b|proj"]);
    expect(pending.length).toBe(3);
    useStore.getState().hideBackend("b", true);
    for (const answer of pending) answer({ available: false, reason: "late", fetchedAt: 1, version: "0", startedAt: 1, self: null, peers: [], seen: [], sync: "on" });
    await settle();
    // the stream's last word, sent before the hide
    useStore.getState().applyEvent({ type: "scan", result: { ...scanOf("/b", [repo("b|proj", { source: "b|launch" })]), scannedAt: 2 } }, "b");
    const s = useStore.getState();
    expect(s.conns["b"]).toBeUndefined();
    expect(s.histories["b"]).toBeUndefined();
    expect(s.repos.map((r) => r.id)).toEqual(["proj"]);
    expect(s.backendOrder).toEqual(["a"]);
  });

  test("home cannot be hidden", async () => {
    await start(backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }), backendAnswers(scanOf("/b", []), []));
    await settle();
    useStore.getState().hideBackend("a", true);
    expect(useStore.getState().backendOrder).toEqual(["a", "b"]);
  });

  test("a failed registry read still parks the tabs and keeps the panels of a backend it had named", async () => {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const bTab = { id: `b|${"c".repeat(32)}`, repoId: "b|x", name: "x", path: "/dev/x", place: "strip" };
    store.set("canopy.layout", JSON.stringify({ terms: [bTab] }));
    useStore.setState({ panels: ["proj", "b|x"], settings: { ...pristine.settings, backends: twoBackends.backends } });
    await start(
      backendAnswers(scanOf("/home", [repo("proj")]), [], {
        "/api/backends": new Response("{}", { status: 500 }),
      }),
      () => {
        throw new Error("b asked");
      },
    );
    useStore.getState().applyEvent({ type: "scan", result: { ...scanOf("/home", [repo("proj")]), scannedAt: 2 } });
    const s = useStore.getState();
    expect(s.backendOrder).toEqual(["home"]);
    expect(s.panels).toEqual(["proj", "b|x"]);
    expect(s.parkedTerms.map((t) => t.id)).toEqual([bTab.id]);
    const saved = JSON.parse(store.get("canopy.layout") ?? "{}") as { terms?: { id: string }[] };
    // besides the shell home's open panel starts for itself
    expect(saved.terms?.map((t) => t.id).filter((id) => id.includes("|"))).toEqual([bTab.id]);
  });

  test("a server with no backends route is home alone", async () => {
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [], {
        "/api/backends": new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      }),
      () => {
        throw new Error("b asked");
      },
    );
    const s = useStore.getState();
    expect(s.home).toBe("home");
    expect(s.backendOrder).toEqual(["home"]);
    expect(s.loaded).toBe(true);
  });

  test("a fleet that starts on a and fails on b keeps a's fleet and drops only a's repo from the pick", async () => {
    // two unrelated repos, one per backend (not two checkouts of one card),
    // so both are their own visible, pickable repo
    const bFleet: Answer = (path) => {
      if ((path.split("?")[0] ?? "") === "/api/fleet") throw new Error("b did not answer");
      return backendAnswers(scanOf("/b", [repo("other")]), [])(path);
    };
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [], {
        "/api/backends": twoBackends,
        "/api/fleet": { id: "f1", workflow: "w", verb: "w", note: "", repos: [{ repoId: "proj" }], status: "working", startedAt: 1 },
      }),
      bFleet,
    );
    await settle();
    useStore.setState({ selecting: true, selected: ["proj", "b|other"] });
    await expect(useStore.getState().startFleet("w", "")).rejects.toThrow();
    const s = useStore.getState();
    expect(s.fleets["f1"]?.repos.map((r) => r.repoId)).toEqual(["proj"]);
    expect(s.selected).toEqual(["b|other"]);
    // the failed backend left selecting on, so the plan can retry just what
    // did not start
    expect(s.selecting).toBe(true);
  });
});

/* ---------- cards ---------- */

describe("cards over several backends", () => {
  const pristine = useStore.getState();
  const conn = (name: string, state: "online" | "offline") => ({ ...connOf(pristine, "none"), name, status: { state } });
  const two = (bState: "online" | "offline" = "online") => {
    setRegistry("a", ["a", "b"]);
    useStore.setState({
      home: "a",
      backendOrder: ["a", "b"],
      conns: { a: conn("a", "online"), b: conn("b", bState) },
      repos: [repo("proj"), repo("other"), repo("b|proj")],
    });
  };
  afterEach(() => {
    setRegistry("", []);
    useStore.setState(pristine, true);
  });

  test("one lead per card: home's, b's once preferred, home's again when b goes offline", () => {
    two();
    const ids = () => visibleRepos(useStore.getState()).map((r) => r.id);
    expect(ids()).toEqual(["proj", "other"]);
    expect(visibleCards(useStore.getState()).map((c) => c.checkouts.map((r) => r.id))).toEqual([["proj", "b|proj"], ["other"]]);
    useStore.getState().setCheckoutPref("rel:proj", "b");
    expect(ids()).toEqual(["b|proj", "other"]);
    useStore.setState({ conns: { ...useStore.getState().conns, b: conn("b", "offline") } });
    expect(ids()).toEqual(["proj", "other"]);
  });

  test("the same state gives the same arrays and the same cards", () => {
    two();
    const s = useStore.getState();
    const repos = visibleRepos(s);
    const cards = visibleCards(s);
    expect(visibleRepos(s)).toBe(repos);
    expect(visibleCards(s)).toBe(cards);
    useStore.setState({ filter: s.filter });
    expect(visibleRepos(useStore.getState())).toBe(repos);
    expect(visibleCards(useStore.getState())).toBe(cards);
    // a change to one repo leaves the other cards as they were
    const other = s.repos.find((r) => r.id === "other") as Repo;
    useStore.setState({ repos: s.repos.map((r) => (r.id === "other" ? { ...other, name: "renamed" } : r)) });
    const next = visibleCards(useStore.getState());
    expect(next).not.toBe(cards);
    expect(next[0]).toBe(cards[0]);
    expect(next[1]).not.toBe(cards[1]);
    expect(cardOf(useStore.getState(), "b|proj")).toBe(cards[0]);
  });

  test("a text filter matches the plain id, never the prefix", () => {
    two();
    useStore.setState({ filter: "b|" });
    expect(visibleRepos(useStore.getState())).toEqual([]);
    useStore.setState({ filter: "proj" });
    expect(visibleRepos(useStore.getState()).map((r) => r.id)).toEqual(["proj"]);
  });

  test("with one backend the board is the filtered repos, element for element", () => {
    const repos = [repo("x"), repo("y", { status: { branch: "dev", files: [], ahead: 1, behind: 0, upstream: null } as unknown as Repo["status"] }), repo("xy")];
    useStore.setState({ repos, filter: "x" });
    const s = useStore.getState();
    const old = applyQuery(scopedRepos(s), { filters: s.filters, users: s.users, attention: s.dirtyOnly, text: s.filter });
    const now = visibleRepos(s);
    expect(now).toHaveLength(old.length);
    now.forEach((r, i) => expect(r).toBe(old[i] as Repo));
    useStore.setState({ filter: "", filters: ["unpushed"] });
    expect(visibleRepos(useStore.getState()).map((r) => r.id)).toEqual(["y"]);
  });

  test("archived repos stay off the board until the setting shows them", () => {
    const repos = [repo("x"), repo("old", { archived: "canopy" }), repo("gh", { archived: "github" })];
    useStore.setState({ repos });
    const ids = () => visibleRepos(useStore.getState()).map((r) => r.id);
    expect(useStore.getState().settings.hideArchived).toBe(true);
    expect(ids()).toEqual(["x"]);
    expect(archivedCount(useStore.getState())).toBe(2);
    useStore.setState((s) => ({ settings: { ...s.settings, hideArchived: false } }));
    expect(ids()).toEqual(["x", "old", "gh"]);
    expect(archivedCount(useStore.getState())).toBe(2);
  });

  test("favorites only leaves the starred cards, counts as a filter, and clears with the rest", () => {
    useStore.setState({ repos: [repo("x"), repo("fav", { favorite: true })] });
    const ids = () => visibleRepos(useStore.getState()).map((r) => r.id);
    expect(favoriteCount(useStore.getState())).toBe(1);
    useStore.getState().setFavoritesOnly(true);
    expect(ids()).toEqual(["fav"]);
    expect(activeFilterCount(useStore.getState())).toBe(1);
    useStore.getState().clearFilters();
    expect(useStore.getState().favoritesOnly).toBe(false);
    expect(ids()).toEqual(["x", "fav"]);
  });

  test("a card is a favorite when any of its checkouts is starred", () => {
    two();
    useStore.setState((s) => ({ repos: s.repos.map((r) => (r.id === "b|proj" ? { ...r, favorite: true as const } : r)) }));
    const s = useStore.getState();
    expect(isFavorite(s, "proj")).toBe(true);
    expect(isFavorite(s, "other")).toBe(false);
    expect(favoriteCount(s)).toBe(1);
    useStore.getState().setFavoritesOnly(true);
    expect(visibleCards(useStore.getState()).map((c) => c.checkouts.map((r) => r.id))).toEqual([["proj", "b|proj"]]);
  });

  test("switchCheckout swaps the panel in place and leads the card with it", () => {
    two();
    useStore.setState({ panels: ["other", "proj"], activePanel: "proj" });
    useStore.getState().switchCheckout("proj", "b|proj");
    let s = useStore.getState();
    expect(s.panels).toEqual(["other", "b|proj"]);
    expect(s.activePanel).toBe("b|proj");
    expect(s.checkoutPref["rel:proj"]).toBe("b");
    // a sibling already open keeps its place
    useStore.setState({ panels: ["proj", "other", "b|proj"], activePanel: "other" });
    useStore.getState().switchCheckout("proj", "b|proj");
    s = useStore.getState();
    expect(s.panels).toEqual(["other", "b|proj"]);
    expect(s.activePanel).toBe("other");
  });

  test("switchCheckout to a popped sibling docks it by hand", () => {
    two();
    useStore.setState({ panels: ["other", "proj"], activePanel: "proj", popped: { "b|proj": 0 }, recalled: [] });
    useStore.getState().switchCheckout("proj", "b|proj");
    const s = useStore.getState();
    expect(s.popped).toEqual({});
    expect(s.recalled).toEqual(["b|proj"]);
    useStore.setState({ popped: {}, recalled: [] });
  });

  test("in a solo window the switch goes to the sibling's own solo window", () => {
    two();
    const g = globalThis as unknown as { window?: unknown };
    const went: string[] = [];
    const href = "http://a.test/?repo=proj&view=solo";
    g.window = { location: { search: "?repo=proj&view=solo", href, assign: (u: string) => went.push(u) } };
    try {
      useStore.setState({ panels: ["other"], activePanel: "other" });
      useStore.getState().switchCheckout("proj", "b|proj");
      const s = useStore.getState();
      expect(went).toHaveLength(1);
      const u = new URL(went[0] as string);
      expect([u.searchParams.get("repo"), u.searchParams.get("view")]).toEqual(["b|proj", "solo"]);
      // the grove's dock is not this window's to change
      expect(s.panels).toEqual(["other"]);
      expect(s.activePanel).toBe("other");
      expect(s.checkoutPref["rel:proj"]).toBe("b");
    } finally {
      delete g.window;
    }
  });
});

describe("a repo's agent override on a backend older than routing", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("gets the whole-repo settings alone, and one with routing gets the override whole", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const s = useStore.getState();
    const withHarnesses = (harnesses?: ("claude" | "codex")[]) => ({
      ...s.conns,
      [s.home]: { ...connOf(s), backend: { openers: false, sshHost: null, ...(harnesses ? { harnesses } : {}) } },
    });
    const own: AgentSettings = { ...DEFAULT_AGENT, model: "opus" };
    const override = { all: own, roles: { job: { profile: "deep" } } };
    // an older backend reads anything but plain settings as its defaults,
    // and deletes the entry: it gets the whole-repo pick's settings
    useStore.setState({ conns: withHarnesses() });
    await useStore.getState().setAgent("app", override);
    useStore.setState({ conns: withHarnesses(["claude"]) });
    await useStore.getState().setAgent("app", override);
    // no settings of its own there is that backend's reset
    useStore.setState({ conns: withHarnesses() });
    await useStore.getState().setAgent("app", { all: { profile: "deep" } });
    expect(bodies).toEqual([own, override, DEFAULT_AGENT]);
    useStore.setState({ conns: s.conns });
  });
});

describe("the registry after a failed first load", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    useStore.setState({ registry: {}, registryReady: false });
  });

  test("the first card event reads the whole list again, and a backend with no broker is not asked again", async () => {
    let calls = 0;
    let answer: { status: number; body: unknown } = { status: 502, body: { error: "the broker did not answer" } };
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (new URL(String(url), "http://x").pathname === "/api/registry") calls++;
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as unknown as typeof fetch;
    const full = (id: string): AgentCard => ({
      id,
      handle: id,
      node: "mini",
      harness: "claude",
      session: null,
      origin: "elsewhere",
      cwd: "/a/proj",
      repo: null,
      branch: null,
      model: null,
      mode: null,
      state: "working",
      waiting: null,
      caps: [],
      offers: [],
      notifyIdle: false,
      where: { os: "linux", container: false, pid: 1, term: null, canopy: null },
      transcript: null,
      startedAt: 1,
      seenAt: 2,
      endedAt: null,
    });
    const one = full("claude:one");
    const two = full("claude:two");
    await useStore.getState().loadRegistry();
    expect(useStore.getState().registryReady).toBe(false);
    // the broker is back: its first event brings the list with it
    answer = { status: 200, body: { ready: true, cards: [one, two] } };
    useStore.getState().applyEvent({ type: "registry", cards: [two] });
    await new Promise((r) => setTimeout(r, 20));
    expect(useStore.getState().registryReady).toBe(true);
    expect(Object.keys(useStore.getState().registry).sort()).toEqual(["claude:one", "claude:two"]);
    // no broker at all is a 503, which schedules nothing
    answer = { status: 503, body: { error: "tailchan is not set up on this backend" } };
    const before = calls;
    await useStore.getState().loadRegistry();
    expect(useStore.getState().registryReady).toBe(false);
    expect(calls).toBe(before + 1);
  });
});

describe("the asks list read while events land", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    useStore.setState({ asks: {}, asksReady: false, presence: null });
  });

  test("an ask an event closed meanwhile is not reopened by the list", async () => {
    const open: Ask = {
      id: "q1",
      agent: "claude:one",
      handle: "proj-0123",
      node: "mini",
      kind: "permission",
      tool: "Bash",
      title: "Bash: ls",
      detail: "ls",
      route: "remote",
      waitUntil: 9e15,
      state: "open",
      createdAt: 1,
    };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    globalThis.fetch = (async () => {
      await gate;
      // the list as the backend read it, before the answer
      return new Response(JSON.stringify({ ready: true, canAnswer: true, asks: [open], presence: null }), { status: 200 });
    }) as unknown as typeof fetch;
    useStore.setState({ asks: { q1: open } });
    const loading = useStore.getState().loadAsks();
    useStore.getState().applyEvent({ type: "asks", asks: [{ ...open, state: "answered", answeredBy: "phone@canopy", answeredAt: 2 }] });
    release();
    await loading;
    expect(useStore.getState().asks["q1"]?.state).toBe("answered");
  });
});

describe("the dock as columns of cells", () => {
  const pristine = useStore.getState();
  const realFetch = globalThis.fetch;
  const g = globalThis as unknown as { window?: unknown };
  const cols = (l: DockLayout) => l.columns.map((c) => c.cells.map((x) => x.panels));
  /** the invariant: the flat open list is the layout read in order */
  const mirrored = () => {
    const s = useStore.getState();
    expect(s.panels).toEqual(panelsOf(s.dockLayout));
  };
  const cell = (id: string) => cellOf(useStore.getState().dockLayout, id)?.id ?? "";
  const column = (id: string) => columnOf(useStore.getState().dockLayout, id)?.id ?? "";
  beforeEach(() => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ tasks: [], errors: [] }), { status: 200 })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete g.window;
    useStore.setState(
      {
        repos: [],
        panels: [],
        dockLayout: { columns: [] },
        activePanel: null,
        terms: [],
        shells: [],
        popped: {},
        recalled: [],
        panelWidths: {},
        settings: pristine.settings,
        loaded: false,
      },
    );
  });

  test("panels always mirror the layout", () => {
    const st = useStore.getState();
    useStore.setState({ panels: [], dockLayout: { columns: [] } });
    st.openPanel("a");
    st.openPanel("b");
    const c = cellOf(useStore.getState().dockLayout, "a")?.id ?? "";
    useStore.getState().dropPanel("b", c, "below");
    expect(useStore.getState().panels).toEqual(panelsOf(useStore.getState().dockLayout));
    useStore.getState().closePanel("a");
    expect(useStore.getState().panels).toEqual(["b"]);
  });

  test("panels set on their own bring the layout with them", () => {
    useStore.setState({ panels: ["a", "b", "c"], activePanel: "b" });
    expect(cols(useStore.getState().dockLayout)).toEqual([[["a"]], [["b"]], [["c"]]]);
    // a reorder set straight on the list is the list's
    useStore.setState({ panels: ["c", "a", "b"] });
    mirrored();
    expect(useStore.getState().panels).toEqual(["c", "a", "b"]);
  });

  test("the invariant holds through opens, a drop, pop-out and back, a checkout switch, a scan and a regroup", () => {
    const st = () => useStore.getState();
    g.window = { location: { href: "http://a.test/", search: "" }, open: () => ({ focus: () => {} }) };
    useStore.setState({ repos: [repo("a"), repo("b"), repo("c"), repo("a2")] });
    st().openPanel("a");
    mirrored();
    st().openPanel("b");
    st().openPanel("c");
    mirrored();
    st().dropPanel("b", cell("a"), "below");
    mirrored();
    expect(cols(st().dockLayout)).toEqual([[["a"], ["b"]], [["c"]]]);
    st().popOut("c");
    mirrored();
    expect(st().panels).toEqual(["a", "b"]);
    expect(st().popped).toEqual({ c: 2 });
    st().returnPanel("c");
    mirrored();
    expect(cols(st().dockLayout)).toEqual([[["a"], ["b"]], [["c"]]]);
    // a panel popped out of a split comes back as a column beside its old neighbour
    st().popOut("b");
    mirrored();
    st().returnPanel("b");
    mirrored();
    expect(cols(st().dockLayout)).toEqual([[["a"]], [["b"]], [["c"]]]);
    st().dropPanel("b", cell("a"), "below");
    st().switchCheckout("a", "a2");
    mirrored();
    expect(cols(st().dockLayout)).toEqual([[["a2"], ["b"]], [["c"]]]);
    st().applyEvent({ type: "scan", result: scanOf("/a", [repo("b"), repo("c")]) });
    mirrored();
    expect(cols(st().dockLayout)).toEqual([[["b"]], [["c"]]]);
    st().arrangeDock("tabs");
    mirrored();
    expect(cols(st().dockLayout)).toEqual([[["b", "c"]]]);
    expect(st().settings.openIn).toBe("tabs");
    st().openPanel("a2");
    mirrored();
    expect(cols(st().dockLayout)).toEqual([[["b", "c", "a2"]]]);
    st().arrangeDock("columns");
    mirrored();
    expect(cols(st().dockLayout)).toEqual([[["b"]], [["c"]], [["a2"]]]);
    expect(st().settings.openIn).toBe("dock");
  });

  test("in tabs a new panel joins the cell that was showing, not the last one", () => {
    useStore.setState({ panels: ["a", "b"], activePanel: "a" });
    useStore.getState().dropPanel("b", cell("a"), "below");
    useStore.getState().showPanel("a");
    useStore.setState({ settings: { ...useStore.getState().settings, openIn: "tabs" } });
    useStore.getState().openPanel("c");
    mirrored();
    expect(cols(useStore.getState().dockLayout)).toEqual([[["a", "c"], ["b"]]]);
    expect(useStore.getState().activePanel).toBe("c");
    expect(cellOf(useStore.getState().dockLayout, "c")?.active).toBe("c");
  });

  test("a hand-docked panel stays docked on its pop-out's hello, with a split open", () => {
    useStore.setState({ panels: ["x", "y"], activePanel: "x", popped: { app: 1 }, recalled: [] });
    useStore.getState().dropPanel("y", cell("x"), "below");
    useStore.getState().openPanel("app");
    expect(useStore.getState().recalled).toEqual(["app"]);
    useStore.getState().heardHello("app");
    mirrored();
    expect(useStore.getState().panels).toEqual(["x", "y", "app"]);
    expect(cols(useStore.getState().dockLayout)).toEqual([[["x"], ["y"]], [["app"]]]);
    expect(useStore.getState().popped).toEqual({});
  });

  test("moving a lone column keeps its width; a tab or a stacked cell moves inside its own place", () => {
    useStore.setState({ panels: ["a", "b", "c"], activePanel: "b" });
    useStore.getState().resizeColumn(column("c"), 600);
    useStore.getState().movePanel("c", 0);
    mirrored();
    expect(useStore.getState().panels).toEqual(["c", "a", "b"]);
    expect(useStore.getState().dockLayout.columns.map((c) => c.width)).toEqual([600, 440, 440]);
    // a stacked cell moves up its column
    useStore.getState().dropPanel("b", cell("a"), "below");
    useStore.getState().movePanel("b", 1);
    mirrored();
    expect(cols(useStore.getState().dockLayout)).toEqual([[["c"]], [["b"], ["a"]]]);
    // tabs reorder inside their cell, and the showing tab stays the one showing
    useStore.getState().arrangeDock("tabs");
    useStore.getState().showPanel("b");
    useStore.getState().movePanel("a", 0);
    mirrored();
    expect(useStore.getState().panels).toEqual(["a", "c", "b"]);
    expect(useStore.getState().activePanel).toBe("b");
    expect(cellOf(useStore.getState().dockLayout, "b")?.active).toBe("b");
  });

  test("a lone column's width outlives a close and a pop-out", () => {
    useStore.setState({ repos: [repo("app")], panels: ["x", "app", "y"], activePanel: "app" });
    useStore.getState().setPanelWidth("app", 610);
    expect(columnOf(useStore.getState().dockLayout, "app")?.width).toBe(610);
    useStore.getState().claimPanel("app");
    expect(useStore.getState().panelWidths.app).toBe(610);
    useStore.getState().returnPanel("app");
    mirrored();
    expect(useStore.getState().panels).toEqual(["x", "app", "y"]);
    expect(columnOf(useStore.getState().dockLayout, "app")?.width).toBe(610);
    useStore.getState().closePanel("app");
    useStore.getState().openPanel("app");
    expect(columnOf(useStore.getState().dockLayout, "app")?.width).toBe(610);
  });

  test("a scan that drops nothing keeps the very same layout", () => {
    useStore.setState({ repos: [repo("a"), repo("b")], panels: ["a", "b"], activePanel: "a" });
    const before = useStore.getState().dockLayout;
    useStore.getState().applyEvent({ type: "scan", result: scanOf("/a", [repo("a"), repo("b")]) });
    expect(useStore.getState().dockLayout).toBe(before);
  });

  test("a checkout switch keeps the panel's place in a split, and a sibling already open keeps its own", () => {
    useStore.setState({ panels: ["a", "b", "c"], activePanel: "b" });
    useStore.getState().dropPanel("b", cell("a"), "below");
    useStore.getState().switchCheckout("b", "b2");
    mirrored();
    expect(cols(useStore.getState().dockLayout)).toEqual([[["a"], ["b2"]], [["c"]]]);
    expect(useStore.getState().activePanel).toBe("b2");
    useStore.getState().switchCheckout("a", "c");
    mirrored();
    expect(cols(useStore.getState().dockLayout)).toEqual([[["b2"]], [["c"]]]);
  });

  test("a resize writes the layout, clamped, and the old width maps are left alone", () => {
    useStore.setState({ panels: ["a"], activePanel: "a" });
    useStore.getState().resizeColumn(column("a"), 99999);
    expect(columnOf(useStore.getState().dockLayout, "a")?.width).toBe(2400);
    useStore.getState().setDockWidth(500);
    expect(columnOf(useStore.getState().dockLayout, "a")?.width).toBe(500);
    expect(useStore.getState().panelWidths).toEqual({});
  });

  test("a seam drag moves the boundary in the layout", () => {
    useStore.setState({ panels: ["a", "b"], activePanel: "a" });
    useStore.getState().dropPanel("b", cell("a"), "below");
    useStore.getState().resizeSeam(column("a"), 0, 0.7);
    expect(useStore.getState().dockLayout.columns[0]?.cells.map((x) => x.share)).toEqual([0.7, 0.3]);
  });

  test("the saved layout is repaired, falls back to the old widths, and matches this window's panels", () => {
    expect(loadDock("bad", ["a", "b"], "b", { a: 500 }, 600, "columns").columns.map((c) => c.width)).toEqual([500, 440]);
    expect(loadDock(undefined, ["a", "b"], "b", {}, 600, "tabs").columns.map((c) => c.width)).toEqual([600]);
    const saved = {
      columns: [{ id: "c1", width: 99999, cells: [{ id: "c2", panels: ["b"], active: "b", share: 1 }, { id: "c3", panels: ["gone", "a"], active: "a", share: 1 }] }],
    };
    const l = loadDock(saved, ["a", "b", "c"], "a", { c: 300 }, 600, "columns");
    expect(cols(l)).toEqual([[["b"], ["a"]], [["c"]]]);
    expect(l.columns.map((c) => c.width)).toEqual([2400, 300]);
  });

  test("the layout is saved with the rest", () => {
    const s = useStore.getState();
    expect(layoutOf(s).dockLayout).toBe(s.dockLayout);
  });
});

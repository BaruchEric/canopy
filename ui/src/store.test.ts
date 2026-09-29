import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PANEL_TERM,
  agentFor,
  archivedCount,
  cardOf,
  changed,
  closedIn,
  closedSectionsOf,
  connOf,
  isOnline,
  layoutOf,
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
import { onBackendSignal } from "./api";
import { setBase, setRegistry } from "./registry";
import { hasOtherBackend, RETRY_FIRST } from "./backends";
import {
  DEFAULT_AGENT,
  type AgentSettings,
  type KeptShell,
  type PeerSeen,
  type Repo,
  type ScanResult,
  type SourceState,
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
    ]);
  });
  test("a section the reader unfolded stays unfolded once the layout knows it", () => {
    const saved = ["search", "history", "claude"];
    expect(closedSectionsOf(saved, ["search", "history", "claude", "launch", "peers", "preview"])).toBe(saved);
  });
  test("a stored fold is not doubled", () => {
    expect(closedSectionsOf(["launch"], [])).toEqual(["launch", "search", "history", "claude", "peers", "preview"]);
  });
});

describe("per-repo folds", () => {
  test("a repo nobody has touched folds the defaults", () => {
    expect(sectionsFor({}, "a")).toEqual(["search", "history", "claude", "launch", "peers", "preview"]);
    expect(closedIn({ closedSections: {} }, "a", "history")).toBe(true);
    expect(closedIn({ closedSections: {} }, "a", "changes")).toBe(false);
  });
  test("a toggle touches one repo and leaves the rest alone", () => {
    const one = toggleIn({}, "a", "history");
    expect(sectionsFor(one, "a")).toEqual(["search", "claude", "launch", "peers", "preview"]);
    expect(sectionsFor(one, "b")).toEqual(["search", "history", "claude", "launch", "peers", "preview"]);
    const two = toggleIn(one, "a", "changes");
    expect(closedIn({ closedSections: two }, "a", "changes")).toBe(true);
    expect(closedIn({ closedSections: two }, "b", "changes")).toBe(false);
  });
  test("unfolding hands back the same object when nothing is folded", () => {
    const closed = { a: ["search"] };
    expect(unfoldIn(closed, "a", "history")).toBe(closed);
    expect(sectionsFor(unfoldIn(closed, "a", "search"), "a")).toEqual([]);
    expect(sectionsFor(unfoldIn({}, "b", "launch"), "b")).toEqual(["search", "history", "claude", "peers", "preview"]);
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

  test("closing a panel leaves its shells running and its reopening brings them back", () => {
    globalThis.fetch = answer({ ok: true });
    const shell = "f".repeat(32);
    const panelTab = { id: shell, repoId: "app", name: "app", path: "/dev/app", place: "panel" as const };
    const held: TermInfo = { ...info(shell), place: "panel" };
    useStore.setState({ repos: [app], panels: ["app"], activePanel: "app", terms: [panelTab], shells: [held], hiddenTerms: [] });
    useStore.getState().closePanel("app");
    expect(calls).toEqual([]);
    expect(useStore.getState().terms).toEqual([]);
    // the server still lists it; with its panel closed it waits
    useStore.getState().applyEvent({ type: "terms", terms: [held] });
    expect(useStore.getState().terms).toEqual([]);
    useStore.getState().openPanel("app");
    expect(useStore.getState().terms.map((t) => t.id)).toEqual([shell]);
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

  test("a repo leaving the scan drops its tasks", async () => {
    await start(
      backendAnswers(scanOf("/a", [repo("proj")]), [], { "/api/backends": twoBackends }),
      backendAnswers(scanOf("/b", [repo("proj")]), []),
    );
    await settle();
    const t = (repoId: string) => ({ name: "dev", cmd: "x", repoId, source: "detected" as const, termId: "0".repeat(32), status: "running" as const, live: true, restarts: 0, viewers: [] });
    useStore.setState({ tasks: { proj: [t("proj")], "b|proj": [t("b|proj")] }, taskErrors: { "b|proj": ["x"] }, taskAll: [t("proj"), t("b|proj")] });
    useStore.getState().applyEvent({ type: "scan", result: { ...scanOf("/b", []), sources: [source("b|launch", "launch")] } }, "b");
    const s = useStore.getState();
    expect(Object.keys(s.tasks)).toEqual(["proj"]);
    expect(s.taskErrors).toEqual({});
    expect(s.taskAll.map((x) => x.repoId)).toEqual(["proj"]);
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
    expect(s.terms).toEqual([]);
    expect(s.parkedTerms.map((t) => t.id)).toEqual([bTab.id]);
    expect(layoutOf(s).terms.map((t) => t.id)).toEqual([bTab.id]);
    const saved = JSON.parse(store.get("canopy.layout") ?? "{}") as { terms?: { id: string }[]; panels?: string[] };
    expect(saved.terms?.map((t) => t.id)).toEqual([bTab.id]);
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

  test("agentFor reads the repo's own backend's settings", async () => {
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
    expect(saved.terms?.map((t) => t.id)).toEqual([bTab.id]);
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

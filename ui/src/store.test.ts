import { afterEach, describe, expect, test } from "bun:test";
import {
  PANEL_TERM,
  changed,
  closedIn,
  closedSectionsOf,
  panelTermHeightFor,
  pruneByRepo,
  sectionsFor,
  toggleIn,
  unfoldIn,
  useStore,
} from "./store";
import type { KeptShell, Repo, TermInfo } from "../../src/core/types";

describe("closedSectionsOf", () => {
  test("a layout from before the launch and peers sections folds them", () => {
    expect(closedSectionsOf(["search", "history", "claude"], ["search", "history", "claude"])).toEqual([
      "search",
      "history",
      "claude",
      "launch",
      "peers",
    ]);
  });
  test("a section the reader unfolded stays unfolded once the layout knows it", () => {
    const saved = ["search", "history", "claude"];
    expect(closedSectionsOf(saved, ["search", "history", "claude", "launch", "peers"])).toBe(saved);
  });
  test("a stored fold is not doubled", () => {
    expect(closedSectionsOf(["launch"], [])).toEqual(["launch", "search", "history", "claude", "peers"]);
  });
});

describe("per-repo folds", () => {
  test("a repo nobody has touched folds the defaults", () => {
    expect(sectionsFor({}, "a")).toEqual(["search", "history", "claude", "launch", "peers"]);
    expect(closedIn({ closedSections: {} }, "a", "history")).toBe(true);
    expect(closedIn({ closedSections: {} }, "a", "changes")).toBe(false);
  });
  test("a toggle touches one repo and leaves the rest alone", () => {
    const one = toggleIn({}, "a", "history");
    expect(sectionsFor(one, "a")).toEqual(["search", "claude", "launch", "peers"]);
    expect(sectionsFor(one, "b")).toEqual(["search", "history", "claude", "launch", "peers"]);
    const two = toggleIn(one, "a", "changes");
    expect(closedIn({ closedSections: two }, "a", "changes")).toBe(true);
    expect(closedIn({ closedSections: two }, "b", "changes")).toBe(false);
  });
  test("unfolding hands back the same object when nothing is folded", () => {
    const closed = { a: ["search"] };
    expect(unfoldIn(closed, "a", "history")).toBe(closed);
    expect(sectionsFor(unfoldIn(closed, "a", "search"), "a")).toEqual([]);
    expect(sectionsFor(unfoldIn({}, "b", "launch"), "b")).toEqual(["search", "history", "claude", "peers"]);
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
});

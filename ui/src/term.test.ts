import { describe, expect, test } from "bun:test";
import { PANEL_TERM_ROWS, adoptTerms, cellHeight, loadTermTabs, reconcileTerms, rowsPx, termId, type TermTab } from "./term";
import type { Repo, TermInfo } from "../../src/core/types";

describe("rowsPx", () => {
  test("is the rows at the cell height plus the box's padding and slack", () => {
    expect(rowsPx(5, 18)).toBe(5 * 18 + 13);
    expect(rowsPx(1, 17.5)).toBe(Math.ceil(17.5 + 13));
  });
  test("falls back to a plausible row where nothing can measure the font", () => {
    const cell = cellHeight();
    expect(cell).toBeGreaterThan(10);
    expect(cell).toBeLessThan(30);
    expect(rowsPx(PANEL_TERM_ROWS)).toBeGreaterThan(60);
  });
});

describe("termId", () => {
  test("32 hex digits, different each time", () => {
    const a = termId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(termId()).not.toBe(a);
  });
});

const repo = (id: string, path = `/dev/${id}`) => ({ id, name: id.split("/").pop() ?? id, path }) as Repo;
const tab = (id: string, repoId: string, place: TermTab["place"] = "strip"): TermTab => ({
  id,
  repoId,
  name: repoId,
  path: `/dev/${repoId}`,
  place,
});
const info = (id: string, repoId: string, place: TermInfo["place"] = "strip"): TermInfo => ({
  id,
  repoId,
  path: `/dev/${repoId}`,
  place,
  attached: false,
  viewers: [],
  startedAt: 1,
});

describe("loadTermTabs", () => {
  test("keeps well-formed tabs and drops the rest", () => {
    const good = tab("a", "app", "panel");
    expect(loadTermTabs([good, { id: "b" }, null, "x", { ...tab("c", "app"), place: "window" }])).toEqual([good]);
  });
  test("a tab whose shell had exited does not come back", () => {
    expect(loadTermTabs([{ ...tab("a", "app"), exit: 0 }, { ...tab("b", "app"), exit: null }])).toEqual([]);
  });
  test("anything but a list is no tabs", () => {
    expect(loadTermTabs(undefined)).toEqual([]);
    expect(loadTermTabs({ id: "a" })).toEqual([]);
  });
});

describe("reconcileTerms", () => {
  const repos = [repo("app"), repo("lib")];
  test("saved tabs with a live shell stay, in their order; the dead go", () => {
    const a = tab("a", "app");
    const c = tab("c", "app");
    const live = [info("c", "app"), info("a", "app")];
    expect(reconcileTerms([a, tab("b", "lib", "panel"), c], live, repos)).toEqual([a, c]);
  });
  test("a shell nobody saved gets a tab where it was opened", () => {
    const live = [info("z", "lib", "panel")];
    expect(reconcileTerms([], live, repos)).toEqual([
      { id: "z", repoId: "lib", name: "lib", path: "/dev/lib", place: "panel" },
    ]);
  });
  test("a shell at a repo the scan lost gets no tab", () => {
    expect(reconcileTerms([tab("a", "gone")], [info("a", "gone")], repos)).toEqual([]);
    expect(reconcileTerms([], [info("a", "gone")], repos)).toEqual([]);
  });
  test("nothing live means no tabs", () => {
    expect(reconcileTerms([tab("a", "app")], [], repos)).toEqual([]);
  });
});

describe("adoptTerms", () => {
  const repos = [repo("app"), repo("lib")];

  test("keeps every tab and adds a held strip shell no tab names", () => {
    const tabs = [tab("a", "app")];
    const out = adoptTerms(tabs, [info("a", "app"), info("b", "lib")], repos, []);
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
    expect(out[1]).toEqual({ id: "b", repoId: "lib", name: "lib", path: "/dev/lib", place: "strip" });
  });

  test("a tab whose shell is gone stays (its socket's exit frame marks it)", () => {
    const tabs = [tab("a", "app")];
    expect(adoptTerms(tabs, [], repos, [])).toBe(tabs);
  });

  test("a panel shell is adopted only when its panel is open here", () => {
    expect(adoptTerms([], [info("p", "app", "panel")], repos, []).length).toBe(0);
    expect(adoptTerms([], [info("p", "app", "panel")], repos, ["app"]).map((t) => t.place)).toEqual(["panel"]);
  });

  test("a shell at a repo not in the scan is left alone, and nothing new returns the same array", () => {
    const tabs = [tab("a", "app")];
    expect(adoptTerms(tabs, [info("a", "app"), info("z", "gone")], repos, [])).toBe(tabs);
  });
});

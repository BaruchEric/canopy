import { describe, expect, test } from "bun:test";
import { FOCUS_GAP, FOCUS_MIN, PANEL_TERM_ROWS, adoptTerms, keepFront, otherShells, shellSet, cellHeight, focusResize, loadFocusSize, loadTermTabs, nextStripTab, pruneHidden, reconcileTerms, rowsPx, termId, viewKey, type TermTab } from "./term";
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
  test("a shell nobody saved gets a tab where it was opened, a panel shell only where its panel is open", () => {
    const live = [info("z", "lib", "panel")];
    expect(reconcileTerms([], live, repos, ["lib"])).toEqual([
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
  test("an untabbed panel shell waits for its panel to be open, at load same as live", () => {
    const live = [info("p", "app", "panel")];
    expect(reconcileTerms([], live, repos, [])).toEqual([]);
    expect(reconcileTerms([], live, repos, ["app"])).toEqual([
      { id: "p", repoId: "app", name: "app", path: "/dev/app", place: "panel" },
    ]);
  });
  test("an untabbed strip shell still becomes a tab regardless of panels", () => {
    const live = [info("s", "app", "strip")];
    expect(reconcileTerms([], live, repos, [])).toEqual([
      { id: "s", repoId: "app", name: "app", path: "/dev/app", place: "strip" },
    ]);
  });
  test("a saved panel tab is kept whether or not its panel is in the passed list", () => {
    const saved = tab("a", "app", "panel");
    expect(reconcileTerms([saved], [info("a", "app", "panel")], repos, [])).toEqual([saved]);
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

  test("a shell this window ended is not taken back, even while the server still lists it", () => {
    const tabs = [tab("a", "app")];
    const out = adoptTerms(tabs, [info("a", "app"), info("closed", "app"), info("b", "lib")], repos, [], new Set(["closed"]));
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
    expect(adoptTerms([], [info("closed", "app")], repos, [], new Set(["closed"]))).toEqual([]);
  });

  test("a shell at a repo not in the scan is left alone, and nothing new returns the same array", () => {
    const tabs = [tab("a", "app")];
    expect(adoptTerms(tabs, [info("a", "app"), info("z", "gone")], repos, [])).toBe(tabs);
  });
});

describe("hidden shells", () => {
  const repos = [repo("app"), repo("lib")];

  test("a load does not make a tab of a shell this browser hid", () => {
    const out = reconcileTerms([], [info("a", "app"), info("h", "lib")], repos, [], new Set(["h"]));
    expect(out.map((t) => t.id)).toEqual(["a"]);
  });

  test("a hidden name goes once its shell does, and nothing gone keeps the array", () => {
    const hidden = ["h", "x"];
    expect(pruneHidden(hidden, [info("h", "app")])).toEqual(["h"]);
    const same = ["h"];
    expect(pruneHidden(same, [info("h", "app")])).toBe(same);
  });
});

describe("nextStripTab", () => {
  const tabs = [tab("a", "app"), tab("p", "app", "panel"), tab("b", "lib"), tab("c", "lib")];

  test("the showing tab going hands over to the one after it, else the one before", () => {
    expect(nextStripTab(tabs, "b", "b")).toBe("c");
    expect(nextStripTab(tabs, "c", "c")).toBe("b");
    expect(nextStripTab([tab("a", "app")], "a", "a")).toBeNull();
  });

  test("another tab going leaves the showing one", () => {
    expect(nextStripTab(tabs, "a", "c")).toBe("c");
  });
});

describe("viewKey", () => {
  test("the name alone until a restore gives the tab a new generation", () => {
    const t = tab("a", "app");
    expect(viewKey(t)).toBe("a");
    expect(viewKey({ ...t, gen: 1 })).toBe("a:1");
    expect(viewKey({ ...t, gen: 2 })).not.toBe(viewKey({ ...t, gen: 1 }));
  });
});

describe("focusResize", () => {
  const view = { w: 1400, h: 900 };
  test("grows by twice the drag, since the box stays centred", () => {
    expect(focusResize({ w: 800, h: 500 }, 50, 20, view)).toEqual({ w: 900, h: 540 });
    expect(focusResize({ w: 800, h: 500 }, -100, -50, view)).toEqual({ w: 600, h: 400 });
  });
  test("stops at the least usable size and at the window less a gap each side", () => {
    expect(focusResize({ w: 800, h: 500 }, -1000, -1000, view)).toEqual(FOCUS_MIN);
    expect(focusResize({ w: 800, h: 500 }, 1000, 1000, view)).toEqual({
      w: view.w - 2 * FOCUS_GAP,
      h: view.h - 2 * FOCUS_GAP,
    });
  });
  test("a window smaller than the least gets the least", () => {
    expect(focusResize({ w: 400, h: 300 }, 10, 10, { w: 300, h: 150 })).toEqual(FOCUS_MIN);
  });
});

describe("loadFocusSize", () => {
  test("two finite numbers, raised to the least", () => {
    expect(loadFocusSize({ w: 900, h: 600 })).toEqual({ w: 900, h: 600 });
    expect(loadFocusSize({ w: 10, h: 10 })).toEqual(FOCUS_MIN);
  });
  test("anything else is the default", () => {
    for (const v of [null, undefined, 3, "x", {}, { w: 900 }, { w: "900", h: 600 }, { w: NaN, h: 600 }, { w: Infinity, h: 1 }]) {
      expect(loadFocusSize(v)).toBeNull();
    }
  });
});

describe("otherShells", () => {
  const repo = (id: string): Repo => ({ id, name: id.toUpperCase(), path: `/w/${id}` }) as Repo;
  const repos = [repo("a"), repo("b"), repo("c")];
  const tab = (id: string, repoId: string, place: "strip" | "panel", exit?: number): TermTab => ({
    id,
    repoId,
    name: repoId.toUpperCase(),
    path: `/w/${repoId}`,
    place,
    ...(exit === undefined ? {} : { exit }),
  });
  const held = (id: string, repoId: string, place: "strip" | "panel", viewers: string[] = []): TermInfo => ({
    id,
    repoId,
    path: `/w/${repoId}`,
    place,
    attached: viewers.length > 0,
    viewers,
    startedAt: 0,
  });

  test("leaves out the set in front and exited tabs, tabs first", () => {
    const tabs = [tab("1", "a", "panel"), tab("2", "b", "panel"), tab("3", "c", "strip"), tab("4", "c", "panel", 0)];
    const live = [held("1", "a", "panel"), held("2", "b", "panel", ["phone"]), held("3", "c", "strip"), held("5", "c", "panel", ["mac"])];
    expect(otherShells("panel:a", tabs, live, repos)).toEqual([
      { id: "2", repoId: "b", label: "B", tabbed: true, viewers: ["phone"] },
      { id: "3", repoId: "c", label: "C 1", tabbed: true, viewers: [] },
      { id: "5", repoId: "c", label: "C 2", tabbed: false, viewers: ["mac"] },
    ]);
  });
  test("the strip set leaves out every strip shell, whatever its repo", () => {
    const tabs = [tab("1", "a", "strip"), tab("2", "b", "strip"), tab("3", "a", "panel")];
    expect(otherShells("strip", tabs, [], repos).map((o) => o.id)).toEqual(["3"]);
  });
  test("a held shell for a repo gone from the scan is left out", () => {
    expect(otherShells("strip", [], [held("9", "gone", "panel")], repos)).toEqual([]);
  });
  test("a machine word is appended to the label when the caller gives one", () => {
    const tabs = [tab("1", "a", "panel")];
    const live = [held("2", "b", "strip")];
    const out = otherShells("panel:a", tabs, live, repos, (id) => (id === "b" ? "mini" : ""));
    expect(out).toEqual([{ id: "2", repoId: "b", label: "B · mini", tabbed: false, viewers: [] }]);
  });
  test("with no word function the label is unchanged", () => {
    const live = [held("2", "b", "strip")];
    expect(otherShells("panel:a", [], live, repos)[0]?.label).toBe("B");
  });
  test("a tabbed shell whose repo is off this window's list prints through idOf, not the raw id", () => {
    const tabs = [tab("1", "a", "panel"), tab("2", "mini|gone", "panel")];
    const out = otherShells("panel:a", tabs, [], repos, undefined, (id) => `${id} (away)`);
    expect(out).toEqual([{ id: "2", repoId: "mini|gone", label: "mini|gone (away)", tabbed: true, viewers: [] }]);
  });
  test("with no idOf function the fallback is the raw id", () => {
    const tabs = [tab("1", "a", "panel"), tab("2", "mini|gone", "panel")];
    const out = otherShells("panel:a", tabs, [], repos);
    expect(out.find((o) => o.id === "2")?.label).toBe("mini|gone");
  });
  test("word and idOf together do not double the machine name", () => {
    const tabs = [tab("1", "a", "panel"), tab("2", "mini|gone", "panel")];
    const out = otherShells(
      "panel:a",
      tabs,
      [],
      repos,
      (id) => (id === "mini|gone" ? "mini" : ""),
      (id) => id.split("|")[1] ?? id,
    );
    expect(out.find((o) => o.id === "2")?.label).toBe("gone · mini");
  });
  test("shellSet and keepFront", () => {
    expect(shellSet(tab("1", "strip", "panel"))).toBe("panel:strip");
    expect(keepFront("panel:a", [tab("1", "a", "panel")])).toBe("panel:a");
    expect(keepFront("panel:a", [tab("1", "a", "strip")])).toBeNull();
    expect(keepFront(null, [tab("1", "a", "panel")])).toBeNull();
  });
});

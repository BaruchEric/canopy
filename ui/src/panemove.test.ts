import { describe, expect, test } from "bun:test";
import { canMove, movableOf, movedId, movePage, type Movable } from "./panemove";
import { addItemTab, addSectionTab, itemTabId, sectionTabId, type ItemTab, type SectionTab } from "./sectiontabs";
import type { TermTab } from "./term";

const shell = (over: Partial<TermTab> = {}): TermTab => ({ id: "s1", repoId: "web/ripe", name: "ripe", path: "/dev/web/ripe", place: "strip", ...over });
const asShell = (t: TermTab): Movable => ({ kind: "shell", tab: t });
const sections: SectionTab[] = addSectionTab([], "panel", "web/ripe", "history");
const items: ItemTab[] = addItemTab(addItemTab([], "strip", { kind: "popup", ref: "inbox", label: "inbox" }), "panel", { kind: "run", ref: "r1", label: "run r1", repoId: "web/ripe" });
const page = (id: string): Movable => {
  const m = movableOf([], sections, items, id);
  if (!m) throw new Error(`no tab ${id}`);
  return m;
};

describe("which window takes a tab from another", () => {
  test("a strip shell goes to its own repo's card, and back", () => {
    expect(canMove(asShell(shell()), { place: "panel", repoId: "web/ripe" })).toBe(true);
    expect(canMove(asShell(shell()), { place: "panel", repoId: "web/tally" })).toBe(false);
    expect(canMove(asShell(shell({ place: "panel" })), { place: "strip" })).toBe(true);
  });
  test("a window never takes what it holds already, nor a shell window a shell", () => {
    expect(canMove(asShell(shell()), { place: "strip" })).toBe(false);
    expect(canMove(asShell(shell({ place: "panel" })), { place: "panel", repoId: "web/ripe" })).toBe(false);
    expect(canMove(asShell(shell()), { place: "window", repoId: "web/ripe" })).toBe(false);
  });
  test("a task's, the ranger's, a joined view's and an ended shell stay put", () => {
    for (const over of [{ task: "t1" }, { ranger: true as const }, { joinOnly: true as const }, { exit: 0 }])
      expect(canMove(asShell(shell(over)), { place: "panel", repoId: "web/ripe" })).toBe(false);
  });
  test("a section goes to the strip, or its own card or shell window", () => {
    const hist = page(sectionTabId("panel", "history", "web/ripe"));
    expect(canMove(hist, { place: "strip" })).toBe(true);
    expect(canMove(hist, { place: "window", repoId: "web/ripe" })).toBe(true);
    expect(canMove(hist, { place: "panel", repoId: "web/tally" })).toBe(false);
  });
  test("a popup takes no card, a run only its own", () => {
    const inbox = page(itemTabId("strip", "popup", "inbox"));
    expect(canMove(inbox, { place: "panel", repoId: "web/ripe" })).toBe(false);
    const run = page(itemTabId("panel", "run", "r1"));
    expect(canMove(run, { place: "strip" })).toBe(true);
    expect(canMove(run, { place: "window", repoId: "web/ripe" })).toBe(false);
  });
});

describe("a page tab once it lands", () => {
  test("takes the id of its new place and leaves the old one", () => {
    const hist = page(sectionTabId("panel", "history", "web/ripe"));
    expect(movedId(hist, { place: "strip" })).toBe(sectionTabId("strip", "history", "web/ripe"));
    if (hist.kind !== "page") throw new Error("not a page");
    const out = movePage(sections, items, hist.tab, { place: "strip" });
    expect(out.sections.map((t) => t.id)).toEqual([sectionTabId("strip", "history", "web/ripe")]);
    expect(out.items).toEqual(items);
  });
  test("a chat keeps its repo and label", () => {
    const run = page(itemTabId("panel", "run", "r1"));
    if (run.kind !== "page") throw new Error("not a page");
    const out = movePage(sections, items, run.tab, { place: "strip" });
    const moved = out.items.find((t) => t.ref === "r1");
    expect(moved).toEqual({ id: itemTabId("strip", "run", "r1"), kind: "run", ref: "r1", label: "run r1", repoId: "web/ripe", place: "strip" });
    expect(out.items.filter((t) => t.ref === "r1")).toHaveLength(1);
  });
  test("a shell keeps its id", () => {
    expect(movedId(asShell(shell()), { place: "panel", repoId: "web/ripe" })).toBe("s1");
  });
});

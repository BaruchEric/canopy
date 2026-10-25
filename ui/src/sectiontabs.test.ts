import { describe, expect, test } from "bun:test";
import {
  addSectionTab,
  dropSectionTab,
  isSectionTabId,
  sectionApplies,
  sectionTabId,
  sectionTabLabel,
  sectionTabsAt,
  sectionTabsOf,
  tabbableKeys,
  tabbedKeys,
} from "./sectiontabs";
import { pruneGroups, splitIn } from "./splitpanes";

const repo = { id: "mac/canopy", forge: undefined, spec: undefined, host: undefined };

describe("section tabs", () => {
  test("an id no shell has, made from its parts", () => {
    const id = sectionTabId("panel", "history", "mac/canopy");
    expect(id).toBe("sec:panel:history:mac/canopy");
    expect(isSectionTabId(id)).toBe(true);
    expect(isSectionTabId("mac/t-1a2b")).toBe(false);
  });

  test("a section is a tab in one place only", () => {
    let tabs = addSectionTab([], "panel", "mac/canopy", "history");
    tabs = addSectionTab(tabs, "strip", "mac/canopy", "history");
    expect(tabs).toEqual([{ id: "sec:strip:history:mac/canopy", repoId: "mac/canopy", key: "history", place: "strip" }]);
    tabs = addSectionTab(tabs, "panel", "mac/canopy", "files");
    expect(sectionTabsAt(tabs, "panel").map((t) => t.key)).toEqual(["files"]);
    expect(sectionTabsAt(tabs, "strip", "mac/other")).toEqual([]);
    expect([...tabbedKeys(tabs, "mac/canopy")].sort()).toEqual(["files", "history"]);
    expect(dropSectionTab(tabs, "sec:strip:history:mac/canopy").map((t) => t.key)).toEqual(["files"]);
  });

  test("the saved list read back drops what does not check out", () => {
    const got = sectionTabsOf([
      { repoId: "mac/canopy", key: "history", place: "panel", id: "forged" },
      { repoId: "mac/canopy", key: "history", place: "strip" },
      { repoId: "mac/canopy", key: "nope", place: "panel" },
      { repoId: "", key: "files", place: "panel" },
      { repoId: "mac/canopy", key: "files", place: "dock" },
      "junk",
    ]);
    expect(got).toEqual([{ id: "sec:panel:history:mac/canopy", repoId: "mac/canopy", key: "history", place: "panel" }]);
    expect(sectionTabsOf("junk")).toEqual([]);
  });

  test("what a repo can show as a tab", () => {
    expect(sectionApplies("files", { forge: { kind: "forgejo" } } as never)).toBe(false);
    expect(sectionApplies("spec", repo)).toBe(false);
    expect(sectionApplies("preview", { ...repo, host: "mini" })).toBe(false);
    const tabs = addSectionTab([], "panel", "mac/canopy", "history");
    const keys = tabbableKeys(tabs, repo);
    expect(keys).not.toContain("history");
    expect(keys).not.toContain("spec");
    expect(keys).toContain("files");
    expect(tabbableKeys(tabs, repo, undefined, ["files"])).not.toContain("files");
  });

  test("a label names the repo where the row mixes repos", () => {
    const [t] = addSectionTab([], "strip", "mac/canopy", "changes");
    if (!t) throw new Error("no tab");
    expect(sectionTabLabel(t)).toBe("changes");
    expect(sectionTabLabel(t, "canopy")).toBe("changes · canopy");
  });

  test("a split group holds a section tab beside a shell", () => {
    const sec = sectionTabId("panel", "history", "mac/canopy");
    const groups = splitIn([], "mac/t-1", sec, "left");
    expect(pruneGroups(groups, new Set(["mac/t-1", sec]))).toEqual(groups);
    expect(pruneGroups(groups, new Set(["mac/t-1"]))).toEqual([]);
  });
});

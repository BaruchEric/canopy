import { describe, expect, test } from "bun:test";
import { recommendTabs } from "../../src/core/screenlayouts";
import { addItemTab, addSectionTab, sectionTabId } from "./sectiontabs";
import { splitIn } from "./splitpanes";
import { applyTabs, captureTabs, tabsWords, type TabState } from "./tabtemplates";

const repo = (id: string) => ({ id, forge: undefined, spec: undefined, host: undefined });
const empty: TabState = { sectionTabs: [], itemTabs: [], panelSplits: [] };

describe("tab templates", () => {
  test("a window's tabs read back as names, its first shell as shell", () => {
    const hist = sectionTabId("panel", "history", "mac/a");
    const s: TabState = {
      sectionTabs: addSectionTab(addSectionTab([], "panel", "mac/a", "history"), "panel", "mac/a", "files"),
      itemTabs: addItemTab([], "strip", { kind: "popup", ref: "tasks", label: "tasks" }),
      panelSplits: splitIn(splitIn([], hist, "t1", "right"), "t1", "t2", "bottom"),
    };
    const t = captureTabs(s, [{ repo: repo("mac/b"), shell: null }, { repo: repo("mac/a"), shell: "t1" }]);
    expect(t).toEqual({ panel: ["history", "files"], split: { dir: "row", at: 0.5, a: { pane: "history" }, b: { pane: "shell" } }, strip: ["tasks"] });
    expect(captureTabs(empty, [])).toEqual({ panel: [], strip: [] });
  });

  test("a template lands on every card by name", () => {
    const t = recommendTabs(2560);
    const got = applyTabs(t, empty, [
      { repo: repo("mac/a"), shell: "t1" },
      { repo: { ...repo("mini/f"), forge: { kind: "forgejo" } } as never, shell: null },
    ]);
    expect(got.sectionTabs.map((x) => x.id)).toEqual([
      sectionTabId("panel", "changes", "mac/a"),
      sectionTabId("panel", "history", "mac/a"),
      sectionTabId("panel", "changes", "mini/f"),
      sectionTabId("panel", "history", "mini/f"),
    ]);
    // the card with a shell gets the whole split; the one without, its sections split alone
    expect(got.panelSplits).toHaveLength(2);
    expect(JSON.stringify(got.panelSplits[0])).toContain("t1");
    expect(got.itemTabs.map((x) => x.ref)).toEqual(["tasks"]);
  });

  test("what a card had there goes back, and an empty template clears", () => {
    const before = applyTabs(recommendTabs(1920), empty, [{ repo: repo("mac/a"), shell: "t1" }]);
    expect(before.sectionTabs.map((x) => x.key)).toEqual(["history"]);
    const after = applyTabs({ panel: [], strip: [] }, before, [{ repo: repo("mac/a"), shell: "t1" }]);
    expect(after).toEqual(empty);
  });

  test("a template in words", () => {
    expect(tabsWords(recommendTabs(2560))).toBe("cards: changes | (history / shell) · strip: tasks");
    expect(tabsWords({ panel: ["files"] })).toBe("cards: files");
    expect(tabsWords({})).toBe("no tabs");
  });
});

import { describe, expect, test } from "bun:test";
import { IN_CHECKOUT, NEW_WORKTREE, agentChip, boxDrops, boxFits, boxHeld, boxNotes, fewerTitle, ownBranchWords, placeChips, routeWords, type BoxAgent, type BoxChip, type BoxPlace } from "./startbox";

const place = (over: Partial<BoxPlace> = {}): BoxPlace => ({ repo: "ripe", workspace: null, branch: "main", branchable: true, onBranch: false, beside: false, backend: "mac", host: null, ...over });
const chip = (chips: readonly BoxChip[], id: BoxChip["id"]): BoxChip => {
  const c = chips.find((x) => x.id === id);
  if (!c) throw new Error(`no ${id} chip`);
  return c;
};

describe("which starts get the box", () => {
  test("one plain run or chat does", () => {
    expect(boxFits("ask")).toBe(true);
    expect(boxFits("propose")).toBe(true);
    expect(boxFits("chat")).toBe(true);
  });

  test("a coordinator and a compare keep the pre-flight", () => {
    expect(boxFits("coordinate")).toBe(false);
    expect(boxFits("compare")).toBe(false);
  });
});

describe("the chips on the top edge", () => {
  test("are the repo, the branch and the backend, in that order", () => {
    expect(placeChips(place()).map((c) => c.id)).toEqual(["repo", "branch", "backend"]);
  });

  test("the repo and the backend are plain text: the pre-flight changes neither", () => {
    const chips = placeChips(place());
    expect(chip(chips, "repo")).toMatchObject({ text: "ripe", menu: null });
    expect(chip(chips, "backend")).toMatchObject({ text: "mac", menu: null });
  });

  test("a run in the checkout reads its branch, and the chip offers a worktree", () => {
    const c = chip(placeChips(place()), "branch");
    expect(c.text).toBe("main");
    expect(c.menu?.value).toBe(IN_CHECKOUT);
    expect(c.menu?.options.map((o) => [o.value, o.label])).toEqual([
      [IN_CHECKOUT, "main"],
      [NEW_WORKTREE, "new worktree"],
    ]);
  });

  test("a branch run reads new worktree", () => {
    const c = chip(placeChips(place({ onBranch: true })), "branch");
    expect(c.text).toBe("new worktree");
    expect(c.menu?.value).toBe(NEW_WORKTREE);
  });

  test("a start that opened on a worktree because the checkout is in use says so on the chip", () => {
    const c = chip(placeChips(place({ onBranch: true, beside: true })), "branch");
    expect(c.text).toBe("new worktree");
    expect(c.title).toStartWith("This checkout is in use, so the agent works in a worktree of its own");
    // the way back is the chip's first choice
    expect(c.menu?.options[0]).toMatchObject({ value: IN_CHECKOUT, label: "main", what: "in the checkout, beside what is going there" });
    // picked back into the checkout, the chip reads as any run there
    expect(chip(placeChips(place({ onBranch: false, beside: true })), "branch").title).toContain("beside whatever else is going there");
  });

  test("a checkout whose status is not read yet still has a branch chip", () => {
    const c = chip(placeChips(place({ branch: null })), "branch");
    expect(c.text).toBe("the checkout");
    expect(c.menu?.options[0]?.label).toBe("the checkout");
  });

  test("a workspace run names the workspace and cannot take a branch", () => {
    const chips = placeChips(place({ workspace: "daily", branchable: false }));
    expect(chip(chips, "repo").text).toBe("workspace daily");
    expect(chip(chips, "repo").title).toContain("ripe");
    expect(chip(chips, "branch")).toMatchObject({ text: "main", menu: null });
    expect(chip(chips, "branch").title).toContain("workspace");
  });

  test("a checkout on another host is plain text, and the backend chip names the host", () => {
    const chips = placeChips(place({ branchable: false, host: "gpd" }));
    expect(chip(chips, "branch").menu).toBeNull();
    expect(chip(chips, "branch").title).toContain("gpd");
    expect(chip(chips, "backend").text).toBe("gpd · mac");
  });

  test("a repo on the forge is plain text", () => {
    const c = chip(placeChips(place({ branchable: false })), "branch");
    expect(c.menu).toBeNull();
    expect(c.title).toContain("forge");
  });
});

describe("the chip on the bottom edge", () => {
  const agent = (over: Partial<BoxAgent> = {}): BoxAgent => ({ loadouts: [], pick: "", inherited: "the repo's route", inherits: false, loadout: null, route: "opus · high", ...over });
  const two = [
    { name: "quick", label: "quick (haiku, low)", note: "small jobs" },
    { name: "deep", label: "deep (opus, high)", note: "hard ones" },
  ];

  test("with no loadout on offer it is the route's model, as plain text", () => {
    expect(agentChip(agent())).toMatchObject({ id: "agent", text: "opus · high", menu: null });
  });

  test("with loadouts on offer it opens them, the inherited choice first", () => {
    const c = agentChip(agent({ loadouts: two }));
    expect(c.text).toBe("opus · high");
    expect(c.menu?.value).toBe("");
    expect(c.menu?.options.map((o) => o.value)).toEqual(["", "quick", "deep"]);
    expect(c.menu?.options[0]?.label).toBe("the repo's route");
    expect(c.menu?.options[1]).toEqual({ value: "quick", label: "quick (haiku, low)", what: "small jobs" });
  });

  test("a picked loadout is the chip's words and the menu's choice", () => {
    const c = agentChip(agent({ loadouts: two, pick: "deep", loadout: "deep (opus, high)" }));
    expect(c.text).toBe("deep (opus, high)");
    expect(c.menu?.value).toBe("deep");
  });

  test("an inherited loadout shows, and going without is a choice of its own", () => {
    const c = agentChip(agent({ loadouts: two, inherits: true, inherited: "quick (haiku, low), the kit's default", loadout: "quick (haiku, low)" }));
    expect(c.text).toBe("quick (haiku, low)");
    expect(c.menu?.options.map((o) => o.value)).toEqual(["", "none", "quick", "deep"]);
    expect(c.menu?.options[1]?.what).toBe("the repo's route: opus · high");
  });

  test("going without reads the route's model", () => {
    const c = agentChip(agent({ loadouts: two, inherits: true, pick: "none" }));
    expect(c.text).toBe("opus · high");
    expect(c.menu?.value).toBe("none");
  });

  test("a pick the list no longer has reads as no pick", () => {
    expect(agentChip(agent({ loadouts: two, pick: "gone" })).menu?.value).toBe("");
  });

  test("the route's words: model and effort, the harness when it is not Claude Code", () => {
    expect(routeWords({ harness: "claude", model: "opus", effort: "high" }, "Claude Code")).toBe("opus · high");
    expect(routeWords({ harness: "claude", model: "default", effort: "default" }, "Claude Code")).toBe("default model");
    expect(routeWords({ harness: "claude", model: "default", effort: "high" }, "Claude Code")).toBe("default model · high");
    expect(routeWords({ harness: "codex", model: "gpt-5.5", effort: "default" }, "Codex")).toBe("Codex · gpt-5.5");
  });
});

describe("what the box says before a start", () => {
  const none = { besideFlow: null, memberFlows: [], ownBranch: false, branch: "main", chatHint: null };

  test("nothing, when the pre-flight has nothing to say", () => {
    expect(boxNotes(none)).toEqual([]);
  });

  test("the workflow going in the checkout the run will share", () => {
    expect(boxNotes({ ...none, besideFlow: "The ship workflow is going in this checkout." })).toEqual(["The ship workflow is going in this checkout."]);
  });

  test("why the start opened on a worktree, with the branch chip as the way back", () => {
    const [line, ...rest] = boxNotes({ ...none, ownBranch: true });
    expect(rest).toEqual([]);
    expect(line).toBe(ownBranchWords("main"));
    expect(line).toContain("This checkout is in use, so the run starts in a worktree of its own");
    expect(line).toContain("Pick main on the branch chip");
    // the pre-flight's line points at its checkbox, which the box does not have
    expect(line).not.toContain("Untick");
  });

  test("a checkout whose branch is not read yet is named as the checkout", () => {
    expect(ownBranchWords(null)).toContain("Pick the checkout on the branch chip");
  });

  test("every line at once comes in the pre-flight's order", () => {
    expect(boxNotes({ besideFlow: "flow here", memberFlows: ["flow in api", "flow in web"], ownBranch: true, branch: "dev", chatHint: "say what it is for" })).toEqual([
      "flow here",
      "flow in api",
      "flow in web",
      ownBranchWords("dev"),
      "say what it is for",
    ]);
  });
});

describe("a start that is held", () => {
  test("a branch run with no slot free says why", () => {
    expect(boxHeld({ branchable: true, onBranch: true, free: 0, slots: 3 })).toContain("All 3 branch slots");
  });

  test("a run in the checkout, a free slot, or a start that takes no branch is not held", () => {
    expect(boxHeld({ branchable: true, onBranch: false, free: 0, slots: 3 })).toBeNull();
    expect(boxHeld({ branchable: true, onBranch: true, free: 1, slots: 3 })).toBeNull();
    expect(boxHeld({ branchable: false, onBranch: true, free: 0, slots: 3 })).toBeNull();
  });
});

describe("the way back from the full pre-flight", () => {
  const none = { times: 1, pr: false, dev: false, tools: false };
  test("drops only the picks the box does not draw that were changed", () => {
    expect(boxDrops(none)).toEqual([]);
    expect(boxDrops({ ...none, times: 3 })).toEqual(["3 tries"]);
    expect(boxDrops({ times: 2, pr: true, dev: true, tools: true })).toEqual(["2 tries", "the PR", "the dev task", "the canopy tools pick"]);
  });

  test("says what it keeps, and names what it drops", () => {
    expect(fewerTitle([])).toBe("Back to the one box, with the words and the picks it shows kept");
    expect(fewerTitle(["the PR"])).toBe("Back to the one box, with the words and the picks it shows kept. It drops the PR");
    expect(fewerTitle(["3 tries", "the PR", "the dev task"])).toBe("Back to the one box, with the words and the picks it shows kept. It drops 3 tries, the PR and the dev task");
  });
});

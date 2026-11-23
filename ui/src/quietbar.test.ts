import { describe, expect, test } from "bun:test";
import { BAR_CHIPS, BAR_PRIORITY, barChip, barChips, chipId, crowdedChips, moreGroups, putAway, speaking, type BarChipId, type BarFacts } from "./quietbar";

/** a page with nothing going: no chip has anything to say */
const QUIET: BarFacts = {
  sort: "recent",
  attention: 0,
  dirtyOnly: false,
  filters: 0,
  sources: 2,
  sourcesBroken: 0,
  workspaces: 0,
  workspace: null,
  feedOpen: false,
  selecting: false,
  picked: 0,
  waiting: 0,
  waitingOpen: false,
  inbox: 0,
  inboxReady: true,
  notes: 0,
  clipsFresh: false,
  chan: false,
  chanUnread: 0,
  runs: 0,
  runsWaiting: 0,
  shells: 0,
  shellsElsewhere: 0,
  kept: 0,
  tasks: 0,
  tasksRunning: 0,
  taskTrouble: null,
  rangers: 0,
  rangerTone: "off",
  capacity: 1,
  capacityWord: "5h 12%",
  capacityTone: "moss",
  held: 0,
  limited: 0,
  health: 4,
  healthLevel: "ok",
  healthWord: "ok",
  backend: "mini",
  backendState: "online",
  peersLost: 0,
};
const facts = (over: Partial<BarFacts>): BarFacts => ({ ...QUIET, ...over });
const says = (id: BarChipId, over: Partial<BarFacts>): boolean => {
  const c = barChip(id, facts(over));
  return c.there && c.says;
};
const state = (id: BarChipId, over: Partial<BarFacts> = {}): string => barChip(id, facts(over)).state;

describe("the quiet bar", () => {
  test("a page with nothing going keeps every chip off the bar", () => {
    expect([...speaking(barChips(QUIET))]).toEqual([]);
  });

  test("every chip has a name and a state to list", () => {
    const chips = barChips(QUIET);
    expect(chips.map((c) => c.id)).toEqual([...BAR_CHIPS]);
    for (const c of chips) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.state.length).toBeGreaterThan(0);
    }
  });

  test("the grouping and the rescan are settings and tools: they never speak", () => {
    expect(says("sort", { sort: "state" })).toBe(false);
    expect(state("sort", { sort: "state" })).toBe("by state");
    expect(says("rescan", {})).toBe(false);
  });

  test("needs attention speaks with a count above zero, or while it narrows the board", () => {
    expect(says("attention", {})).toBe(false);
    expect(says("attention", { attention: 3 })).toBe(true);
    expect(says("attention", { dirtyOnly: true })).toBe(true);
    expect(state("attention")).toBe("all quiet");
    expect(state("attention", { attention: 1 })).toBe("1 repo");
    expect(state("attention", { attention: 3, dirtyOnly: true })).toBe("3 repos, the only ones shown");
  });

  test("the filters speak while one is on", () => {
    expect(says("filters", {})).toBe(false);
    expect(says("filters", { filters: 2 })).toBe(true);
    expect(state("filters", { filters: 2 })).toBe("2 on");
  });

  test("the scanned folders speak when a scan failed", () => {
    expect(says("sources", {})).toBe(false);
    expect(state("sources")).toBe("2 folders");
    expect(says("sources", { sourcesBroken: 1 })).toBe(true);
    expect(state("sources", { sourcesBroken: 1 })).toBe("1 of 2 failed to scan");
  });

  test("the workspace is absent with none, and speaks while one narrows the board", () => {
    expect(barChip("workspaces", QUIET).there).toBe(false);
    expect(says("workspaces", { workspaces: 2 })).toBe(false);
    expect(state("workspaces", { workspaces: 2 })).toBe("all repos, 2 workspaces to pick from");
    expect(says("workspaces", { workspaces: 2, workspace: "site" })).toBe(true);
    expect(state("workspaces", { workspaces: 2, workspace: "site" })).toBe("showing site");
    // a name kept from a workspace that is gone does not bring an absent chip back
    expect(says("workspaces", { workspaces: 0, workspace: "site" })).toBe(false);
  });

  test("a switch that is on speaks: the feed and the picking", () => {
    expect(says("feed", {})).toBe(false);
    expect(says("feed", { feedOpen: true })).toBe(true);
    expect(says("select", {})).toBe(false);
    expect(says("select", { selecting: true, picked: 0 })).toBe(true);
    expect(state("select", { selecting: true, picked: 2 })).toBe("2 picked");
  });

  test("what is for you speaks with a count above zero", () => {
    expect(says("waiting", { waiting: 1 })).toBe(true);
    expect(state("waiting", { waiting: 1 })).toBe("1 thing");
    expect(says("waiting", { waitingOpen: true })).toBe(true);
    expect(says("inbox", { inbox: 2 })).toBe(true);
    expect(state("inbox", { inbox: 2 })).toBe("2 items");
    expect(says("notes", { notes: 1 })).toBe(true);
    expect(says("clips", { clipsFresh: true })).toBe(true);
    expect(says("chan", { chan: true, chanUnread: 4 })).toBe(true);
    expect(state("chan", { chan: true, chanUnread: 4 })).toBe("4 new");
  });

  test("the inbox is absent until the asks have loaded, and tailchan until it is set up", () => {
    expect(barChip("inbox", facts({ inboxReady: false })).there).toBe(false);
    expect(barChip("inbox", facts({ inboxReady: false, inbox: 1 })).there).toBe(true);
    expect(barChip("chan", QUIET).there).toBe(false);
    expect(says("chan", { chan: false, chanUnread: 3 })).toBe(false);
    expect(says("chan", { chan: true })).toBe(false);
  });

  test("a run going puts the runs on the bar, and none leaves them out of the menu too", () => {
    expect(barChip("runs", QUIET).there).toBe(false);
    expect(says("runs", { runs: 2 })).toBe(true);
    expect(state("runs", { runs: 2 })).toBe("2 going");
    expect(state("runs", { runs: 2, runsWaiting: 1 })).toBe("2 going, 1 needs you");
    expect(state("runs", { runs: 3, runsWaiting: 2 })).toBe("3 going, 2 need you");
  });

  test("shells speak while one runs, kept shells while there is one to restore", () => {
    expect(says("shells", {})).toBe(false);
    expect(state("shells")).toBe("none running");
    expect(says("shells", { shells: 2, shellsElsewhere: 1 })).toBe(true);
    expect(state("shells", { shells: 2, shellsElsewhere: 1 })).toBe("2 running, 1 not open here");
    expect(barChip("kept", QUIET).there).toBe(false);
    expect(says("kept", { kept: 1 })).toBe(true);
  });

  test("tasks speak while one runs or is in trouble, not for being defined", () => {
    expect(barChip("tasks", QUIET).there).toBe(false);
    expect(says("tasks", { tasks: 3 })).toBe(false);
    expect(state("tasks", { tasks: 3 })).toBe("none running");
    expect(says("tasks", { tasks: 3, tasksRunning: 1 })).toBe(true);
    expect(says("tasks", { tasks: 3, taskTrouble: "dev failed" })).toBe(true);
    expect(state("tasks", { tasks: 3, taskTrouble: "dev failed" })).toBe("dev failed");
  });

  test("a ranger that runs is the usual state; one starting or stuck speaks", () => {
    expect(barChip("ranger", QUIET).there).toBe(false);
    expect(says("ranger", { rangers: 1, rangerTone: "ok" })).toBe(false);
    expect(says("ranger", { rangers: 1, rangerTone: "busy" })).toBe(true);
    expect(says("ranger", { rangers: 1, rangerTone: "warn" })).toBe(true);
    expect(barChip("ranger", facts({ rangers: 2, rangerTone: "ok" })).name).toBe("rangers");
  });

  test("capacity speaks when it holds a start, a run is out of it, or a window runs low", () => {
    expect(says("capacity", {})).toBe(false);
    expect(state("capacity")).toBe("5h 12%");
    expect(says("capacity", { held: 1 })).toBe(true);
    expect(state("capacity", { held: 1 })).toBe("5h 12%, 1 held");
    expect(says("capacity", { limited: 1 })).toBe(true);
    expect(says("capacity", { capacityTone: "lichen" })).toBe(true);
    expect(says("capacity", { capacityTone: "rust" })).toBe(true);
    expect(barChip("capacity", facts({ capacity: 0, held: 1 })).there).toBe(false);
  });

  test("health speaks when a check is not well", () => {
    expect(says("health", {})).toBe(false);
    expect(state("health")).toBe("every check is well");
    expect(says("health", { healthLevel: "warn", healthWord: "1 healing" })).toBe(true);
    expect(says("health", { healthLevel: "bad", healthWord: "2 down" })).toBe(true);
    expect(state("health", { healthLevel: "bad", healthWord: "2 down" })).toBe("2 down");
    expect(says("health", { health: 0, healthLevel: "bad" })).toBe(false);
  });

  test("the backend speaks when its stream is not live or a peer is lost", () => {
    expect(says("backend", {})).toBe(false);
    expect(state("backend")).toBe("mini connected");
    for (const backendState of ["connecting", "offline", "signin", "permission"] as const) expect(says("backend", { backendState })).toBe(true);
    expect(state("backend", { backendState: "offline" })).toBe("mini not connected");
    expect(says("backend", { peersLost: 1 })).toBe(true);
    expect(state("backend", { peersLost: 1 })).toBe("mini connected, 1 peer not reached");
  });

  test("the menu lists the chips that are there under their headings, speaking or not", () => {
    const chips = barChips(facts({ runs: 1, inbox: 2 }));
    const menu = moreGroups(chips);
    expect(menu.map((g) => g.label)).toEqual(["for you", "running", "this backend", "show", "tools"]);
    expect(menu[0]?.chips.map((c) => c.id)).toEqual(["waiting", "inbox", "notes", "clips"]);
    expect(menu[1]?.chips.map((c) => c.id)).toEqual(["runs", "shells"]);
    expect(menu[3]?.chips.map((c) => c.id)).toEqual(["sort", "attention", "filters", "sources"]);
    expect([...speaking(chips)]).toEqual(["inbox", "runs"]);
  });

  test("a heading with no chip there is left out, and the count is of the chips put away", () => {
    const chips = barChips(facts({ capacity: 0, health: 0 }));
    expect(moreGroups(chips).find((g) => g.label === "this backend")?.chips.map((c) => c.id)).toEqual(["backend"]);
    // sort, attention, filters, sources, rescan, feed, select, waiting, inbox, notes, clips, shells, backend
    expect(putAway(chips)).toBe(13);
    expect(putAway(barChips(facts({ capacity: 0, health: 0, inbox: 1, shells: 1 })))).toBe(11);
  });

  test("every chip has a place in the order the row gives room in", () => {
    expect([...BAR_PRIORITY].sort()).toEqual([...BAR_CHIPS].sort());
    expect(BAR_PRIORITY[0]).toBe("waiting");
  });

  test("a row with room for everything that speaks crowds nothing out", () => {
    const speaks = new Set<BarChipId>(["waiting", "runs", "inbox"]);
    expect([...crowdedChips(speaks, { waiting: 36, runs: 116, inbox: 38 }, 210, 4)]).toEqual([]);
  });

  test("a row short of room keeps what waits on you and passes over what does not fit", () => {
    const speaks = new Set<BarChipId>(["attention", "waiting", "runs", "inbox", "shells"]);
    const widths = { attention: 36, waiting: 36, runs: 116, inbox: 38, shells: 42 };
    // waiting 40 and runs 120 fit in 170; the inbox, attention and shells do not
    expect([...crowdedChips(speaks, widths, 170, 4)].sort()).toEqual(["attention", "inbox", "shells"]);
    // 30px more and the inbox comes back before attention does
    expect([...crowdedChips(speaks, widths, 205, 4)].sort()).toEqual(["attention", "shells"]);
    // a chip too wide is passed over for a narrower one after it
    expect([...crowdedChips(speaks, widths, 90, 4)].sort()).toEqual(["attention", "runs", "shells"]);
  });

  test("no room at all crowds every measured chip out, and a chip never measured is let through", () => {
    const speaks = new Set<BarChipId>(["waiting", "runs", "notes"]);
    expect([...crowdedChips(speaks, { waiting: 36, runs: 116 }, 0, 4)].sort()).toEqual(["runs", "waiting"]);
    expect([...crowdedChips(speaks, { waiting: 36, runs: 116 }, -40, 4)].sort()).toEqual(["runs", "waiting"]);
  });

  test("a chip that does not speak is never crowded, whatever its width", () => {
    expect([...crowdedChips(new Set<BarChipId>(["runs"]), { runs: 116, notes: 400 }, 130, 4)]).toEqual([]);
  });

  test("a chip's id off the page is checked before it is used", () => {
    expect(chipId("inbox")).toBe("inbox");
    expect(chipId("voice")).toBeNull();
    expect(chipId(undefined)).toBeNull();
  });
});

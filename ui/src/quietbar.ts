/** The quiet top bar (FR-079). At the intermediate level the bar keeps what
 *  a person navigates with (the views, the filter box, search, the command
 *  line, the mic, + new, settings) and every chip that has something to say
 *  right now. A chip with nothing to say leaves the bar for one menu at its
 *  end, which lists each chip by name with its state. This file is the rule:
 *  for each chip, whether it is there at all, what it says in the menu, and
 *  whether that is worth a place on the bar. Pure; tested in
 *  quietbar.test.ts. `useBarChips` gathers the facts from the store. */

/** the chips the quiet bar may put away, in the order the bar shows them */
export const BAR_CHIPS = [
  "sort",
  "attention",
  "filters",
  "sources",
  "rescan",
  "workspaces",
  "feed",
  "select",
  "waiting",
  "inbox",
  "notes",
  "clips",
  "chan",
  "runs",
  "shells",
  "kept",
  "tasks",
  "ranger",
  "capacity",
  "health",
  "backend",
] as const;
export type BarChipId = (typeof BAR_CHIPS)[number];

/** the menu's headings, in order */
export const BAR_GROUPS = ["for you", "running", "this backend", "show", "tools"] as const;
export type BarGroup = (typeof BAR_GROUPS)[number];

/** What the page knows about each chip, in plain values. */
export interface BarFacts {
  /** the grouping in use, as its menu names it */
  sort: string;
  /** repos with changes, unpushed commits or errors, and whether only they show */
  attention: number;
  dirtyOnly: boolean;
  /** filters switched on */
  filters: number;
  /** scanned folders, and the ones whose last scan failed */
  sources: number;
  sourcesBroken: number;
  /** workspaces there are, and the one the board is narrowed to */
  workspaces: number;
  workspace: string | null;
  feedOpen: boolean;
  selecting: boolean;
  picked: number;
  /** what waits on the person, and whether its panel is open */
  waiting: number;
  waitingOpen: boolean;
  /** inbox items; the chip is absent until the asks have loaded */
  inbox: number;
  inboxReady: boolean;
  /** notes still open */
  notes: number;
  /** a copy arrived from another device since the clipboard was last shown */
  clipsFresh: boolean;
  /** tailchan is set up, and its unread messages */
  chan: boolean;
  chanUnread: number;
  /** canopy's own runs going, and the ones parked at a prompt */
  runs: number;
  runsWaiting: number;
  /** shells running, and the ones not open in this browser */
  shells: number;
  shellsElsewhere: number;
  /** shells kept from before a restart */
  kept: number;
  /** tasks defined, the ones running, and the name of one in trouble */
  tasks: number;
  tasksRunning: number;
  taskTrouble: string | null;
  /** rangers switched on, and the worst of their tones */
  rangers: number;
  rangerTone: "ok" | "busy" | "warn" | "off";
  /** capacity readings, the chip's word for them, its tone, starts held and runs out of capacity */
  capacity: number;
  capacityWord: string;
  capacityTone: "moss" | "lichen" | "rust";
  held: number;
  limited: number;
  /** health checks, and the chip's word over all of them */
  health: number;
  healthLevel: "ok" | "warn" | "bad";
  healthWord: string;
  /** the home backend's name, its stream's state, and peers it lost */
  backend: string;
  backendState: "connecting" | "online" | "offline" | "signin" | "permission";
  peersLost: number;
}

export interface BarChip {
  id: BarChipId;
  group: BarGroup;
  /** what the menu calls it */
  name: string;
  /** its state in a few words, for the menu's second line */
  state: string;
  /** the chip renders at all: one that does not is left out of the menu */
  there: boolean;
  /** it has something to say right now, so it sits on the bar */
  says: boolean;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const STREAM: Record<BarFacts["backendState"], string> = {
  online: "connected",
  connecting: "connecting",
  offline: "not connected",
  signin: "wants a sign-in",
  permission: "needs local network access",
};

const RANGER: Record<BarFacts["rangerTone"], string> = {
  ok: "running",
  busy: "starting",
  warn: "needs a look",
  off: "off",
};

type Rule = (f: BarFacts) => Omit<BarChip, "id">;

/** Each chip's rule. A chip speaks when it counts something above zero, when
 *  work is going, when something is not well, or when it is a switch that is
 *  on and so changes what the page shows. */
const RULES: Record<BarChipId, Rule> = {
  // a setting, not news: it never speaks
  sort: (f) => ({ group: "show", name: "grouping", state: `by ${f.sort}`, there: true, says: false }),
  attention: (f) => ({
    group: "show",
    name: "needs attention",
    state: f.attention === 0 ? "all quiet" : `${count(f.attention, "repo")}${f.dirtyOnly ? ", the only ones shown" : ""}`,
    there: true,
    says: f.attention > 0 || f.dirtyOnly,
  }),
  filters: (f) => ({ group: "show", name: "filters", state: f.filters === 0 ? "none on" : `${f.filters} on`, there: true, says: f.filters > 0 }),
  sources: (f) => ({
    group: "show",
    name: "scanned folders",
    state: f.sourcesBroken > 0 ? `${f.sourcesBroken} of ${f.sources} failed to scan` : count(f.sources, "folder"),
    there: true,
    says: f.sourcesBroken > 0,
  }),
  rescan: () => ({ group: "tools", name: "rescan", state: "walk every folder again for repos", there: true, says: false }),
  workspaces: (f) => ({
    group: "show",
    name: "workspace",
    state: f.workspace === null ? `all repos, ${count(f.workspaces, "workspace")} to pick from` : `showing ${f.workspace}`,
    there: f.workspaces > 0,
    says: f.workspaces > 0 && f.workspace !== null,
  }),
  feed: (f) => ({ group: "tools", name: "event feed", state: f.feedOpen ? "open" : "closed", there: true, says: f.feedOpen }),
  select: (f) => ({ group: "tools", name: "select repos", state: f.selecting ? `${f.picked} picked` : "off", there: true, says: f.selecting }),
  waiting: (f) => ({
    group: "for you",
    name: "waiting on you",
    state: f.waiting === 0 ? "nothing" : count(f.waiting, "thing"),
    there: true,
    says: f.waiting > 0 || f.waitingOpen,
  }),
  inbox: (f) => ({
    group: "for you",
    name: "inbox",
    state: f.inbox === 0 ? "empty" : count(f.inbox, "item"),
    there: f.inboxReady || f.inbox > 0,
    says: f.inbox > 0,
  }),
  notes: (f) => ({ group: "for you", name: "notes", state: f.notes === 0 ? "none open" : `${f.notes} open`, there: true, says: f.notes > 0 }),
  clips: (f) => ({
    group: "for you",
    name: "clipboard",
    state: f.clipsFresh ? "a new copy from elsewhere" : "nothing new",
    there: true,
    says: f.clipsFresh,
  }),
  chan: (f) => ({
    group: "for you",
    name: "tailchan",
    state: f.chanUnread === 0 ? "nothing new" : `${f.chanUnread} new`,
    there: f.chan,
    says: f.chan && f.chanUnread > 0,
  }),
  runs: (f) => ({
    group: "running",
    name: "live runs",
    state: f.runsWaiting > 0 ? `${f.runs} going, ${f.runsWaiting === 1 ? "1 needs you" : `${f.runsWaiting} need you`}` : `${f.runs} going`,
    there: f.runs > 0,
    says: f.runs > 0,
  }),
  shells: (f) => ({
    group: "running",
    name: "shells",
    state: f.shells === 0 ? "none running" : `${f.shells} running${f.shellsElsewhere > 0 ? `, ${f.shellsElsewhere} not open here` : ""}`,
    there: true,
    says: f.shells > 0,
  }),
  kept: (f) => ({ group: "running", name: "kept shells", state: `${f.kept} to restore`, there: f.kept > 0, says: f.kept > 0 }),
  tasks: (f) => ({
    group: "running",
    name: "tasks",
    state: f.taskTrouble !== null ? f.taskTrouble : f.tasksRunning > 0 ? `${f.tasksRunning} running` : "none running",
    there: f.tasks > 0,
    says: f.tasks > 0 && (f.tasksRunning > 0 || f.taskTrouble !== null),
  }),
  // a ranger that runs is the usual state; one starting or stuck is news
  ranger: (f) => ({
    group: "running",
    name: f.rangers === 1 ? "ranger" : "rangers",
    state: RANGER[f.rangerTone],
    there: f.rangers > 0,
    says: f.rangers > 0 && (f.rangerTone === "busy" || f.rangerTone === "warn"),
  }),
  capacity: (f) => ({
    group: "this backend",
    name: "capacity",
    state: [f.capacityWord, f.held > 0 ? `${f.held} held` : "", f.limited > 0 ? `${f.limited} waiting for capacity` : ""].filter(Boolean).join(", "),
    there: f.capacity > 0,
    says: f.capacity > 0 && (f.held > 0 || f.limited > 0 || f.capacityTone !== "moss"),
  }),
  health: (f) => ({
    group: "this backend",
    name: "health",
    state: f.healthLevel === "ok" ? "every check is well" : f.healthWord,
    there: f.health > 0,
    says: f.health > 0 && f.healthLevel !== "ok",
  }),
  backend: (f) => ({
    group: "this backend",
    name: "backend",
    state: [`${f.backend || "backend"} ${STREAM[f.backendState]}`, f.peersLost > 0 ? `${count(f.peersLost, "peer")} not reached` : ""].filter(Boolean).join(", "),
    there: true,
    says: f.backendState !== "online" || f.peersLost > 0,
  }),
};

/** Which chips keep their place when the row runs out of room, the first
 *  kept longest: what waits on a person, then what is not well, then the
 *  switches that change what the board shows, then the rest. */
export const BAR_PRIORITY: readonly BarChipId[] = [
  "waiting",
  "runs",
  "inbox",
  "health",
  "backend",
  "capacity",
  "attention",
  "filters",
  "workspaces",
  "tasks",
  "select",
  "chan",
  "shells",
  "kept",
  "clips",
  "notes",
  "ranger",
  "sources",
  "feed",
  "sort",
  "rescan",
];

const isChip = (id: string): id is BarChipId => (BAR_CHIPS as readonly string[]).includes(id);
/** a chip's id off the page, where it is a plain string */
export const chipId = (id: string | undefined): BarChipId | null => (id !== undefined && isChip(id) ? id : null);

/**
 * The speaking chips a row `room` px wide cannot hold, so the quiet bar
 * stays one row whatever speaks. Each chip costs its width and the `gap`
 * before it; the chips are taken in `BAR_PRIORITY` order, and one that does
 * not fit is passed over for a smaller one after it. A chip never measured
 * yet counts as fitting: it has to be drawn once to be measured.
 */
export function crowdedChips(speaks: ReadonlySet<BarChipId>, widths: Readonly<Partial<Record<BarChipId, number>>>, room: number, gap: number): Set<BarChipId> {
  const out = new Set<BarChipId>();
  let left = Math.floor(room);
  for (const id of BAR_PRIORITY) {
    if (!speaks.has(id)) continue;
    const w = widths[id];
    if (w === undefined) continue;
    const cost = Math.ceil(w + gap);
    if (cost <= left) left -= cost;
    else out.add(id);
  }
  return out;
}

/** One chip's line. */
export const barChip = (id: BarChipId, f: BarFacts): BarChip => ({ id, ...RULES[id](f) });

/** Every chip, in the bar's order. */
export const barChips = (f: BarFacts): BarChip[] => BAR_CHIPS.map((id) => barChip(id, f));

/** The ids on the bar right now. */
export const speaking = (chips: readonly BarChip[]): Set<BarChipId> => new Set(chips.filter((c) => c.there && c.says).map((c) => c.id));

/** The menu: the chips that are there, under their headings in order; a
 *  heading with none is left out. */
export function moreGroups(chips: readonly BarChip[]): { label: BarGroup; chips: BarChip[] }[] {
  return BAR_GROUPS.flatMap((label) => {
    const list = chips.filter((c) => c.group === label && c.there);
    return list.length > 0 ? [{ label, chips: list }] : [];
  });
}

/** How many chips the menu holds that are not on the bar. */
export const putAway = (chips: readonly BarChip[]): number => chips.filter((c) => c.there && !c.says).length;

import type { RunGroup } from "../../src/core/group";
import { create } from "zustand";
import { api, onBackendSignal, PartialFleetError, resolveBase, subscribe } from "./api";
import { backendOf, baseOf, homeName, isHome, plainOf, qual, registry, setBase, setRegistry } from "./registry";
import { rangerSessions } from "./ranger";
import { backendState, RETRY_FIRST, retryWait, sliceIn, split, type BackendStatus, type Reg } from "./backends";
import { mergeHistory } from "./qualify";
import { applyQuery, type RepoFilter } from "./filters";
import { cardChangedAt, cardFavorite, joinRepos, leadOf, type RepoCard } from "./checkouts";
import { harnessNames, harnessWeeks, isHarnessCard } from "../../src/core/harnessshare";
import { changedAt, foldGroups as foldGroupList } from "./grouping";
import { foldKeys, sectionsHidden, withZoom, zoomOf, ZOOM_MAX, ZOOM_MIN, type SectionKey } from "./surface";
import { addItemTab, addSectionTab, dropSectionTab, itemTabId, sectionTabId, type SectionPlace, type TabRef } from "./sectiontabs";
import { applyTabs, captureTabs, type TabCard } from "./tabtemplates";
import { termFontSize } from "./touch";
import { isPresetId, matchProfile, type ProfileFields } from "../../src/core/screenlayouts";
import { deviceHere, neverArranged, screenHere } from "./screenprofiles";
import { focusPanel, nextActive } from "./dock";
import {
  activate,
  cellOf,
  columnOf,
  COLUMN_WIDTH,
  fromLegacy,
  moveTo,
  moveWithin,
  normalizeLayout,
  panelsOf,
  place as placeAll,
  regroup,
  rename,
  resizeColumn as sizeColumn,
  resizeColumns as sizeColumns,
  resizeSeam as moveSeam,
  stepPanel,
  type Arrangement,
  type DockLayout,
  type Zone,
} from "./grid";
import { heldShellUrl, openElsewhere, openShellElsewhere, parseRoute, popOutRun, popOutWindow, soloUrl } from "./routes";
import { poppedOf, poppedOut, without } from "./panes";
import { loadSettings, saveSettings, SCREEN_SETTINGS, shellPlace, type Settings, type ShellPlace } from "./settings";
import { snapshot, watch, type Note as Notice, type Watch } from "./notify";
import { setTitleCount } from "./title";
import { TERM_FONT, PANEL_TERM_ROWS, adoptLabels, adoptPlaces, adoptPoppedTerms, adoptTerms, cleanLabel, loadFocusSize, loadTermTabs, needsPanelShell, nextStripTab, panelShellStart, reconcileTerms, renameTab, rowsPx, swapTabs, termId, type FocusSize, type TermTab } from "./term";
import { benchHolds, clearTask, frontForTab, frontForTask, keepFront, projectFront, withSolo, type BenchPane, type Front } from "./front";
import { clientId, identity } from "./client";
export type { TermTab } from "./term";
import { clamp, needsAttention } from "./util";
import { beat } from "./live";
import { ownRun, pickable, selectable } from "./flows";
import { boardOrder, invertPick, pickWhere, rangeIds, setPick, togglePick } from "./select";
import { appendFeed, describeEvent, sweepLine, type FeedEntry, type FeedSnapshot } from "./feed";
import { mergeAction } from "./peers";
import { pasteIntoAgentShell } from "./agentsend";
import { convOf, isUnread, mergeMessages } from "./chan";
import type { AdviceAccepted, AdviceOffer, AgentCard, AgentKind, Ask, AwakeInfo, AwakeMode, CapacityInfo, ChanMessage, HealthCheck, IncubatorStages, KitInfo, LandingInfo, PendingPair, Presence, PrWatch, RangerInfo, SecretsInfo, Sprout, SweepInfo, SweepOutcome, TailchanInfo } from "../../src/core/types";
import { askCloses, askGone, endedCards, freshEntry } from "./sweep";
import { cardOfPanel } from "./agentpanel";
import { isReservedPanel, panelOfItem, runOfPanel, runPanel } from "./itempanel";
import type { Delivery, TriggersInfo } from "../../src/core/trigger";
import { mergeLanding } from "./landing";
import { isCoordinator, type CoordEdit } from "./coord";
import { mergePrs } from "./prs";
import { HARNESS_SAID_KEY, harnessNotice, mergeAsks, mergeInbox, replaceAsks, toAskAnswer, toRunAnswer, type HarnessNotice, type InboxAnswer, type InboxItem } from "./inbox";
import { replaceSprouts, staleSprout } from "./sprouts";
import { cardsByRepoCard, markTrail, mergeCards, replaceCards, type TrailMark } from "./agentcards";
import { clientCaps } from "../../src/core/client";
import { normalizeRoutes, resolveAgent } from "../../src/core/route";
import { flatAgent, hasRouting, NO_ROUTES } from "./agents";
import { cleanKey, keyTestOf, readAnswerKey, writeAnswerKey, type KeyTest } from "./answerKey";
import { loadNotes, noteId, notesPrompt, updateNotes, withNote, withoutNotes, type Note, REVIEW_NOTES_STORE } from "./reviewnotes";
import { originOf, pairLabel, readPair, readToken, readsAdmin, writePair, writeToken, type AuthInfo, type BackendAuth, type SignIn } from "./callerToken";
import { deviceName } from "../../src/core/presence";
import { listedTask } from "../../src/core/tasks";
import { startsDev } from "./tasks";
import { CLI_KEEP, type CliEntry, type SproutDraft } from "./cli";
import {
  WAITING_FOLDED,
  WAITING_GROUPS,
  attentionRepos,
  behindRepos,
  failedRows,
  isUnpushed,
  isWaitingPanel,
  turnRows,
  type AttentionRow,
  type BehindRow,
  type FailedRow,
  type TurnRow,
} from "./waiting";
import { badRepoIds } from "./health";
import { putScreen, screenNow, slotsNow, withScreen, writesFlat } from "./screens";
import {
  DEFAULT_LAUNCH,
  effectivePrimary,
  isFlowActive,
  isRunActive,
  type About,
  type AgentPick,
  type AgentScope,
  type AgentRole,
  type AgentRoutes,
  type AgentSettings,
  type Harness,
  type LaunchPick,
  type RepoAgent,
  type Backend,
  type BackendEntry,
  type ClientCaps,
  type ClientInfo,
  type Device,
  type HelperInfo,
  type Fleet,
  type Flow,
  type FlowChoice,
  type HistoryOverview,
  type Job,
  type KeptShell,
  type LaunchSettings,
  type OpenerId,
  type PeerSeen,
  type PeerSync,
  type Repo,
  type TaskAction,
  type TaskInfo,
  type TaskPatch,
  type TermInfo,
  type RememberedRule,
  type ScreenLayout,
  type ScreenProfile,
  type Run,
  type RunAction,
  type RunAnswer,
  type ScanResult,
  type ServerEvent,
  type SourceInput,
  type SourceState,
  type WorkflowEntry,
  type Workspace,
} from "../../src/core/types";

/** drag limits for the two resizable panes, in px */
export const SIDEBAR = { min: 180, max: 560, initial: 264 };
/** a dock column; the room the cards leave caps it before max does (`dockRoom`) */
export const PANEL = { min: 240, max: 2400, initial: COLUMN_WIDTH };
/** the solo view's centered panel; the window caps it before max does */
export const SOLO = { min: 420, max: 2400, initial: 980 };
/** the terminal strip along the bottom, in px of height */
export const TERM = { min: 120, max: 1200, initial: 300 };
/** a shell living in a repo's panel: the bounds of its body's height, and the
 *  default, which is PANEL_TERM_ROWS lines of the terminal's font */
export const PANEL_TERM = { min: 60, max: 2400, initial: rowsPx(PANEL_TERM_ROWS) };
/** the event feed along the bottom, in px of height */
export const FEED = { min: 100, max: 900, initial: 220 };
/** sections that start folded, matching how the panel read before they could fold */
const DEFAULT_CLOSED = ["search", "history", "claude", "launch", "peers", "spec", "preview", "agents", "files", "health"];
/** the folded-by-default set a layout saved before `knownSections` existed
 *  had decided about; anything added to DEFAULT_CLOSED since folds for it */
const OLD_KNOWN = ["search", "history", "claude"];

/** The folded sections a saved layout means: what it stored, plus any section
 *  that folds by default and did not exist when it was saved. Keeping the
 *  stored list alone would open every new section in every panel. */
export function closedSectionsOf(saved: string[], known: string[]): string[] {
  const extra = DEFAULT_CLOSED.filter((k) => !known.includes(k) && !saved.includes(k));
  return extra.length ? [...saved, ...extra] : saved;
}

/** folded sections by repo id; a repo with no entry folds DEFAULT_CLOSED */
export type ClosedSections = Record<string, string[]>;

/** the height of the shell in one repo's panel: its own, else the default */
export function panelTermHeightFor(s: { panelTermHeights: Record<string, number> }, repoId: string): number {
  return s.panelTermHeights[repoId] ?? PANEL_TERM.initial;
}

/** the folded sections of one repo's panel, or the groups of the "waiting
 *  on you" panel, which folds its own until the user says otherwise */
export function sectionsFor(closed: ClosedSections, repoId: string): readonly string[] {
  return closed[repoId] ?? (isWaitingPanel(repoId) ? WAITING_FOLDED : DEFAULT_CLOSED);
}

/** whether `key` is folded in one repo's panel; a boolean, so a selector
 *  built on it is stable where the array behind it is not */
export function closedIn(s: { closedSections: ClosedSections }, repoId: string, key: string): boolean {
  return sectionsFor(s.closedSections, repoId).includes(key);
}

/** `closed` with `key` folded or unfolded in one repo's panel, the others untouched */
export function toggleIn(closed: ClosedSections, repoId: string, key: string): ClosedSections {
  const mine = sectionsFor(closed, repoId);
  return {
    ...closed,
    [repoId]: mine.includes(key) ? mine.filter((k) => k !== key) : [...mine, key],
  };
}

/** `closed` with `key` unfolded in one repo's panel; the same object when it already is */
export function unfoldIn(closed: ClosedSections, repoId: string, key: string): ClosedSections {
  const mine = sectionsFor(closed, repoId);
  return mine.includes(key) ? { ...closed, [repoId]: mine.filter((k) => k !== key) } : closed;
}

/** `closed` with every one of `keys` folded in one repo's panel, the rest
 *  of its folds as they were; the same object when they already are. The
 *  entry is written out whole, since an absent one means the defaults. */
export function foldAllIn(closed: ClosedSections, repoId: string, keys: readonly string[]): ClosedSections {
  const mine = sectionsFor(closed, repoId);
  const add = keys.filter((k, i) => !mine.includes(k) && keys.indexOf(k) === i);
  if (add.length === 0 && closed[repoId] !== undefined) return closed;
  return { ...closed, [repoId]: [...mine, ...add] };
}

/** `closed` with every one of `keys` unfolded in one repo's panel, the rest
 *  of its folds as they were; the same object when none is folded. An
 *  empty list is still an entry: no entry would fold the defaults again. */
export function unfoldAllIn(closed: ClosedSections, repoId: string, keys: readonly string[]): ClosedSections {
  const mine = sectionsFor(closed, repoId);
  const left = mine.filter((k) => !keys.includes(k));
  if (left.length === mine.length && closed[repoId] !== undefined) return closed;
  return { ...closed, [repoId]: left };
}

/** the fields of `next` that are not the same value as in `before` */
export function changed<T extends object>(next: T, before: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(next) as (keyof T)[]) {
    if (next[k] !== before[k]) out[k] = next[k];
  }
  return out;
}

const LAYOUT_KEY = "canopy.layout";
const HARNESS_WEEK_KEY = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;

function readHarnessSaid(): string | null {
  try {
    const key = localStorage.getItem(HARNESS_SAID_KEY);
    return key && HARNESS_WEEK_KEY.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** the layout kept per kind of screen and window (screens.ts): its sizes,
 *  the tree being open, and the feed being up, which the feed's gear puts
 *  away */
export const SCREEN_LAYOUT = [
  "sidebarOpen",
  "feedOpen",
  "sidebarWidth",
  "panelWidths",
  "soloWidth",
  "dockWidth",
  "dockLayout",
  "termHeight",
  "panelTermHeights",
  "focusSize",
  "feedHeight",
] as const satisfies readonly (keyof Layout)[];

/** how often a window re-reads the archive overview on its own */
const HISTORY_REFRESH = 10 * 60_000;

interface Layout {
  sidebarWidth: number;
  /** px width of a panel that closed while it was a column of its own,
   *  read when it opens as a column again; before phase B every panel's
   *  width, read once to build the first `dockLayout` */
  panelWidths: Record<string, number>;
  /** px width of the panel in the solo view, shared by every solo tab */
  soloWidth: number;
  /** px width of the tabbed dock from before phase B: read only for the
   *  migration to `dockLayout`, never written */
  dockWidth: number;
  /** the dock as columns of cells of tabs (grid.ts), kept per kind of screen */
  dockLayout: DockLayout;
  /** whether the repo tree is showing at all */
  sidebarOpen: boolean;
  /** folded tree groups, as group-key strings */
  collapsed: string[];
  /** folded panel sections (changes, shell, history, claude…) by repo id */
  closedSections: ClosedSections;
  /** the shell tabs, each named for its shell on the server, and the one
   *  showing in the strip: a reload comes back to the shells still there */
  terms: TermTab[];
  activeTerm: string | null;
  /** the running shells this browser put down without ending, which it
   *  does not take up as tabs again until picked from the shells list */
  hiddenTerms: string[];
  /** the default-folded sections this layout has decided about, so a
   *  section added later starts folded instead of open everywhere */
  knownSections: string[];
  /** px height of the terminal strip */
  termHeight: number;
  /** px height of the shell in each repo's panel, by repo id; a repo with
   *  no entry gets the default */
  panelTermHeights: Record<string, number>;
  /** px size of a shell brought to the front; null follows the window */
  focusSize: FocusSize | null;
  /** whether the event feed is showing along the bottom */
  feedOpen: boolean;
  /** px height of the event feed */
  feedHeight: number;
  /** the repos open in the dock, in order, so a reload shows the same ones */
  panels: string[];
  /** the dock's showing tab */
  activePanel: string | null;
  /** the panels popped out to windows of their own, by the dock slot each
   *  goes back to */
  popped: Record<string, number>;
  /** which backend's checkout a card that has several stands for, by card key */
  checkoutPref: Record<string, string>;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];

export function loadLayout(): Layout {
  const fallback: Layout = {
    sidebarWidth: SIDEBAR.initial,
    panelWidths: {},
    soloWidth: SOLO.initial,
    dockWidth: PANEL.initial,
    sidebarOpen: true,
    collapsed: [],
    closedSections: {},
    knownSections: [...DEFAULT_CLOSED],
    termHeight: TERM.initial,
    panelTermHeights: {},
    focusSize: null,
    feedOpen: false,
    feedHeight: FEED.initial,
    panels: [],
    activePanel: null,
    popped: {},
    dockLayout: { columns: [] },
    terms: [],
    activeTerm: null,
    hiddenTerms: [],
    checkoutPref: {},
  };
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return fallback;
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return fallback;
    const saved = withScreen(stored as Record<string, unknown>, slotsNow(), SCREEN_LAYOUT) as {
      sidebarWidth?: unknown;
      panelWidths?: Record<string, unknown>;
      soloWidth?: unknown;
      dockWidth?: unknown;
      sidebarOpen?: unknown;
      collapsed?: unknown;
      closedSections?: unknown;
      knownSections?: unknown;
      termHeight?: unknown;
      panelTermHeights?: Record<string, unknown>;
      focusSize?: unknown;
      feedOpen?: unknown;
      feedHeight?: unknown;
      panels?: unknown;
      activePanel?: unknown;
      popped?: unknown;
      dockLayout?: unknown;
      terms?: unknown;
      activeTerm?: unknown;
      hiddenTerms?: unknown;
      checkoutPref?: unknown;
    };
    // Anything hand-edited or written by an older build gets clamped rather
    // than trusted — a bad number here would render an unusable panel.
    const sizes = (saved: Record<string, unknown> | undefined, bounds: { min: number; max: number }) => {
      const out: Record<string, number> = {};
      for (const [id, px] of Object.entries(saved ?? {})) {
        if (typeof px === "number" && Number.isFinite(px)) out[id] = clamp(px, bounds.min, bounds.max);
      }
      return out;
    };
    const panelWidths = sizes(saved.panelWidths, PANEL);
    // one shell height per panel; the one global height a layout kept before
    // this is left behind, so every panel starts at the default
    const panelTermHeights = sizes(saved.panelTermHeights, PANEL_TERM);
    // Folds are by repo. A layout from when they were one list for every
    // panel (an array here) starts every panel at the defaults instead.
    const known = Array.isArray(saved.knownSections) ? strings(saved.knownSections) : OLD_KNOWN;
    const closedSections: ClosedSections = {};
    if (saved.closedSections && typeof saved.closedSections === "object" && !Array.isArray(saved.closedSections)) {
      for (const [id, keys] of Object.entries(saved.closedSections)) {
        if (Array.isArray(keys)) closedSections[id] = closedSectionsOf(strings(keys), known);
      }
    }
    const sw = saved.sidebarWidth;
    const solo = saved.soloWidth;
    const dw = saved.dockWidth;
    const th = saved.termHeight;
    const fh = saved.feedHeight;
    const dockWidth = typeof dw === "number" && Number.isFinite(dw) ? clamp(dw, PANEL.min, PANEL.max) : PANEL.initial;
    const activePanel = typeof saved.activePanel === "string" ? saved.activePanel : null;
    const into: Arrangement = loadSettings().openIn === "tabs" ? "tabs" : "columns";
    const ownSaved = legacySlot(stored, slotsNow(), screenNow()?.cls ?? null) ? undefined : saved.dockLayout;
    const dockLayout = loadDock(ownSaved, strings(saved.panels), activePanel, panelWidths, dockWidth, into);
    return {
      sidebarWidth:
        typeof sw === "number" && Number.isFinite(sw)
          ? clamp(sw, SIDEBAR.min, SIDEBAR.max)
          : SIDEBAR.initial,
      panelWidths,
      soloWidth:
        typeof solo === "number" && Number.isFinite(solo)
          ? clamp(solo, SOLO.min, SOLO.max)
          : SOLO.initial,
      dockWidth,
      sidebarOpen: saved.sidebarOpen !== false,
      collapsed: strings(saved.collapsed),
      closedSections,
      knownSections: [...DEFAULT_CLOSED],
      termHeight:
        typeof th === "number" && Number.isFinite(th)
          ? clamp(th, TERM.min, TERM.max)
          : TERM.initial,
      panelTermHeights,
      focusSize: loadFocusSize(saved.focusSize),
      feedOpen: saved.feedOpen === true,
      feedHeight:
        typeof fh === "number" && Number.isFinite(fh)
          ? clamp(fh, FEED.min, FEED.max)
          : FEED.initial,
      // the open set is the window's, the layout the screen's: a layout
      // saved on another kind of screen is placed over this window's panels
      panels: panelsOf(dockLayout),
      activePanel,
      popped: poppedOf(saved.popped),
      dockLayout,
      terms: loadTermTabs(saved.terms),
      activeTerm: typeof saved.activeTerm === "string" ? saved.activeTerm : null,
      hiddenTerms: strings(saved.hiddenTerms),
      checkoutPref: stringMap(saved.checkoutPref),
    };
  } catch {
    return fallback;
  }
}

/** Whether this screen class kept a slot of its own from before phase B:
 *  the slot holds sizes but no `dockLayout`, and no slot in the window's
 *  chain has one either, so the only layout to read is the flat copy some
 *  other class wrote after the upgrade. Such a class builds its first
 *  layout from its own slot (`fromLegacy`) instead. A class never visited
 *  has no slot and still inherits the nearest one's arrangement. */
function legacySlot(stored: unknown, slots: readonly string[], cls: string | null): boolean {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const screens = record(stored) ? stored.screens : undefined;
  const slot = (key: string): Record<string, unknown> | undefined => {
    const v = record(screens) ? screens[key] : undefined;
    return record(v) ? v : undefined;
  };
  if (slots.some((k) => slot(k)?.dockLayout !== undefined)) return false;
  const own = cls !== null ? slot(cls) : undefined;
  return own !== undefined && own.dockLayout === undefined && SCREEN_LAYOUT.some((k) => k in own);
}

/** The dock's layout from what was saved: the saved layout repaired, its
 *  widths clamped, or, when there is none (a layout from before phase B),
 *  one built from the old widths and the open target. Either way then
 *  placed over `panels`, so it holds exactly the panels open here. */
export function loadDock(
  saved: unknown,
  panels: readonly string[],
  active: string | null,
  widths: Record<string, number>,
  dockWidth: number,
  into: Arrangement,
): DockLayout {
  const fixed = normalizeLayout(saved);
  const base = fixed
    ? { columns: fixed.columns.map((c) => ({ ...c, width: clamp(c.width, PANEL.min, PANEL.max) })) }
    : fromLegacy(panels, active, widths, dockWidth, into);
  return placeAll(base, panels, active, into, (id) => widths[id] ?? PANEL.initial);
}

/** a record of strings to strings, anything else in it left out */
function stringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** the layout as stored, unread; null when there is none or it will not parse */
function storedLayout(): unknown {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** Writes the fields in `patch` over what is stored, leaving the rest as the
 *  last window to save them left it. Two windows share the key (the grove
 *  and a solo panel, say); one writing its whole copy would put back the
 *  other's dock as it stood when this one loaded. */
function saveLayout(patch: Partial<Layout>) {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    const stored: unknown = raw ? JSON.parse(raw) : {};
    const base: Record<string, unknown> =
      stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify(putScreen(base, { ...patch, knownSections: DEFAULT_CLOSED }, slotsNow()[0] ?? null, SCREEN_LAYOUT, writesFlat())),
    );
  } catch {
    // storage can be disabled outright; the layout just won't survive a reload
  }
}

/** The tabs a layout saves: this window's, then the ones parked for a
 *  backend that has not answered, so they outlive the load. The tabs
 *  themselves when none is parked, and the same array for the same two, so
 *  the layout subscription does not see a change on every state change. */
let savedTermsMemo: { terms: TermTab[]; parked: TermTab[]; out: TermTab[] } | null = null;
function savedTerms(s: Pick<CanopyState, "terms" | "parkedTerms">): TermTab[] {
  if (s.parkedTerms.length === 0) return s.terms;
  const m = savedTermsMemo;
  if (m && m.terms === s.terms && m.parked === s.parkedTerms) return m.out;
  const out = [...s.terms, ...s.parkedTerms];
  savedTermsMemo = { terms: s.terms, parked: s.parkedTerms, out };
  return out;
}

/** the persisted part of the state, minus `knownSections`, which is a constant */
export const layoutOf = (s: CanopyState): Omit<Layout, "knownSections"> => ({
  sidebarWidth: s.sidebarWidth,
  panelWidths: s.panelWidths,
  soloWidth: s.soloWidth,
  dockWidth: s.dockWidth,
  sidebarOpen: s.sidebarOpen,
  collapsed: s.collapsed,
  closedSections: s.closedSections,
  termHeight: s.termHeight,
  panelTermHeights: s.panelTermHeights,
  focusSize: s.focusSize,
  feedOpen: s.feedOpen,
  feedHeight: s.feedHeight,
  panels: s.panels,
  activePanel: s.activePanel,
  popped: s.popped,
  dockLayout: s.dockLayout,
  terms: savedTerms(s),
  activeTerm: s.activeTerm,
  hiddenTerms: s.hiddenTerms,
  checkoutPref: s.checkoutPref,
});

/** drops entries for repos that no longer exist in the scan; the same
 *  object when every one still does. With `mine`, only the keys it names
 *  are judged (one backend's scan), and every other key stays. */
export function pruneByRepo<T>(map: Record<string, T>, repos: Repo[], mine?: (id: string) => boolean): Record<string, T> {
  const ids = new Set(repos.map((r) => r.id));
  const kept = Object.entries(map).filter(([id]) => ids.has(id) || (mine !== undefined && !mine(id)));
  if (kept.length === Object.keys(map).length) return map;
  return Object.fromEntries(kept);
}

/** One backend as this page sees it: where it is, whether it answers, and
 *  what it said about itself and this browser. */
export interface Conn {
  name: string;
  /** its base URL, "" for the page's own origin */
  base: string;
  status: BackendStatus;
  about: About | null;
  /** what this backend can do for its clients (desktop openers, ssh alias) */
  backend: Backend;
  /** what the backend knows of this browser: its address, and whether it is
   *  on the backend's own Mac */
  client: ClientInfo;
  /** the `canopy helper`s dialled in to the backend, by name */
  helpers: HelperInfo[];
  /** whether the backend is writing shell history out at all */
  keeping: boolean;
  /** whether the backend pulls from peers at all, and whether it writes */
  peerSync: PeerSync;
}

/** A local rename made before the shell's first list arrived. `previous`
 *  records the label the startup socket carried, so a later remote rename
 *  can take precedence when the shell appears. */
type PendingTermLabel = {
  previous: string | null;
  label: string | null;
  phase: "waiting" | "sending";
};

/** What a backend is before it has said anything. One frozen object, so a
 *  selector reading a backend not yet known gets the same thing every time. */
const NO_CONN: Conn = Object.freeze({
  name: "",
  base: "",
  status: Object.freeze({ state: "connecting" as const }),
  about: null,
  backend: Object.freeze({ openers: true, sshHost: null }),
  client: Object.freeze({ address: "", local: false, shared: false }),
  helpers: Object.freeze([]) as unknown as HelperInfo[],
  keeping: false,
  peerSync: "off" as const,
});

const newConn = (name: string, status: BackendStatus = { state: "connecting" }): Conn => ({ ...NO_CONN, name, status });

/** `conns` with one backend's fields changed, made when it had none */
function withConn(s: Pick<CanopyState, "conns">, name: string, patch: Partial<Conn>): Record<string, Conn> {
  return { ...s.conns, [name]: { ...(s.conns[name] ?? newConn(name)), ...patch } };
}

/** `conns` with one backend's fields changed, or as it is when that backend
 *  has no entry: for an answer that lands after the backend was hidden,
 *  which must not bring it back. */
function connsIf(s: Pick<CanopyState, "conns">, name: string, patch: Partial<Conn>): Record<string, Conn> {
  const c = s.conns[name];
  return c ? { ...s.conns, [name]: { ...c, ...patch } } : s.conns;
}

/** whether a backend is on this page now: home, or one in the order (not
 *  hidden); an answer from any other is dropped */
const isShown = (s: Pick<CanopyState, "home" | "backendOrder">, name: string): boolean =>
  name === s.home || s.backendOrder.includes(name);

/** Every backend the home one named, hidden ones among them, so an id of a
 *  hidden backend is still told apart from a home id: its saved tabs park
 *  instead of dropping, and a home scan leaves its panels alone. */
let known: Reg = { home: "", names: [""] };

/** the backend an id belongs to and the id it knows, hidden backends
 *  included, so a hidden backend's panel is never named by its page id */
export function idParts(id: string): [string, string] {
  const reg = registry();
  return split(known.home === reg.home ? known : reg, id);
}

/** the backend an id belongs to, hidden backends included */
const ownerOf = (id: string): string => idParts(id)[0];

/** What a page prints for an id: the id its backend knows, and the
 *  backend's name when that is not home. Never the page's own prefix. */
export function idLabel(id: string): { plain: string; backend: string | null } {
  const [b, plain] = idParts(id);
  return { plain, backend: b === registry().home ? null : b };
}

/** `idLabel` as one line of text, for a title or an aria label */
export function idText(id: string): string {
  const { plain, backend } = idLabel(id);
  return backend ? `${plain} on ${backend}` : plain;
}

/** whether an id is one backend's. A reserved panel ("waiting on you", the
 *  command line's transcript) reads as a home id but is no backend's, so no
 *  scan prunes it, nor its width or its folds. */
const mineOf =
  (from: string) =>
  (id: string): boolean =>
    ownerOf(id) === from && !isReservedPanel(id);

/** a record by id with one backend's entries replaced by `list` */
function recordIn<T extends { id: string }>(rec: Record<string, T>, from: string, list: readonly T[]): Record<string, T> {
  const mine = mineOf(from);
  const out: Record<string, T> = {};
  for (const [id, v] of Object.entries(rec)) if (!mine(id)) out[id] = v;
  for (const v of list) out[v.id] = v;
  return out;
}

/** a record by id with one backend's entries left out; the same object
 *  when it had none */
function recordOut<T>(rec: Record<string, T>, from: string): Record<string, T> {
  const mine = mineOf(from);
  const kept = Object.entries(rec).filter(([id]) => !mine(id));
  return kept.length === Object.keys(rec).length ? rec : Object.fromEntries(kept);
}

/** the archive overviews as one, in the page's backend order */
const historyOf = (histories: Record<string, HistoryOverview>, order: readonly string[]): HistoryOverview | null =>
  mergeHistory(order.flatMap((n) => (histories[n] ? [histories[n]] : [])));

/** The hidden names `live` (one backend's shells) still runs, the other
 *  backends' left as they are: `pruneHidden` for one backend's list. */
function pruneHiddenOf(hidden: string[], from: string, live: TermInfo[]): string[] {
  const mine = mineOf(from);
  const held = new Set(live.map((t) => t.id));
  const kept = hidden.filter((id) => !mine(id) || held.has(id));
  return kept.length === hidden.length ? hidden : kept;
}

export interface CanopyState {
  root: string;
  /** every scanned folder, the launch root first */
  sources: SourceState[];
  repos: Repo[];
  /** every backend in the registry by name, home among them */
  conns: Record<string, Conn>;
  /** the backend that served this page */
  home: string;
  /** the registry's names in order, home first, hidden ones left out */
  backendOrder: string[];
  /** the browsers on each backend's event stream now, this one among them */
  devices: Device[];
  /** who the home backend last saw reachable in the peer pass, by name */
  peerSeen: PeerSeen[];
  /** whether the home backend pulls from peers at all, and whether it
   *  writes; each backend's own is on its `Conn` */
  peerSync: PeerSync;
  /** every shell the server holds, with who is looking at each; the tabs
   *  here are the ones of those this window shows */
  shells: TermInfo[];
  /** startup renames waiting for their shell's first terms event */
  pendingTermLabels: Record<string, PendingTermLabel>;
  /** the shells a machine going down left behind, offered to restore */
  kept: KeptShell[];
  /** tailchan as the backend sees it: null until asked, `ready: false`
   *  with why when the backend knows no broker */
  chan: TailchanInfo | null;
  /** the handle the UI speaks tailchan as, "" until known; the feed reads
   *  it to call the UI's own posts "you" */
  chanAs: string;
  /** messages by conversation (channel name, `dm.a+b` for a DM) */
  chanMsgs: Record<string, ChanMessage[]>;
  /** messages heard since the popover was last looked at */
  chanUnread: number;
  /** whether the tailchan popover is up, and which conversation it shows */
  chanOpen: boolean;
  chanConv: string | null;
  /** tailchan sits in a shell window's tab (FR-030), so it is looked at too */
  chanInTab: boolean;
  /** the agent registry, the home backend's broker's cards by id */
  registry: Record<string, AgentCard>;
  /** whether the home backend has a registry to show; false shows nothing
   *  registry-related */
  registryReady: boolean;
  /** the states this page saw each card take, by card id (`markTrail`) */
  registryTrail: Record<string, TrailMark[]>;
  /** what runs in each shell no live registry card names, by shell id, as
   *  tmux last said (`probeShells`): the agents board's cards for a Claude
   *  or Codex with no hook */
  shellAgents: Record<string, AgentKind | null>;
  /** the broker's asks as the home backend follows them, open and lately
   *  closed, by id */
  asks: Record<string, Ask>;
  /** whether the home backend follows asks at all (it has a broker) */
  asksReady: boolean;
  /** This browser's answer key (`ui/src/answerKey.ts`), which answering an
   *  ask, presence and guards take: sent to the home backend on those
   *  writes and nowhere else. Null: the asks are shown read-only. */
  answerKey: string | null;
  /** the human's presence at the broker, as last heard */
  presence: Presence | null;
  /** the incubator's sprouts by id, every shown backend's (another
   *  backend's ids qualified) */
  sprouts: Record<string, Sprout>;
  /** whether any backend answered the incubator's list */
  sproutsReady: boolean;
  /** where each backend runs the incubator's stages, by backend name; one
   *  that has not said (an older backend never does) is missing */
  stages: Record<string, IncubatorStages>;
  /** the ranger on each backend that has said, by backend name (server/ranger) */
  rangers: Record<string, RangerInfo>;
  /** keep awake on each backend that has said, by backend name (core/awake) */
  awake: Record<string, AwakeInfo>;
  /** the home backend's sweep (server/sweep): what went idle, its settings,
   *  the last close and what it swept; null until read, and on a backend
   *  older than the sweep or a page without the admin right */
  sweep: SweepInfo | null;
  /** the agent cards the newest close ended, so an agent window showing one
   *  of them closes; set only by an event that brings a new close */
  sweepEnded: string[];
  /** each backend's health checks, by backend name; an older backend that
   *  has none is missing (server/health) */
  health: Record<string, HealthCheck[]>;
  /** each backend's usage windows and held starts; an older backend that
   *  has no capacity route is missing (server/capacity) */
  capacity: Record<string, CapacityInfo>;
  /** each backend's kit: the machines it reaches and their skills (server/kit) */
  kit: Record<string, KitInfo>;
  /** each backend's branch runs and landing queue (server/landing); an
   *  older backend that has none is missing */
  landing: Record<string, LandingInfo>;
  /** each backend's PRs that branch runs opened (server/prs); an older
   *  backend that has none is missing */
  prs: Record<string, PrWatch[]>;
  /** each backend's trigger rules and events (server/triggers); an older
   *  backend that has none is missing */
  triggers: Record<string, TriggersInfo>;
  /** each backend's caller check as this page last read it (server/callers),
   *  with whether this page holds a token for it; an older backend that has
   *  none is missing */
  authByBackend: Record<string, BackendAuth>;
  /** a sign-in on its way, or one that failed, by backend */
  signIns: Record<string, SignIn>;
  /** the retro lessons home has on offer, which the inbox shows as one item */
  advice: AdviceOffer[];
  /** the ISO week this browser last noted for the harness line */
  harnessSaid: string | null;
  /** an accepted lesson's text by chat run id, which that chat's message box
   *  starts with; the user sends it, or not */
  chatDrafts: Record<string, string>;
  /** the user's own workflow file an accepted lesson named, until put away */
  adviceFile: Extract<AdviceAccepted, { kind: "file" }> | null;
  /** whether the inbox popover is up, and the item it opened on */
  inboxOpen: boolean;
  inboxFocus: string | null;
  workspaces: Workspace[];
  /** the screen layout profiles, kept on the home backend: the presets
   *  first, then the user's own; empty until read or on a backend from
   *  before them */
  screenProfiles: ScreenProfile[];
  loaded: boolean;
  /** why the initial load failed, if it did */
  loadError: string | null;
  filter: string;
  dirtyOnly: boolean;
  /** leaves only the starred repos on the board */
  favoritesOnly: boolean;
  /** lit status facets; a repo shows when it matches any of them */
  filters: RepoFilter[];
  /** lit git identities, as userKey strings (NOBODY for repos with none) */
  users: string[];
  /** active workspace tab; null = all */
  activeWs: string | null;
  /** repo ids pinned open in the dock, in the layout's order: always
   *  `panelsOf(dockLayout)`, columns left to right, cells top to bottom,
   *  tabs in order */
  panels: string[];
  /** the dock as columns of cells of tabs (grid.ts); every action that
   *  changes the open set writes it and `panels` together */
  dockLayout: DockLayout;
  /** the panel showing when the dock is tabbed (`openIn: "tabs"`); kept
   *  in every mode so switching the setting keeps the place */
  activePanel: string | null;
  /** the panels popped out to windows of their own, by their dock slot */
  popped: Record<string, number>;
  /** the panels the user docked again by hand while they were popped out
   *  (their card, a shell, a close): a pop-out still open says hello on
   *  its next load, and that hello must not take the panel back. Kept by
   *  this window only, never saved. */
  recalled: string[];
  /** repo id → last SSE update, for the update pulse */
  updatedAt: Record<string, number>;
  /** px width of the repo tree, dragged by the sidebar resizer */
  sidebarWidth: number;
  sidebarOpen: boolean;
  /** the tree as a drawer over the page, below the width that has no room
   *  for it beside the cards; this window's alone, never saved */
  drawerOpen: boolean;
  /** the command line's prompt is up over the page; this window's alone */
  cliOpen: boolean;
  /** what home said it was the first time this page asked, for telling a
   *  redeploy under an open page (`buildMoved`) */
  aboutAtLoad: About | null;
  /** the command line's transcript, oldest first, at most CLI_KEEP;
   *  this window's alone, never saved */
  cliLog: CliEntry[];
  /** folded sections in the tree and the grid, as sectionKey strings */
  collapsed: string[];
  /** folded panel sections (changes, shell, history, claude…) by repo id */
  closedSections: ClosedSections;
  /** repo id → px width its column had when it closed while alone in it,
   *  for a column it opens in later; missing means PANEL.initial. Before
   *  phase B every panel's width, read once for the first layout */
  panelWidths: Record<string, number>;
  /** px width of the solo view's panel, dragged by its edge handles */
  soloWidth: number;
  /** px width of the tabbed dock from before phase B, read only for the
   *  migration to `dockLayout` */
  dockWidth: number;
  /** per-browser preferences, persisted in localStorage */
  settings: Settings;
  /** Claude Code runs by id, live and recently finished */
  runs: Record<string, Run>;
  /** the modal in front of the grove: a pre-flight for an action, or a run */
  sheet: Sheet | null;
  /** the last term searched across repos; the sheet reopens on it */
  searchQuery: string;
  /** a term carried from the search sheet into one repo's search section,
   *  taken by that section when it mounts or sees it */
  pendingSearch: { repoId: string; q: string } | null;
  /** a section just unfolded for the user (the preview, by a start of the
   *  dev task), which scrolls itself into view once */
  reveal: { repoId: string; key: string; at: number } | null;
  /** the claude-history archive, per repo, every backend's as one; null
   *  until the first fetch lands */
  history: HistoryOverview | null;
  /** each backend's archive overview, by backend */
  histories: Record<string, HistoryOverview>;
  /** each backend's agent routing (profiles, role routes, repo overrides),
   *  by backend; resolved per repo and role through `agentFor` */
  agents: Record<string, AgentRoutes>;
  /** how a repo's builds are made and run, by backend then repo path */
  launchers: Record<string, Record<string, LaunchSettings>>;
  /** each backend's remembered rules, which answer its runs' permissions;
   *  read when the inbox opens, then kept by the `remembered` event */
  remembered: Record<string, RememberedRule[]>;
  /** downloads and builds by id, live and recently finished */
  jobs: Record<string, Job>;
  /** each repo's tasks as last read or told, by repo id */
  tasks: Record<string, TaskInfo[]>;
  taskErrors: Record<string, string[]>;
  /** every task not idle across the repos of every backend, for the top bar */
  taskAll: TaskInfo[];
  /** repo id → bumped whenever its builds changed, so the launch section re-reads */
  buildsAt: Record<string, number>;
  /** every shell open in this window, in the order opened */
  terms: TermTab[];
  /** saved tabs of a backend that has not answered yet (or is hidden),
   *  kept in the saved layout until it does */
  parkedTerms: TermTab[];
  /** the section tab (FR-030) the strip and the sessions view show in
   *  place of `activeTerm`, until a shell's tab is picked again */
  stripPage: string | null;
  /** which backend's checkout a card that has several stands for, by card key */
  checkoutPref: Record<string, string>;
  /** the shell showing in the strip; null when the strip is empty */
  activeTerm: string | null;
  /** running shells this browser hid rather than ended, by name */
  hiddenTerms: string[];
  /** px height of the strip, dragged by its top edge */
  termHeight: number;
  /** px height of the shell in each repo's panel, by repo id, dragged by its
   *  top edge; `panelTermHeightFor` reads one */
  panelTermHeights: Record<string, number>;
  /** px size of a shell brought to the front, dragged by its corner; null
   *  is the default, which follows the window */
  focusSize: FocusSize | null;
  /** what is in front of the page: the strip's shells, or one project's
   *  bench (its changes, shells, preview and task log in one box), null
   *  when nothing is; one at a time, for this page only */
  front: Front | null;
  /** flows by id, live and recently finished */
  flows: Record<string, Flow>;
  /** fleets by id, live and recently finished */
  fleets: Record<string, Fleet>;
  /** workflows the menu last fetched, by repo id */
  workflows: Record<string, WorkflowEntry[]>;
  /** run id to flow id, for every run a flow owns; those runs stay off the cards */
  flowRuns: Record<string, string>;
  /** select mode on the board */
  selecting: boolean;
  /** repo ids picked for a fleet; read through `pickedIds`, which drops the ones the view no longer shows */
  selected: string[];
  /** the last repo clicked in select mode, where a shift-click's range starts */
  selectAnchor: string | null;
  /** whether the server has a gateway key, so verdict gates can judge */
  verdictReady: boolean;
  /** every server event since the page loaded, as lines, newest last */
  feed: FeedEntry[];
  /** the next feed entry's id */
  feedSeq: number;
  /** whether the feed is showing along the bottom */
  feedOpen: boolean;
  /** px height of the feed, dragged by its top edge */
  feedHeight: number;
  /** the source the feed is narrowed to; null is every source */
  feedSource: string | null;
  /** whether the feed shows lines that only say nothing changed */
  feedQuiet: boolean;

  toggleFeed: () => void;
  clearFeed: () => void;
  setFeedHeight: (px: number) => void;
  setFeedSource: (id: string | null) => void;
  setFeedQuiet: (on: boolean) => void;

  /** loads the tree and opens the SSE stream, for every backend; returns
   *  what closes them */
  init: () => Promise<() => void>;
  /** loads one non-home backend and subscribes to its stream */
  connect: (name: string) => Promise<void>;
  /** tries a backend that did not answer again */
  retryBackend: (name: string) => Promise<void>;
  /** leaves a backend out of this page, or brings it back; never home */
  hideBackend: (name: string, hidden: boolean) => void;
  /** which backend's checkout a card stands for */
  setCheckoutPref: (key: string, backend: string) => void;
  /** a panel shows a sibling checkout of its repo instead: the id is
   *  replaced where it sits in the dock, and the card leads with it */
  switchCheckout: (fromId: string, toId: string) => void;
  /** re-reads one backend's tree and its runs, flows, fleets and jobs */
  rescan: (backend?: string) => Promise<void>;
  /** adds a folder on a backend's machine or over ssh from it; resolves
   *  once it is scanned */
  addSource: (input: SourceInput, backend?: string) => Promise<void>;
  removeSource: (id: string) => Promise<void>;
  rescanSource: (id: string) => Promise<void>;
  /** refetches a backend's archive overview; a failure becomes an unavailable one */
  loadHistory: (refresh?: boolean, backend?: string) => Promise<void>;
  setFilter: (f: string) => void;
  setDirtyOnly: (v: boolean) => void;
  setFavoritesOnly: (v: boolean) => void;
  toggleFilter: (f: RepoFilter) => void;
  toggleUser: (key: string) => void;
  /** turns every facet and identity chip off, and favorites only; the text
   *  and the attention toggle have their own ways back */
  clearFilters: () => void;
  setActiveWs: (name: string | null) => void;
  /** reads the screen layout profiles from the home backend */
  loadScreenProfiles: () => Promise<void>;
  /** keeps a profile: a new one of the user's own (`id` null), a copy of
   *  any (`from`), or a change to one, a preset's kept beside it */
  saveScreenProfile: (what: { id: string | null; fields: ProfileFields } | { from: string }) => Promise<ScreenProfile>;
  /** drops a profile of the user's own, or puts a preset back as it ships */
  dropScreenProfile: (id: string) => Promise<void>;
  /** lays a profile's layout over this window through the usual setters,
   *  so the screen's own slots keep it; the dock's layout is written out
   *  either way, so this screen counts as arranged from then on. Its tab
   *  template (FR-030) lands only with `withTabs`, an apply by hand: a
   *  window moving onto a screen never moves sections out of the cards */
  applyScreenLayout: (layout: ScreenLayout, withTabs?: boolean) => void;
  /** reads a repo's tasks from its backend */
  loadTasks: (repoId: string) => Promise<void>;
  taskAct: (repoId: string, action: TaskAction, name?: string) => Promise<void>;
  saveTaskDef: (repoId: string, name: string, def: TaskPatch | null, target: "canopy" | "repo") => Promise<void>;
  /** opening a panel starts its tasks flagged to start with it */
  startPanelTasks: (repoId: string) => void;
  /** opens a repo's panel in the dock, or brings its tab forward; `into`
   *  makes a new panel a column of its own or a tab of the showing cell
   *  whatever the dock's arrangement (FR-047) */
  openPanel: (id: string, into?: Arrangement) => void;
  /** brings an open panel's tab forward without opening anything */
  showPanel: (id: string) => void;
  /** opens a repo where the settings say to; modifier keys override that
   *  the way they do for links (cmd/ctrl → tab, shift → window) */
  openRepo: (id: string, mods?: ClickModifiers) => void;
  /** opens a repo in an app through the server, as a tab when the settings
   *  say so; rejects with the server's reason */
  openApp: (id: string, app: OpenerId) => Promise<void>;
  closePanel: (id: string) => void;
  /** moves an open panel toward index `to` of `panels`: a panel alone in
   *  its column moves the column, width and all; one among tabs or in a
   *  stack moves inside its cell or its column. The panel showing stays
   *  the one showing */
  movePanel: (id: string, to: number) => void;
  /** a panel dropped on a cell: a tab of it, or a split toward an edge */
  dropPanel: (id: string, cell: string, zone: Zone) => void;
  /** a panel dropped on a cell's tab strip: a tab of that cell at `index`,
   *  which along its own strip is a reorder */
  dropTab: (id: string, cell: string, index: number) => void;
  /** a column's width, clamped to PANEL */
  resizeColumn: (column: string, px: number) => void;
  /** several columns' widths at once, each clamped to PANEL: a column seam
   *  that lent its left neighbour width */
  resizeColumns: (widths: Record<string, number>) => void;
  /** the boundary under cell `index` of a column, to `at` of its height */
  resizeSeam: (column: string, index: number, at: number) => void;
  /** the gear's "side by side" or "as tabs": the open target, and every
   *  open panel put in that arrangement */
  arrangeDock: (into: Arrangement) => void;
  /** opens the panel in a window of its own and, once that window is open,
   *  takes it out of the dock, keeping its slot */
  popOut: (id: string) => void;
  /** a pop-out said bye or asked to go back: the panel returns to its slot */
  returnPanel: (id: string) => void;
  /** takes `id` out of the dock, keeping its slot: a pop-out showing it */
  claimPanel: (id: string) => void;
  /** a pop-out's hello for `id`: the dock lets go of it, unless the user
   *  docked it again by hand while it was out */
  heardHello: (id: string) => void;
  /** a pop-out's own close: the dock forgets the panel's slot, so the
   *  window's bye brings nothing back */
  forgetPopped: (id: string) => void;
  /** what one backend's stream said, `from` home unless named */
  applyEvent: (ev: ServerEvent, from?: string) => void;
  setWorkspaces: (ws: Workspace[]) => void;
  setSidebarWidth: (px: number) => void;
  toggleSidebar: () => void;
  setDrawer: (open: boolean) => void;
  setCliOpen: (open: boolean) => void;
  /** adds a command to the transcript, or replaces it by id */
  cliPut: (entry: CliEntry) => void;
  cliClear: () => void;
  /** folds or unfolds one section; the tree and the grid fold together */
  toggleGroup: (key: string) => void;
  /** folds (`fold`) or opens every group of `keys`, the ones showing */
  foldGroups: (keys: readonly string[], fold: boolean) => void;
  /** folds or unfolds one section (changes, shell, history, claude…) of one repo's panel */
  toggleSection: (repoId: string, key: string) => void;
  /** folds (`fold`) or unfolds every section one repo's panel shows, its
   *  shells too; a hidden section, or one the bench holds open, stays as it was */
  foldSections: (repoId: string, fold: boolean) => void;
  setSoloWidth: (px: number) => void;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  /** opens a new shell at a repo where the settings say: its panel, the
   *  strip, or a tab or window of its own; `place` overrides the setting */
  openTerm: (repoId: string, place?: ShellPlace, start?: "agent", prompt?: string, pick?: LaunchPick, label?: string) => void;
  closeTerm: (id: string) => void;
  /** puts a shell's tab down here and leaves the shell running for the
   *  other devices, and for picking back up from the shells list */
  hideTerm: (id: string) => void;
  /** shows a running shell here, whichever device started it: its tab
   *  when this window has one, else a new tab onto it */
  joinTerm: (id: string) => void;
  /** a new shell at the repo with an agent conversation from it picked
   *  back up in it by its own harness */
  resumeAgent: (repoId: string, session: string, harness: Harness) => Promise<void>;
  /** after a move: the old tab gone, the panel showing the target's
   *  checkout, and the moved shell's tab in the old one's place */
  landMove: (oldTab: string, fromRepoId: string, toRepoId: string, info: TermInfo) => void;
  showTerm: (id: string) => void;
  /** a card's section as a tab at a shell window (FR-030), out of the card
   *  and out of any other place it was a tab; the strip shows it */
  tabSection: (repoId: string, key: SectionKey, place: SectionPlace) => void;
  /** a chat or a popup as a tab at a shell window (FR-030), out of any
   *  other place it was a tab; the strip shows it */
  tabItem: (place: SectionPlace, item: TabRef) => void;
  /** a chat, an agent or a popup as a dock panel of its own (FR-047), a
   *  column or a tab of the showing cell by `into`, out of any shell
   *  window's tab and off the sheet it was in */
  dockItem: (item: TabRef, into?: Arrangement) => void;
  /** a section's or an item's tab closed; a section goes back in its card */
  untab: (id: string) => void;
  /** shows a section's or an item's tab in the strip and the sessions view */
  showStripPage: (id: string) => void;
  /** names a tab by hand, and its shell on the backend so every device's
   *  tab says it; a blank label puts its repo's name back */
  renameTerm: (id: string, label: string) => void;
  /** trades two tabs' places in the row */
  swapTerms: (a: string, b: string) => void;
  /** starts a kept shell again where it was, with what it had; `resume`
   *  also runs the line that picks its agent's conversation back up */
  restoreShell: (id: string, resume?: boolean) => Promise<void>;
  /** drops a kept shell's record and history without restoring it */
  forgetShell: (id: string) => Promise<void>;
  /** turns a backend's shell recording on or off */
  setKeeping: (on: boolean, backend?: string) => Promise<void>;
  /** reads the broker's view (who, channels, the notify switch) */
  loadChan: () => Promise<void>;
  /** reads the agent registry off the home backend; a backend without a
   *  broker leaves it off */
  loadRegistry: () => Promise<void>;
  /** asks each of these shells what runs in it and keeps the answers in
   *  `shellAgents`, dropping shells no longer asked about; a shell that does
   *  not answer counts as running nothing */
  probeShells: (ids: readonly string[]) => Promise<void>;
  /** reads the asks, whether they can be answered, and presence off the
   *  home backend; a backend without a broker leaves them off */
  loadAsks: () => Promise<void>;
  /** opens the inbox, on one item (`ask:<id>`, `run:<id>`, `flow:<id>`) when given */
  openInbox: (focus?: string) => void;
  closeInbox: () => void;
  /** routes an answer to where the item came from: a run's prompt, a
   *  flow's gate, or the broker's ask with this browser's answer key */
  answerInbox: (item: InboxItem, answer: InboxAnswer) => Promise<void>;
  /** reads the incubator's list off one backend, home by default */
  loadSprouts: (backend?: string) => Promise<void>;
  /** reads one backend's ranger, home by default; an older backend has none */
  loadRanger: (backend?: string) => Promise<void>;
  /** reads one backend's keep awake; an older backend has none */
  loadAwake: (backend: string) => Promise<void>;
  /** sets one backend's keep awake mode; the error is the backend's words */
  setAwake: (backend: string, mode: AwakeMode) => Promise<void>;
  /** reads the home backend's sweep; an older backend has none */
  loadSweep: () => Promise<void>;
  /** opens the sweep sheet, which reads the sweep afresh */
  openSweep: () => void;
  /** opens it with only these keys ticked: the ask's "pick" */
  pickSweep: (keys: string[]) => void;
  /** patches the sweep's settings on the home backend */
  setSweepSettings: (patch: Record<string, unknown>) => Promise<void>;
  /** closes the items named, each looked at again first; how each went */
  closeSweep: (keys: string[]) => Promise<SweepOutcome[]>;
  /** starts a chat on a swept chat's session and opens it, waiting for a message */
  resumeSwept: (runId: string) => Promise<void>;
  /** reads one backend's health checks, home by default */
  loadHealth: (backend?: string) => Promise<void>;
  /** reads one backend's capacity, home by default; an older backend has none */
  loadCapacity: (backend?: string) => Promise<void>;
  /** reads one backend's kit, home by default */
  loadKit: (backend?: string) => Promise<void>;
  /** reads one backend's landing queue, home by default */
  loadLanding: (backend?: string) => Promise<void>;
  /** "land" on a ready branch run, by its run's or branch's id; `approve`
   *  is the sensitive patch id the approve sheet showed */
  landRun: (id: string, approve?: string, skipJudge?: boolean) => Promise<void>;
  /** "land all" in a repo; the answer names the runs it skipped */
  landAll: (repoId: string) => Promise<{ queued: string[]; skipped: { id: string; branch: string; why: string }[] }>;
  /** one file's diff from a branch run's latest sort */
  landingDiff: (id: string, path: string) => Promise<string>;
  /** "seen" on landing notices */
  seenLanding: (ids: readonly string[]) => Promise<void>;
  /** opens the approve sheet for a branch run that needs one */
  showApprove: (id: string) => void;
  /** "fix it" on a sent-back branch: starts the fix and opens its sheet */
  fixLanding: (id: string) => Promise<void>;
  /** gives a sent-back branch up, with its worktree */
  dropLanding: (id: string) => Promise<void>;
  /** an orphaned run worktree on a backend: removed or queued */
  orphanLanding: (backend: string, dir: string, action: "remove" | "queue") => Promise<void>;
  /** opens a repo's panel with its landing section unfolded */
  showLanding: (repoId: string) => void;
  /** reads one backend's PRs, home by default */
  loadPrs: (backend?: string) => Promise<void>;
  /** reads one backend's trigger rules and events, home by default */
  loadTriggers: (backend?: string) => Promise<void>;
  /** fires a made-up issue through one backend's rule */
  fireTrigger: (backend: string, rule: string, title: string, repo?: string) => Promise<Delivery>;
  /** runs one backend's rule's poll now */
  pollTrigger: (backend: string, rule: string) => Promise<void>;
  /** resume, retry or stop a trigger event, by its id */
  triggerAct: (id: string, act: "resume" | "retry" | "stop") => Promise<void>;
  /** drops an ended trigger event from the list */
  dismissTrigger: (id: string) => Promise<void>;
  /** "open PR" on a ready branch run, by its run's or branch's id */
  openPr: (id: string, draft?: boolean) => Promise<void>;
  /** the PR footer's toggles, by the branch's id */
  setPr: (id: string, change: { autoFix?: boolean; autoMerge?: boolean }) => Promise<void>;
  /** closes a branch's PR; the run may land here again */
  closePr: (id: string) => Promise<void>;
  /** reads one backend's caller check, home by default */
  loadAuth: (backend?: string) => Promise<void>;
  /** asks a backend to let this page in, waits for someone to approve it,
   *  and keeps the token it mints */
  /** asks a backend to let this page in and polls until someone approves;
   *  `resume` only picks up a sign-in this tab left waiting before a reload */
  signIn: (backend: string, resume?: boolean) => Promise<void>;
  /** approves this page's own waiting sign-in with the first code from the
   *  backend's log */
  useFirstCode: (backend: string, code: string) => Promise<void>;
  approvePair: (backend: string, id: string) => Promise<void>;
  denyPair: (backend: string, id: string) => Promise<void>;
  /** ends a caller's token; this page's own forgets it here too */
  revokeCaller: (backend: string, id: string) => Promise<void>;
  /** each backend's secret store, by backend name: names, sinks and
   *  proposals, never a value; an older backend that has none is missing */
  secrets: Record<string, SecretsInfo>;
  /** reads one backend's secret store, home by default */
  loadSecrets: (backend?: string) => Promise<void>;
  /** heals one check now; the error is the backend's words */
  healCheck: (backend: string, id: string) => Promise<void>;
  /** a change to a backend's ranger: on, profile, handle, telegram, fresh */
  setRanger: (backend: string, patch: Record<string, unknown>) => Promise<void>;
  rangerAct: (backend: string, act: "restart" | "fresh") => Promise<void>;
  addRangerWake: (backend: string, wake: { prompt: string; cron?: string; when?: string }) => Promise<void>;
  removeRangerWake: (backend: string, id: string) => Promise<void>;
  /** the ranger's session as a tab in the strip along the bottom, joined only */
  openRanger: (backend: string) => void;
  /** accepts or dismisses a retro lesson; a chat it opened is shown, a file
   *  is answered for the inbox to name */
  answerAdvice: (key: string, accept: boolean) => Promise<AdviceAccepted | null>;
  /** a new project from the + project sheet or n; answers before the seed is made */
  /** starts a project on the named backend, home by default */
  createSprout: (form: FormData, backend?: string) => Promise<Sprout>;
  addSproutInputs: (id: string, form: FormData) => Promise<Sprout>;
  /** clarify's questions answered, or null to go on assumptions */
  answerSprout: (id: string, answers: Record<string, string> | null) => Promise<void>;
  stopSprout: (id: string) => Promise<void>;
  resumeSprout: (id: string, choice: "continue" | "retry") => Promise<void>;
  /** the yes or no to an extend's push, for the head the page showed */
  handOffSprout: (id: string, approve: boolean, head: string) => Promise<void>;
  dismissSprout: (id: string) => Promise<void>;
  showSprout: (id: string) => void;
  openNewSprout: () => void;
  /** the new project form, filled in from the command line's `new` */
  draftSprout: (draft: SproutDraft) => void;
  /** pins away, or clears it and is here */
  setAway: (away: boolean) => Promise<void>;
  /** someone is at this page: the human is here, at most once a minute,
   *  and only with an answer key to say so with */
  pagePresence: () => void;
  /** keeps this browser's answer key, or forgets it with null */
  setAnswerKey: (key: string | null) => void;
  /** tries a key with a presence beat, the one write that changes nothing
   *  a person set: ok, or refused by the broker, or no answer */
  testAnswerKey: (key: string) => Promise<KeyTest>;
  /** opens the popover, on a conversation or target ("#x", "@h") when given */
  openChan: (target?: string) => void;
  closeChan: () => void;
  /** a tailchan tab mounted or gone: while one is up it reads as the
   *  popover does, its conversations loaded and nothing counted unread */
  chanTab: (on: boolean) => void;
  /** shows a conversation and reads its history */
  showConv: (conv: string) => Promise<void>;
  sendChan: (target: string, body: string, kind?: "text" | "clip") => Promise<void>;
  putChan: (target: string, file: File, note?: string) => Promise<void>;
  setChanNotify: (on: boolean) => Promise<void>;
  /** marks a shell whose process has ended; its tab stays until closed */
  endTerm: (id: string, code: number | null) => void;
  /** records the initial socket's label before the shell appears in a terms event */
  termSocketLabelSent: (id: string, label: string | null) => void;
  setTermHeight: (px: number) => void;
  setPanelTermHeight: (repoId: string, px: number) => void;
  setFocusSize: (size: FocusSize | null) => void;
  /** puts `front` in front, or nothing with null */
  setFront: (front: Front | null) => void;
  /** brings a project's bench to the front, opening its panel; null puts
   *  it back */
  bringProject: (repoId: string | null) => void;
  /** one part fills `repoId`'s bench while it is in front, or with null
   *  every part shows side by side again */
  soloBench: (repoId: string, pane: BenchPane | null) => void;
  /** brings a running shell to the front in its own place instead of what
   *  is there now: the strip, or its project's bench; its tab here, or a
   *  new tab onto it */
  bringTerm: (id: string) => void;
  /** a shell tab moved to the strip or its repo's panel, on the backend
   *  first so every device's tab follows (FR-031); false when it could not */
  placeTerm: (id: string, place: ShellPlace) => Promise<boolean>;

  /** opens the pre-flight dialog for an action on a repo */
  plan: (repoId: string, action: RunAction) => void;
  /** the pre-flight dialog for a run across a workspace, on its primary;
   *  throws when the workspace has no primary in the tree */
  openWsPlan: (name: string, action: RunAction) => void;
  /** opens a chat with Claude in a repo: the repo's live run if it has one,
   *  else a new idle chat whose first message starts Claude (the peers
   *  panel's "merge with claude" passes one; the menu's plain chat does not) */
  openChat: (repoId: string, note?: string) => Promise<void>;
  /** hands text to the repo's agent: the next turn of its idle chat, else
   *  pasted into a shell of the repo that runs Claude Code or Codex (Enter
   *  left to the user), else a new chat that starts with it. Throws while a
   *  run is busy. Says which of the three it did. */
  sendToAgent: (repoId: string, text: string) => Promise<"said" | "pasted" | "started">;
  /** review notes left on diff lines, by repo id, kept in this browser
   *  (`ui/src/reviewnotes.ts`) until sent to the repo's agent or cleared */
  reviewNotes: Record<string, Note[]>;
  /** leaves a note on a diff line */
  addNote: (note: Omit<Note, "id">) => void;
  removeNote: (repoId: string, id: string) => void;
  clearNotes: (repoId: string) => void;
  /** hands a repo's notes to its agent in one message (`sendToAgent`) and
   *  drops the ones it sent; throws as sendToAgent does, keeping them */
  sendNotes: (repoId: string) => Promise<"said" | "pasted" | "started">;
  /** opens the repo's agent override */
  editAgent: (repoId: string) => void;
  /** stores a repo's override on its backend; an empty one removes it */
  setAgent: (repoId: string, agent: RepoAgent) => Promise<void>;
  /** writes or (null) deletes a profile on a backend */
  setProfile: (backend: string, name: string, settings: AgentSettings | null) => Promise<void>;
  /** points a role at a pick on a backend, or (null) back at the default */
  setRole: (backend: string, role: AgentRole, pick: AgentPick | null) => Promise<void>;
  setAgentScope: (backend: string, scope: AgentScope, pick: AgentPick | null) => Promise<void>;
  /** archives a repo in canopy, or brings it back */
  archiveRepo: (repoId: string, archived: boolean) => Promise<void>;
  /** stars a repo in canopy; unstarring takes the star off every checkout
   *  of its card, since the card shows one star for them all */
  favoriteRepo: (repoId: string, favorite: boolean) => Promise<void>;
  /** marks one checkout as the harness; unmarking clears every marked
   *  checkout of its card, since the card is the unit of the figure */
  harnessRepo: (repoId: string, harness: boolean) => Promise<void>;
  /** marks this browser as having read the harness line for the given week */
  sayHarness: (key: string) => void;
  /** opens the repo's launch settings */
  editLaunch: (repoId: string) => void;
  setLaunch: (repoId: string, settings: LaunchSettings) => Promise<void>;
  /** opens the repo's panel with its launch section unfolded */
  showLaunch: (repoId: string) => void;
  /** the add or edit sheet for a repo's task; null adds one */
  editTask: (repoId: string, name: string | null) => void;
  /** opens a repo's panel with its tasks unfolded */
  showTasks: (repoId: string) => void;
  /** opens a repo's panel with its agents section unfolded */
  showAgents: (repoId: string) => void;
  /** opens a repo's panel with its health section unfolded */
  showHealth: (repoId: string) => void;
  /** brings a repo's bench to the front with `task`'s log in it (null for
   *  the one the bench picks) */
  bringTask: (repoId: string, task?: string | null) => void;
  /** the bench of `repoId` goes back to picking its own task, as a tasks
   *  section that folds or goes asks; the bench stays */
  dropBenchTask: (repoId: string) => void;
  /** a task's terminal as a tab among the panel's shells or the strip's; closing it leaves the task running */
  openTaskTab: (repoId: string, task: TaskInfo, place: ShellPlace) => void;
  stopJob: (jobId: string) => Promise<void>;
  dismissJob: (jobId: string) => Promise<void>;
  /** takes a peer's WIP as a new local branch (or the given one) */
  /** answers where the WIP went, as the server put it */
  takeWip: (repoId: string, peer: string, branch: string) => Promise<TakeResult | null>;
  /** tracks a branch that exists only on a peer, as a local branch here */
  trackBranch: (repoId: string, peer: string, branch: string) => Promise<void>;
  /** seeds the allow-listed files (.env and the like) from a peer that has them */
  seedRepo: (repoId: string) => Promise<void>;
  /** runs the peer pass for just this repo, instead of waiting for the timer */
  syncPeers: (repoId: string) => Promise<void>;
  /** shows a run's console */
  showRun: (runId: string) => void;
  showGroup: (groupId: string) => void;
  pickRunGroup: (groupId: string, origin: string) => Promise<void>;
  reviewGroup: (groupId: string) => Promise<void>;
  dropGroup: (groupId: string, keep?: string[]) => Promise<void>;
  closeSheet: () => void;
  /** opens the search across every repo in view */
  openSearch: () => void;
  /** opens the sheet of every keyboard shortcut on a view */
  openKeys: (view: string) => void;
  setSearchQuery: (q: string) => void;
  /** closes the search sheet, opens the repo's panel with its search section
   *  unfolded, and hands that section the term */
  searchIn: (repoId: string, q: string) => void;
  /** the section took its term */
  takePendingSearch: () => void;
  /** `branch` puts the run on a branch of its own; unset, the backend's
   *  default for the action. `pr` opens a PR once it is ready (FR-011) */
  startGroup: (repoId: string, action: RunAction, note: string, times: number, profile?: string, autoLand?: boolean, pr?: boolean) => Promise<void>;
  startRun: (repoId: string, action: RunAction, note: string, branch?: boolean, pr?: true) => Promise<void>;
  /** a run on a workspace's primary that sees its other members too */
  startWsRun: (name: string, action: RunAction, note: string) => Promise<void>;
  answerRun: (runId: string, promptId: string, answer: RunAnswer) => Promise<void>;
  /** every shown backend's remembered rules, read again; one that cannot
   *  say (an older canopy) keeps what the page had */
  loadRemembered: () => Promise<void>;
  forgetRemembered: (backend: string, id: string) => Promise<void>;
  /** the next message in a chat */
  sayRun: (runId: string, text: string) => Promise<void>;
  stopRun: (runId: string) => Promise<void>;
  dismissRun: (runId: string) => Promise<void>;
  /** edits a coordinator's proposed card; the run's broadcast brings it back */
  coordPlanEdit: (runId: string, taskId: string, change: CoordEdit) => Promise<void>;
  /** removes a coordinator's proposed card */
  coordRemove: (runId: string, taskId: string) => Promise<void>;
  /** start these: a coordinator's proposed cards join its queue */
  coordStart: (runId: string) => Promise<void>;

  /** loads (or reloads) the workflows a repo can run, for the menu */
  loadWorkflows: (repoId: string) => Promise<void>;
  /** opens the pre-flight for a workflow on a repo, or its live flow/run */
  planFlow: (repoId: string, workflow: string) => void;
  /** `request`: the plan sheet's id for this start (see api.startFlow) */
  startFlow: (repoId: string, workflow: string, note: string, request?: string) => Promise<void>;
  resumeFlow: (flowId: string, choice: FlowChoice) => Promise<void>;
  stopFlow: (flowId: string) => Promise<void>;
  dismissFlow: (flowId: string) => Promise<void>;
  showFlow: (flowId: string) => void;
  /** turns select mode on the board on or off; it starts with nothing picked */
  setSelecting: (on: boolean) => void;
  /** flips one repo; with `extend`, sets every repo from the anchor to it to the anchor's state instead */
  toggleSelected: (repoId: string, extend?: boolean) => void;
  setSelected: (ids: string[]) => void;
  /** every pickable repo in view, none of them, or the other ones */
  pickAll: () => void;
  pickNone: () => void;
  pickInvert: () => void;
  /** a group's tick: fills the group unless it is full already, then clears it */
  pickGroup: (ids: string[]) => void;
  /** just the repos in view in one state */
  pickFacet: (facet: RepoFilter) => void;
  /** opens the pre-flight for a fleet workflow over the selected repos */
  planFleet: (workflow: string) => void;
  startFleet: (workflow: string, note: string, request?: string) => Promise<void>;
  stopFleet: (fleetId: string) => Promise<void>;
  dismissFleet: (fleetId: string) => Promise<void>;
  showFleet: (fleetId: string) => void;
}

export type Sheet =
  /** `workspace` makes it a run across that workspace; `repoId` is then its primary */
  | { kind: "plan"; repoId: string; action: RunAction; workspace?: string }
  | { kind: "run"; runId: string }
  | { kind: "group"; groupId: string }
  | { kind: "agent"; repoId: string }
  /** `draft` fills the form, from the command line's `new` */
  | { kind: "new-sprout"; draft?: SproutDraft }
  | { kind: "sprout"; id: string }
  | { kind: "launch"; repoId: string }
  | { kind: "task"; repoId: string; name: string | null }
  | { kind: "search" }
  | { kind: "flow-plan"; repoId: string; workflow: string }
  | { kind: "flow"; flowId: string }
  | { kind: "fleet-plan"; workflow: string }
  | { kind: "fleet"; fleetId: string }
  /** a branch run's sensitive files and their diffs, then "approve and land" */
  | { kind: "approve"; id: string }
  /** what went idle, to pick from and close (FR-018); `picks` are the
   *  keys it starts ticked, the sweep's ask's when the inbox opened it, and
   *  `pick` numbers that opening, so each one starts the sheet afresh */
  | { kind: "sweep"; picks?: string[]; pick?: number }
  /** every keyboard shortcut on `view`, from the ? key (FR-021) */
  | { kind: "keys"; view: string };

export interface ClickModifiers {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

const layout = loadLayout();

/** The shells this window hung up, for the page's life: the tab's socket
 *  closing tells the server before the end request may, and the list it
 *  sends back still has the shell in it, which `adoptTerms` must not turn
 *  back into a tab. Names are random and a shell ended here cannot be
 *  restored, so none of them comes back legitimately. */
const endedShells = new Set<string>();

/** the shells `adoptTerms` passes over: the ones this window ended and the
 *  ones this browser hid */
const skipped = (hidden: string[]): ReadonlySet<string> => new Set([...endedShells, ...hidden]);

/** The tabs this window takes up from the shells the backends hold: the
 *  grove's for its dock and strip; a pop-out's (`popped=1`) for its own
 *  panel alone, so its shell travels with it; none in any other dockless
 *  window, whose shells the grove shows. */
function adoptHere(tabs: TermTab[], live: TermInfo[], repos: Repo[], panels: string[], ended: ReadonlySet<string>): TermTab[] {
  if (!dockless()) return adoptTerms(tabs, live, repos, panels, ended);
  const route = parseRoute(window.location.search);
  return route.popped && route.repo ? adoptPoppedTerms(tabs, live, repos, route.repo, ended) : tabs;
}

/** a shell window's url onto one named shell */
const shellUrlFor = heldShellUrl;

/** The state a fresh tree from one backend implies: its repos and sources
 *  in place of that backend's old ones, and the panels, widths and folds
 *  that still have a repo to belong to. Only that backend's are judged: a
 *  panel of a backend that has not answered stays until that one says. */
function treeState(
  s: CanopyState,
  tree: ScanResult,
  from: string,
): Pick<
  CanopyState,
  | "root"
  | "sources"
  | "repos"
  | "conns"
  | "panels"
  | "dockLayout"
  | "activePanel"
  | "popped"
  | "panelWidths"
  | "panelTermHeights"
  | "closedSections"
  | "tasks"
  | "taskErrors"
  | "front"
> {
  const reg = registry();
  const mine = mineOf(from);
  // drop panels whose repo no longer exists — a panel with no repo
  // renders nothing, including its own close button. The same array when
  // none goes, so a scan that changes nothing does not count as a change.
  const left = s.panels.filter((id) => !mine(id) || tree.repos.some((r) => r.id === id));
  const panels = left.length === s.panels.length ? s.panels : left;
  // The showing tab may be among the dropped; then the first panel's cell
  // says what shows, and no other cell's showing tab changes
  const kept = s.activePanel !== null && panels.includes(s.activePanel) ? s.activePanel : null;
  const dockLayout = panels === s.panels ? s.dockLayout : placeAll(laidOut(s), panels, kept, arrangementOf(s), widthOf(s));
  const first = panels[0];
  const activePanel = kept ?? (first === undefined ? null : (cellOf(dockLayout, first)?.active ?? first));
  return {
    root: from === s.home ? tree.root : s.root,
    sources: sliceIn(reg, s.sources, from, tree.sources, (x) => x.id),
    repos: sliceIn(reg, s.repos, from, tree.repos, (r) => r.id),
    conns: withConn(s, from, { backend: tree.backend }),
    panels,
    // the layout loses the same panels, and is the same object when none go
    dockLayout,
    // a bench whose repo left the scan goes with its panel
    front: panels === s.panels ? s.front : keepFront(s.front, s.terms, panels),
    activePanel,
    // a popped panel whose repo left the scan has nothing to come back to
    popped: pruneByRepo(s.popped, tree.repos, mine),
    panelWidths: pruneByRepo(s.panelWidths, tree.repos, mine),
    panelTermHeights: pruneByRepo(s.panelTermHeights, tree.repos, mine),
    closedSections: pruneByRepo(s.closedSections, tree.repos, mine),
    tasks: pruneByRepo(s.tasks, tree.repos, mine),
    taskErrors: pruneByRepo(s.taskErrors, tree.repos, mine),
  };
}

/** runs, flows, fleets and jobs with one backend's replaced by what it
 *  answers now, and the flow runs worked out again */
function recordsState(
  s: CanopyState,
  from: string,
  got: { runs: Run[]; flows: Flow[]; fleets: Fleet[]; jobs: Job[] },
): Pick<CanopyState, "runs" | "flows" | "fleets" | "jobs" | "flowRuns"> {
  const flows = recordIn(s.flows, from, got.flows);
  return {
    runs: recordIn(s.runs, from, got.runs),
    flows,
    fleets: recordIn(s.fleets, from, got.fleets),
    jobs: recordIn(s.jobs, from, got.jobs),
    flowRuns: flowRunsOf(Object.values(flows)),
  };
}

/** The feed's view of the state as one backend saw it: its repos, sources,
 *  shells, devices and kept shells alone, its helpers and launchers, so an
 *  event from it does not read another backend's as gone. */
function feedView(s: CanopyState, from: string): FeedSnapshot {
  const mine = mineOf(from);
  return {
    repos: s.repos.filter((r) => mine(r.id)),
    sources: s.sources.filter((x) => mine(x.id)),
    runs: s.runs,
    flows: s.flows,
    fleets: s.fleets,
    workspaces: s.workspaces,
    jobs: s.jobs,
    tasks: s.tasks,
    taskAll: s.taskAll,
    launchers: s.launchers[from] ?? {},
    helpers: connOf(s, from).helpers,
    devices: s.devices.filter((d) => mine(d.id)),
    shells: s.shells.filter((t) => mine(t.id)),
    kept: s.kept.filter((k) => mine(k.id)),
    chanAs: s.chanAs,
    registry: s.registry,
    asks: s.asks,
    presence: s.presence,
    sprouts: s.sprouts,
  };
}

/** whether two shell probes say the same, so a probe that changes nothing
 *  does not re-render the board */
const sameAgents = (a: Record<string, AgentKind | null>, b: Record<string, AgentKind | null>): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
};

/** run id to flow id, for every run a flow owns. */
function flowRunsOf(flows: Flow[]): Record<string, string> {
  const flowRuns: Record<string, string> = {};
  for (const f of flows) {
    for (const st of f.steps) if (st.runId) flowRuns[st.runId] = f.id;
  }
  return flowRuns;
}

/** A peer action answers the repo, with a `take` field only "take" fills
 *  in; that field is not part of Repo and does not belong in state. Routed
 *  through applyEvent the way rescan/addSource/removeSource apply a fresh
 *  scan, so this window's own action reaches the feed and the update pulse
 *  too, and the SSE broadcast that follows finds nothing new to say. */
export type TakeResult = { how: string; branch?: string };

/** What a take did, in the words the command line and the Dock both say. */
export function takeWords(take: TakeResult | null | undefined): string {
  if (take?.how === "present") return "WIP is already in HEAD: nothing to take";
  if (take?.how === "files") return "WIP checked out as uncommitted files";
  return `WIP is on branch ${take?.branch ?? "?"}`;
}

function applyPeerRepo(get: () => CanopyState, result: Repo & { take?: TakeResult }): void {
  const { take: _take, ...repo } = result;
  get().applyEvent({ type: "repo", repo });
}

/** Which /api/peers read is the newest, per backend: two quick peers
 *  events can bring their answers back in either order, and only the last
 *  one asked lands. */
const peersRead = new Map<string, number>();

/** Reads a backend's peer mode (and, for home, who was seen) into the
 *  store. The mode lives in the config, so this is how the page follows a
 *  change to it. */
function readPeers(get: () => CanopyState, set: (p: Partial<CanopyState>) => void, b: string): void {
  const mine = (peersRead.get(b) ?? 0) + 1;
  peersRead.set(b, mine);
  void api
    .peers(b)
    .then((p) => {
      if (mine !== peersRead.get(b)) return;
      const s = get();
      const conns = connsIf(s, b, { peerSync: p.sync });
      set(b === s.home ? { conns, peerSeen: p.seen, peerSync: p.sync } : { conns });
    })
    .catch(() => {});
}

/** Which init is the page's: each one's cleanup closes only what it
 *  opened, since StrictMode runs a second before the first has let go. */
let epoch = 0;
/** the inits whose cleanup has run; a connect they started lands nothing */
const dead = new Set<number>();

/** The event streams open to backends other than home, by name, with the
 *  init that opened them, so hiding one or the page's cleanup closes it. */
const streams = new Map<string, { epoch: number; off: () => void }>();

/** Each backend's current connect attempt: an older one that finishes
 *  late (after a retry, a hide, or the page's cleanup) lands nothing. */
const connecting = new Map<string, number>();

/** Each backend's automatic reconnect after a failed connect: the timer
 *  waiting to try again (null while a try is under way), how many tries
 *  have failed in a row, and the init that owns it, so a cleanup clears
 *  only its own. A backend that answers, is hidden, or whose init is gone
 *  has none. */
const retries = new Map<string, { timer: ReturnType<typeof setTimeout> | null; tries: number; epoch: number }>();

/** the first automatic wait; tests shorten it */
let retryFirst = RETRY_FIRST;
export const setRetryFirst = (ms: number): void => {
  retryFirst = ms;
};

/* The registry's own bookkeeping, outside the store since nothing renders
   it: which event last told of each card, numbered, so a list read while
   events landed passes over what they said; and the retry of a first load
   that failed. */
let registryEvents = 0;
const registryHeard = new Map<string, number>();
let registryRetry: ReturnType<typeof setTimeout> | null = null;
let registryTries = 0;
const REGISTRY_RETRY_FIRST = 5_000;
const REGISTRY_RETRY_MAX = 5 * 60_000;
/* the same numbering for the asks, so a list never reopens what an event
   closed while it was on its way */
let sproutEvents = 0;
const sproutHeard = new Map<string, number>();
/** Only the newest sprout-list read per backend may replace its slice. */
const sproutLoads = new Map<string, number>();
/* and each backend's stages events, so a read on its way never undoes a newer one */
const stagesEvents = new Map<string, number>();
/* and each backend's ranger events, the same */
const rangerEvents = new Map<string, number>();
/* and the home backend's sweep events */
let sweepEvents = 0;
/* each "pick" from the sweep's ask, so the sheet it opens is a new one */
let sweepPicks = 0;
/* and each backend's health events, the same way */
const healthEvents = new Map<string, number>();
/* and each backend's capacity events, so a list read while events land passes over them */
const capacityEvents = new Map<string, number>();
/* and each backend's kit events, the same way */
const kitEvents = new Map<string, number>();
/* and each backend's landing events */
const landingEvents = new Map<string, number>();
/* and each backend's PR events */
const prsEvents = new Map<string, number>();
/* and each backend's trigger events */
const triggersEvents = new Map<string, number>();
/* and each backend's pair events */
const authEvents = new Map<string, number>();
/* each sign-in's poll, by backend, so one in flight is not started twice
   (a backend holds at most three pair requests) and a hide stops it */
const signingIn = new Map<string, number>();
let signInSeq = 0;
/** each backend's last pair request, offered with the next one as a renewal
 *  so the server replaces it instead of keeping both; gone once signed in */
const lastPairs = new Map<string, { id: string; secret: string }>();
/** how often a sign-in asks whether it was approved, and for how long */
let claimEvery = 2_000;
const CLAIM_WINDOW = 10 * 60_000;
/** for tests: a shorter wait between claims */
export function setClaimEvery(ms: number): void {
  claimEvery = ms;
}
/* and each backend's secrets events */
const secretsEvents = new Map<string, number>();
/** the same for the advice on offer */
let adviceEvents = 0;

/** an action's answer about a sprout, applied like its event unless an
 *  event already moved the sprout on past it (checked first, so a stale
 *  answer adds no feed line either) */
function sproutAnswered(get: () => CanopyState, sp: Sprout): void {
  if (staleSprout(get().sprouts, sp)) return;
  get().applyEvent({ type: "incubator", sprout: sp }, ownerOf(sp.id));
}
let asksEvents = 0;
const asksHeard = new Map<string, number>();

/** Cancel a backend's waiting retry; `forget` also drops its count of
 *  failures, for a backend that answered or left the page. */
function stopRetry(name: string, forget: boolean): void {
  const r = retries.get(name);
  if (!r) return;
  if (r.timer) clearTimeout(r.timer);
  if (forget) retries.delete(name);
  else r.timer = null;
}

/** the saved tabs and showing strip tab the page loaded with, so a backend
 *  answering later brings its own back where they were */
let loadedTabs: { terms: TermTab[]; activeTerm: string | null } = { terms: [], activeTerm: null };

/** the page's own origin, which picks a backend's URL; none under a test */
const pageOrigin = (): string => (globalThis as { location?: { origin?: string } }).location?.origin ?? "http://localhost";

/** The registry, the page's backend order and the names every id is told
 *  apart by, from the home backend's list less the hidden ones. Home is
 *  always first: it is the page's own machine. `also`
 *  names more backends to tell ids apart by without connecting to them:
 *  the cached list, when the home backend's could not be read, so its
 *  saved tabs and panels are parked and kept rather than read as home's. */
function applyRegistry(
  home: string,
  entries: readonly BackendEntry[],
  hidden: readonly string[],
  also: readonly BackendEntry[] = [],
): string[] {
  const all = [home, ...entries.map((e) => e.name).filter((n) => n !== home)];
  known = { home, names: [...all, ...also.map((e) => e.name).filter((n) => !all.includes(n))] };
  const order = all.filter((n) => n === home || !hidden.includes(n));
  setRegistry(home, order);
  return order;
}

/** the home backend's list of backends, kept for connecting and unhiding */
let registryEntries: BackendEntry[] = [];

/** Opens the panel of each saved panel shell among `tabs` whose panel is
 *  not open, with its shell section unfolded. Saved tabs alone: a shell
 *  adopted from the backend's list must not reopen a panel that was closed
 *  on purpose. A panel it opens loses any popped slot, as one docked by
 *  any other road does, but is not recalled: this is a load, not the
 *  user, so a pop-out still showing it may claim it again. */
function openSavedPanels(
  panels: string[],
  closedSections: ClosedSections,
  popped: Record<string, number>,
  tabs: readonly TermTab[],
): { panels: string[]; closedSections: ClosedSections; popped: Record<string, number> } {
  const savedIds = new Set(loadedTabs.terms.map((t) => t.id));
  for (const t of tabs) {
    if (t.place !== "panel" || panels.includes(t.repoId) || !savedIds.has(t.id)) continue;
    panels = [...panels, t.repoId];
    closedSections = unfoldIn(closedSections, t.repoId, "shell");
    popped = without(popped, t.repoId);
  }
  return { panels, closedSections, popped };
}

/** A backend refused a call for want of a token: the top bar offers to sign
 *  in to it. A 401 to a call that carried one means the backend no longer
 *  knows it (revoked, or a month unused), so it is forgotten here, unless a
 *  sign-in has kept a new one since that call went out. */
/** Whether this page holds a token for a backend. The sweep is read at start
 *  only then: its routes need the admin right, and a refusal would mark the
 *  backend as wanting a sign-in that nothing else on the page asked for. The
 *  sheet reads it on open whatever, where a refusal is the right answer. */
const signedIn = (b: string): boolean => readToken(originOf(baseOf(b))) !== null;

/** A sweep read after its event. A close the page has not seen is one feed
 *  line and ends agents: their dock panels close here, and an agent window
 *  showing one closes itself on sweepEnded. The hub pings on a resume or a
 *  settings change too, with the same last close, and a restored shell keeps
 *  its id, so only a newer close counts. */
function takeSweep(get: () => CanopyState, set: (s: Partial<CanopyState> | ((s: CanopyState) => Partial<CanopyState>)) => void, sweep: SweepInfo): void {
  const before = get();
  const now = Date.now();
  const entry = freshEntry(before.sweep ? (before.sweep.lastRun?.at ?? null) : undefined, sweep.lastRun, now);
  const lines = sweepLine(entry, now);
  if (lines.length) {
    set((s) => {
      const { feed, seq } = appendFeed(s.feed, lines, s.feedSeq);
      return { feed, feedSeq: seq };
    });
  }
  const ended = entry ? endedCards(entry, Object.values(before.registry), before.home) : new Set<string>();
  set({ sweep, ...(entry ? { sweepEnded: [...ended] } : {}) });
  for (const p of get().panels) {
    const card = cardOfPanel(p);
    if (card && ended.has(card)) get().closePanel(p);
  }
}

function refusedHere(set: (fn: (s: CanopyState) => Partial<CanopyState>) => void, b: string, sent: string | null): void {
  const origin = originOf(baseOf(b));
  const deadToken = sent !== null && readToken(origin) === sent;
  if (deadToken) writeToken(origin, null);
  set((s) => {
    const was = s.authByBackend[b];
    if (!was || (was.needed && !deadToken)) return {};
    return { authByBackend: { ...s.authByBackend, [b]: { ...was, needed: true, ...(deadToken ? { hasToken: false, you: "none" as const, youId: null } : {}) } } };
  });
}

/** One backend's caller check as the store keeps it, from what it answered:
 *  a token the backend no longer knows (it says this page is nobody) is
 *  forgotten, so the top bar offers to sign in again. `sent` is the token
 *  the read carried: one kept since (a sign-in that finished meanwhile) is
 *  not the one the backend said it does not know. */
function authOf(b: string, info: AuthInfo, needed: boolean, sent: string | null): BackendAuth {
  const origin = originOf(baseOf(b));
  if (sent !== null && info.you === "none" && readToken(origin) === sent) writeToken(origin, null);
  return { ...info, hasToken: readToken(origin) !== null, needed: needed && info.you === "none" };
}

/** What a backend's stream coming back after a drop re-reads: the server
 *  replays nothing. Its tree and records, the shells it holds, the ones a
 *  reboot left to restore (worked out before it listened, so never
 *  broadcast to this stream), and the helpers that dialled back in before
 *  this stream did. A failure leaves what is here until the next event. */
function resync(get: () => CanopyState, set: (fn: (s: CanopyState) => Partial<CanopyState>) => void, b: string): void {
  void get()
    .rescan(b)
    .catch(() => {});
  readTasks(get, set, b);
  // cards and asks the broker changed while the stream was down
  if (b === get().home) {
    // a stream that dropped may be a redeploy: the build may have moved
    void readAbout(get, set, b);
    void get().loadRegistry();
    void get().loadAsks();
    if (signedIn(b)) void get().loadSweep();
  }
  // every backend's incubator, which may have moved on too
  void get().loadSprouts(b);
  void get().loadRanger(b);
  void get().loadHealth(b);
  void get().loadCapacity(b);
  void get().loadKit(b);
  void get().loadLanding(b);
  void get().loadPrs(b);
  void get().loadTriggers(b);
  void get().loadAuth(b);
  // a sign-in this tab left waiting before a reload picks up where it was
  void get().signIn(b, true);
  void get().loadSecrets(b);
  // the tasks a panel loaded may have moved while the stream was down
  for (const id of Object.keys(get().tasks)) if (backendOf(id) === b) void get().loadTasks(id).catch(() => {});
  void Promise.all([api.terms(b), api.kept(b), api.helpers(b)])
    .then(([terms, kept, helpers]) => {
      if (!isShown(get(), b)) return;
      get().applyEvent({ type: "terms", terms }, b);
      set((s) => ({
        kept: sliceIn(registry(), s.kept, b, kept.kept, (k) => k.id),
        conns: connsIf(s, b, { keeping: kept.keeping, helpers }),
      }));
    })
    .catch(() => {});
}

/** Reads what a backend runs into its connection; home's first answer is
 *  kept as the build the page loaded against. */
async function readAbout(get: () => CanopyState, set: (fn: (s: CanopyState) => Partial<CanopyState>) => void, b: string): Promise<void> {
  try {
    const about = await api.about(b);
    set((s) => ({
      conns: connsIf(s, b, { about }),
      ...(b === s.home && s.aboutAtLoad === null ? { aboutAtLoad: about } : {}),
    }));
  } catch {
    // an older or unreachable backend: no about, nothing to compare
  }
}

/** what a backend has running, for the top bar; a backend without tmux
 *  answers 503 and simply has none */
function readTasks(get: () => CanopyState, set: (fn: (s: CanopyState) => Partial<CanopyState>) => void, b: string): void {
  api
    .allTasks(b)
    .then((list) => {
      if (!isShown(get(), b)) return;
      const live = list.filter(listedTask);
      set((s) => ({ taskAll: [...s.taskAll.filter((t) => backendOf(t.repoId) !== b), ...live] }));
    })
    .catch(() => {});
}

/** A popped panel the user brings into the dock, or closes, by hand: its
 *  slot goes, so a later bye or load sweep cannot pull it back in after it
 *  is closed, and it is recalled, so its old window's next hello does not
 *  take it out again. A panel that was not out is no change. */
function recall(s: Pick<CanopyState, "popped" | "recalled">, id: string): Pick<CanopyState, "popped" | "recalled"> {
  if (!Object.hasOwn(s.popped, id)) return { popped: s.popped, recalled: s.recalled };
  return { popped: without(s.popped, id), recalled: s.recalled.includes(id) ? s.recalled : [...s.recalled, id] };
}

type DockState = Pick<CanopyState, "panels" | "dockLayout" | "activePanel" | "panelWidths" | "settings">;

/** how a panel opened now joins the dock: a column of its own, or a tab */
export const arrangementOf = (s: Pick<CanopyState, "settings">): Arrangement => (s.settings.openIn === "tabs" ? "tabs" : "columns");

/** this window's layout as a screen layout profile keeps one: what Settings
 *  offers to take into a profile. The column width is the dock's first
 *  column's, or a new column's with none open. */
/** the open cards a tab template lands on, each with its first panel shell */
export function tabCards(s: Pick<CanopyState, "panels" | "repos" | "terms">): TabCard[] {
  const out: TabCard[] = [];
  for (const id of s.panels) {
    const repo = s.repos.find((r) => r.id === id);
    if (repo) out.push({ repo, shell: s.terms.find((t) => t.place === "panel" && t.repoId === id && t.task === undefined)?.id ?? null });
  }
  return out;
}

export function screenLayoutOf(
  s: Pick<CanopyState, "settings" | "dockLayout" | "sidebarOpen" | "sidebarWidth" | "feedOpen" | "panels" | "repos" | "terms">,
): ScreenLayout {
  return {
    arrange: arrangementOf(s),
    carousel: s.settings.dockCarousel,
    sidebarOpen: s.sidebarOpen,
    sidebarWidth: Math.round(s.sidebarWidth),
    columnWidth: Math.round(s.dockLayout.columns[0]?.width ?? PANEL.initial),
    panelZoom: zoomOf(s.settings.zoom, "panel"),
    termFont: s.settings.termFont,
    level: s.settings.level,
    sectionsHidden: [...s.settings.sectionsHidden],
    feedOpen: s.feedOpen,
    ...(s.settings.agentsLayout ? { agents: s.settings.agentsLayout } : {}),
    tabs: captureTabs(s.settings, tabCards(s)),
  };
}

/** a new column's width: the one its panel had when it last closed alone */
const widthOf =
  (s: Pick<CanopyState, "panelWidths">) =>
  (id: string): number =>
    s.panelWidths[id] ?? PANEL.initial;

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The layout holding exactly `s.panels`, in their order: the layout itself
 *  when it already does. Otherwise `panels` was set on its own (a load, a
 *  backend's tree, a test), so the layout follows it: closed panels leave,
 *  new ones join, and a list reordered by hand rebuilds the layout flat,
 *  each column keeping its width. */
function laidOut(s: DockState): DockLayout {
  if (sameList(panelsOf(s.dockLayout), s.panels)) return s.dockLayout;
  const into = arrangementOf(s);
  const l = placeAll(s.dockLayout, s.panels, s.activePanel, into, widthOf(s));
  if (sameList(panelsOf(l), s.panels)) return l;
  const widths = { ...s.panelWidths };
  for (const c of l.columns) {
    const only = c.cells.length === 1 ? c.cells[0]?.panels : undefined;
    if (only?.length === 1 && only[0] !== undefined) widths[only[0]] = c.width;
  }
  return fromLegacy(s.panels, s.activePanel, widths, l.columns[0]?.width ?? PANEL.initial, into);
}

/** `panels` for a layout: the same array when it reads the same, so an
 *  action that moved nothing is no change to save */
const panelsFor = (s: Pick<CanopyState, "panels">, l: DockLayout): string[] => {
  const next = panelsOf(l);
  return sameList(next, s.panels) ? s.panels : next;
};

/** Each column's width by the panel leading it, the one alone in its top
 *  cell. A column topped by a cell of tabs has no lead: its width is the
 *  tabbed dock's, not one panel's. */
function leadWidths(l: DockLayout): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of l.columns) {
    const top = c.cells[0]?.panels;
    if (top?.length === 1 && top[0] !== undefined) out[top[0]] = c.width;
  }
  return out;
}

/** the column `id` is alone in, if it is: one cell of one panel */
function loneColumn(l: DockLayout, id: string) {
  const col = columnOf(l, id);
  return col && col.cells.length === 1 && col.cells[0]?.panels.length === 1 ? col : undefined;
}

/** `focusPanel`, and a panel docked here is out in no window of its own any
 *  more (`recall`). Every way into the dock by hand goes through this, so
 *  it writes the layout too: a new panel becomes a column, or a tab of the
 *  cell that was showing (the previous active, not the new one, which no
 *  cell holds yet), by the dock's arrangement or `into` when given, and
 *  then shows. */
function dockPanel(s: DockState & Pick<CanopyState, "popped" | "recalled">, id: string, into: Arrangement = arrangementOf(s)) {
  const next = focusPanel(s.panels, id);
  const dockLayout = activate(placeAll(laidOut(s), next.panels, s.activePanel, into, widthOf(s)), id);
  return { panels: panelsFor(s, dockLayout), activePanel: next.activePanel, dockLayout, ...recall(s, id) };
}

export const useStore = create<CanopyState>((set, get) => ({
  root: "",
  sources: [],
  repos: [],
  conns: {},
  home: homeName(),
  backendOrder: [homeName()],
  devices: [],
  peerSeen: [],
  peerSync: "off",
  shells: [],
  pendingTermLabels: {},
  kept: [],
  chan: null,
  chanAs: "",
  chanMsgs: {},
  chanUnread: 0,
  chanOpen: false,
  chanInTab: false,
  chanConv: null,
  registry: {},
  registryReady: false,
  registryTrail: {},
  shellAgents: {},
  asks: {},
  asksReady: false,
  answerKey: readAnswerKey(),
  reviewNotes: loadNotes(),
  presence: null,
  sprouts: {},
  sproutsReady: false,
  stages: {},
  rangers: {},
  awake: {},
  sweep: null,
  sweepEnded: [],
  health: {},
  capacity: {},
  kit: {},
  landing: {},
  prs: {},
  triggers: {},
  authByBackend: {},
  signIns: {},
  secrets: {},
  advice: [],
  harnessSaid: readHarnessSaid(),
  chatDrafts: {},
  adviceFile: null,
  inboxOpen: false,
  inboxFocus: null,
  workspaces: [],
  screenProfiles: [],
  loaded: false,
  loadError: null,
  filter: "",
  dirtyOnly: false,
  favoritesOnly: false,
  filters: [],
  users: [],
  activeWs: null,
  panels: layout.panels,
  dockLayout: layout.dockLayout,
  activePanel: layout.activePanel,
  popped: layout.popped,
  recalled: [],
  updatedAt: {},
  sidebarWidth: layout.sidebarWidth,
  panelWidths: layout.panelWidths,
  soloWidth: layout.soloWidth,
  dockWidth: layout.dockWidth,
  sidebarOpen: layout.sidebarOpen,
  drawerOpen: false,
  cliOpen: false,
  cliLog: [],
  aboutAtLoad: null,
  collapsed: layout.collapsed,
  closedSections: layout.closedSections,
  settings: loadSettings(),
  runs: {},
  sheet: null,
  searchQuery: "",
  pendingSearch: null,
  reveal: null,
  history: null,
  histories: {},
  agents: {},
  launchers: {},
  remembered: {},
  jobs: {},
  tasks: {},
  taskErrors: {},
  taskAll: [],
  buildsAt: {},
  terms: [],
  parkedTerms: [],
  stripPage: null,
  checkoutPref: layout.checkoutPref,
  activeTerm: null,
  hiddenTerms: layout.hiddenTerms,
  termHeight: layout.termHeight,
  panelTermHeights: layout.panelTermHeights,
  focusSize: layout.focusSize,
  front: null,
  flows: {},
  fleets: {},
  workflows: {},
  flowRuns: {},
  selecting: false,
  selected: [],
  selectAnchor: null,
  verdictReady: false,
  feed: [],
  feedSeq: 1,
  feedOpen: layout.feedOpen,
  feedHeight: layout.feedHeight,
  feedSource: null,
  feedQuiet: false,

  toggleFeed: () => set((s) => ({ feedOpen: !s.feedOpen })),
  clearFeed: () => set({ feed: [] }),
  setFeedHeight: (px) => set({ feedHeight: clamp(px, FEED.min, FEED.max) }),
  setFeedSource: (feedSource) => set({ feedSource }),
  setFeedQuiet: (feedQuiet) => set({ feedQuiet }),

  init: async () => {
    // Which backends there are comes first: every id and URL hangs off it.
    // A server from before there were several has no list, and is home alone.
    const reply = await api.backends().catch(() => null);
    const home = reply?.self ?? "home";
    const entries = reply?.backends ?? [];
    registryEntries = entries;
    const before = get().settings;
    const order = applyRegistry(home, entries, before.hiddenBackends.filter((n) => n !== home), reply ? [] : before.backends);
    const settings =
      reply && JSON.stringify(reply.backends) !== JSON.stringify(before.backends) ? { ...before, backends: reply.backends } : before;
    if (settings !== before) saveSettings(settings);
    set({ home, backendOrder: order, settings, conns: Object.fromEntries(order.map((n) => [n, newConn(n)])) });
    // What every request and stream sees of its backend becomes that
    // backend's state; the same status object when nothing changed.
    onBackendSignal((name, sig) => {
      const c = get().conns[name];
      if (!c) return;
      const status = backendState(c.status, sig);
      if (status !== c.status) set((s) => ({ conns: withConn(s, name, { status }) }));
      if (sig.kind === "refused") refusedHere(set, name, sig.status === 401 ? sig.token : null);
    });
    const e = ++epoch;
    try {
      const [tree, workspaces, runs, agents, flows, fleets, verdict, launchers, jobs, held, client, helpers, devices, kept] = await Promise.all([
        api.tree(),
        api.workspaces(),
        api.runs(),
        api.agents(),
        api.flows(),
        api.fleets(),
        api.verdict(),
        api.launchers(),
        api.jobs(),
        // a server from before shells were held has no list; the grove
        // should still load, just with no shells to come back to
        api.terms().catch((): TermInfo[] => []),
        api.client(),
        api.helpers(),
        api.devices().catch((): Device[] => []),
        // a backend from before shells were kept has no list
        api.kept().catch(() => ({ keeping: false, kept: [] as KeptShell[] })),
      ]);
      // The shells come back only now, against what the server still holds:
      // a tab shown sooner would open its socket and start a shell of its
      // own under the old name. A solo or shell window keeps none of the
      // saved tabs: what it saved is the grove's, and the grove is what
      // shows them. A pop-out (popped=1) takes up its own panel's held
      // shells instead, so they travel with it (adoptHere). Only home's
      // saved tabs are judged here; another backend's wait, parked (and
      // still saved), until that backend answers.
      const saved = loadLayout();
      loadedTabs = { terms: saved.terms, activeTerm: saved.activeTerm };
      const mine = mineOf(home);
      const s = get();
      const hiddenTerms = pruneHiddenOf(s.hiddenTerms, home, held);
      const terms = dockless()
        ? adoptHere([], held, tree.repos, s.panels, skipped(hiddenTerms))
        : reconcileTerms(saved.terms.filter((t) => mine(t.id)), held, tree.repos, s.panels, new Set(hiddenTerms));
      const parkedTerms = dockless() ? [] : saved.terms.filter((t) => !mine(t.id));
      const strip = terms.filter((t) => t.place === "strip");
      // A panel shell whose panel is not open here waits for the panel to
      // open (reconcileTerms already leaves an untabbed one out); only a
      // saved tab can still name a panel that is not yet in `panels` (an
      // older layout, or one saved between the two fields), so the
      // opening-and-unfolding here is scoped to saved tabs alone. It must
      // not run for a shell reconcileTerms adopted, or every closed panel
      // with a shell in it would reopen on the very load meant to keep it
      // closed. A dockless window opens nothing: its folds are the grove's.
      const opened = openSavedPanels(s.panels, s.closedSections, s.popped, dockless() ? [] : terms);
      const { closedSections, popped } = opened;
      const activePanel = s.activePanel ?? opened.panels[0] ?? null;
      const dockLayout = placeAll(laidOut(s), opened.panels, activePanel, arrangementOf(s), widthOf(s));
      const panels = panelsOf(dockLayout);
      const reg = registry();
      set({
        root: tree.root,
        sources: sliceIn(reg, s.sources, home, tree.sources, (x) => x.id),
        repos: sliceIn(reg, s.repos, home, tree.repos, (r) => r.id),
        conns: withConn(s, home, {
          backend: tree.backend,
          client,
          helpers,
          keeping: kept.keeping,
          status: { state: "online" },
        }),
        devices: sliceIn(reg, s.devices, home, devices, (d) => d.id),
        shells: sliceIn(reg, s.shells, home, held, (t) => t.id),
        hiddenTerms,
        kept: sliceIn(reg, s.kept, home, kept.kept, (k) => k.id),
        workspaces,
        ...recordsState(s, home, { runs, flows, fleets, jobs }),
        agents: { ...s.agents, [home]: agents },
        launchers: { ...s.launchers, [home]: launchers },
        verdictReady: verdict.ready,
        terms,
        parkedTerms,
        activeTerm: strip.some((t) => t.id === saved.activeTerm) ? saved.activeTerm : (strip.at(-1)?.id ?? null),
        panels,
        dockLayout,
        popped,
        activePanel,
        closedSections,
        loaded: true,
        loadError: null,
      });
    } catch (err) {
      // Without this the app sits on the loading screen forever with no
      // message and no way back.
      set({ loadError: String(err instanceof Error ? err.message : err) });
      return () => {};
    }
    // The archive is not in the way of first paint: it lands when it lands,
    // and claude-history only syncs hourly, so a slow refresh is plenty.
    void get().loadHistory();
    readTasks(get, set, home);
    // Likewise peers: a backend with peer sync off just answers "off" and
    // an empty seen list, so this never blocks a grove with none set up.
    readPeers(get, set, home);
    // tailchan too: a backend without a broker answers ready: false
    void get().loadChan();
    // and the agent registry, which a backend without a broker refuses
    void get().loadRegistry();
    // and the asks waiting on the human, the same
    void get().loadAsks();
    void get().loadSprouts();
    void get().loadRanger();
    if (signedIn(home)) void get().loadSweep();
    void get().loadHealth();
    void get().loadCapacity();
    void get().loadKit();
    void get().loadLanding();
    void get().loadPrs();
    void get().loadTriggers();
    void get().loadAuth();
    void get().signIn(get().home, true);
    void get().loadSecrets();
    // the screen layouts, which a backend from before them does not have
    void get().loadScreenProfiles();
    // what home runs: it names the machines, and it is the build a later
    // answer is held against to offer a reload after a redeploy
    void readAbout(get, set, home);
    const refresh = setInterval(() => {
      for (const n of get().backendOrder) if (n === get().home || streams.has(n)) void get().loadHistory(false, n);
    }, HISTORY_REFRESH);
    // Handed back so the caller can close the stream — StrictMode mounts
    // effects twice, and an unclosed EventSource leaks a live connection.
    const unsubscribe = subscribe(
      home,
      (ev) => get().applyEvent(ev, home),
      () => resync(get, set, home),
      identity(get().settings.device),
    );
    // A helper attaching between the first read and the stream opening
    // sent a `helpers` event no one heard; one more read closes that gap.
    void api
      .helpers()
      .then((helpers) => set((s) => ({ conns: connsIf(s, home, { helpers }) })))
      .catch(() => {});
    // Every other backend after home, each on its own: one that is slow or
    // down never holds up the page or the others.
    for (const n of order) if (n !== home) void get().connect(n);
    return () => {
      clearInterval(refresh);
      unsubscribe();
      // a newer init has put its own hook in; leave that one
      if (epoch === e) onBackendSignal(() => {});
      dead.add(e);
      for (const [n, r] of retries) if (r.epoch === e) stopRetry(n, true);
      for (const [n, st] of streams) {
        if (st.epoch !== e) continue;
        st.off();
        streams.delete(n);
      }
    };
  },

  connect: async (name) => {
    if (name === get().home) return;
    const entry = registryEntries.find((x) => x.name === name);
    if (!entry) return;
    const e = epoch;
    const attempt = (connecting.get(name) ?? 0) + 1;
    connecting.set(name, attempt);
    // this try replaces any that was waiting; the count of failures stays
    stopRetry(name, false);
    // A backend that did not answer is tried again by itself, at doubling
    // waits up to a minute, for as long as it is shown: a machine asleep
    // when the page loaded comes in when it wakes, with no tap on retry. A
    // stream that drops later is the stream's own backoff, not this.
    const again = () => {
      const tries = retries.get(name)?.tries ?? 0;
      const timer = setTimeout(() => {
        const r = retries.get(name);
        if (r) r.timer = null;
        if (dead.has(e) || !get().backendOrder.includes(name)) return;
        void get().connect(name);
      }, retryWait(tries, retryFirst));
      retries.set(name, { timer, tries: tries + 1, epoch: e });
    };
    // an attempt the page has moved past (a retry, a hide, its cleanup)
    // lands nothing and opens no stream
    const live = () => !dead.has(e) && connecting.get(name) === attempt && get().backendOrder.includes(name);
    const base = await resolveBase(entry, pageOrigin(), registryEntries);
    if (!live()) return;
    if (base === null) {
      set((s) => ({ conns: withConn(s, name, { status: { state: "offline", reason: "no URL this page can use" } }) }));
      again();
      return;
    }
    setBase(name, base);
    set((s) => ({ conns: withConn(s, name, { base }) }));
    let got;
    try {
      got = await Promise.all([
        api.tree(name),
        api.runs(name),
        api.flows(name),
        api.fleets(name),
        api.jobs(name),
        api.agents(name),
        api.launchers(name),
        api.terms(name).catch((): TermInfo[] => []),
        api.kept(name).catch(() => ({ keeping: false, kept: [] as KeptShell[] })),
        api.client(name),
        api.helpers(name),
        api.devices(name).catch((): Device[] => []),
      ]);
    } catch (err) {
      // the signal hook has said offline or sign-in already; an answer that
      // was an error still leaves the backend unloaded, which says so too
      const reason = String(err instanceof Error ? err.message : err);
      if (!live()) return;
      set((s) => ({ conns: withConn(s, name, { status: backendState(connOf(s, name).status, { kind: "unreachable", reason }) }) }));
      again();
      return;
    }
    if (!live()) return;
    stopRetry(name, true);
    const [tree, runs, flows, fleets, jobs, agents, launchers, held, kept, client, helpers, devices] = got;
    set((s) => {
      const reg = registry();
      const t = treeState(s, tree, name);
      const mine = mineOf(name);
      const hiddenTerms = pruneHiddenOf(s.hiddenTerms, name, held);
      // this backend's parked tabs come back against what it holds, the
      // way home's did at load
      const back = dockless()
        ? adoptHere([], held, tree.repos, t.panels, skipped(hiddenTerms)).filter((x) => !s.terms.some((have) => have.id === x.id))
        : reconcileTerms(s.parkedTerms.filter((x) => mine(x.id)), held, tree.repos, t.panels, new Set(hiddenTerms)).filter(
            (x) => !s.terms.some((have) => have.id === x.id),
          );
      const opened = openSavedPanels(t.panels, t.closedSections, t.popped, dockless() ? [] : back);
      const { closedSections, popped } = opened;
      const activePanel = t.activePanel ?? opened.panels[0] ?? null;
      const dockLayout = placeAll(laidOut({ ...t, settings: s.settings }), opened.panels, activePanel, arrangementOf(s), widthOf(t));
      const panels = panelsOf(dockLayout);
      const strip = back.filter((x) => x.place === "strip");
      const want = loadedTabs.activeTerm;
      return {
        ...t,
        conns: withConn(t, name, { client, helpers, keeping: kept.keeping }),
        shells: sliceIn(reg, s.shells, name, held, (x) => x.id),
        hiddenTerms,
        kept: sliceIn(reg, s.kept, name, kept.kept, (k) => k.id),
        devices: sliceIn(reg, s.devices, name, devices, (d) => d.id),
        ...recordsState(s, name, { runs, flows, fleets, jobs }),
        agents: { ...s.agents, [name]: agents },
        launchers: { ...s.launchers, [name]: launchers },
        terms: back.length ? [...s.terms, ...back] : s.terms,
        parkedTerms: s.parkedTerms.some((x) => mine(x.id)) ? s.parkedTerms.filter((x) => !mine(x.id)) : s.parkedTerms,
        activeTerm: want !== null && strip.some((x) => x.id === want) ? want : (s.activeTerm ?? strip.at(-1)?.id ?? null),
        panels,
        dockLayout,
        popped,
        activePanel,
        closedSections,
      };
    });
    streams.get(name)?.off();
    const off = subscribe(
      name,
      (ev) => get().applyEvent(ev, name),
      () => resync(get, set, name),
      identity(get().settings.device),
    );
    streams.set(name, { epoch: e, off });
    void get().loadHistory(false, name);
    readTasks(get, set, name);
    readPeers(get, set, name);
    void get().loadSprouts(name);
    void get().loadRanger(name);
    void get().loadHealth(name);
    void get().loadCapacity(name);
    void get().loadKit(name);
    void get().loadLanding(name);
    void get().loadPrs(name);
    void get().loadTriggers(name);
    void get().loadAuth(name);
    void get().signIn(name, true);
    void get().loadSecrets(name);
    void api
      .about(name)
      .then((about) => set((s) => ({ conns: connsIf(s, name, { about }) })))
      .catch(() => {});
    void api
      .helpers(name)
      .then((helpers) => set((s) => ({ conns: connsIf(s, name, { helpers }) })))
      .catch(() => {});
  },

  retryBackend: async (name) => {
    const s = get();
    if (name === s.home || !s.backendOrder.includes(name)) return;
    set((now) => ({ conns: withConn(now, name, { status: backendState(connOf(now, name).status, { kind: "retry" }) }) }));
    await get().connect(name);
  },

  hideBackend: (name, hidden) => {
    const s = get();
    if (name === s.home || !registryEntries.some((e) => e.name === name)) return;
    const was = s.settings.hiddenBackends;
    const hiddenBackends = hidden ? (was.includes(name) ? was : [...was, name]) : was.filter((n) => n !== name);
    const settings = hiddenBackends === was ? s.settings : { ...s.settings, hiddenBackends };
    if (settings !== s.settings) saveSettings(settings);
    if (!hidden) {
      if (s.backendOrder.includes(name)) return;
      const backendOrder = applyRegistry(s.home, registryEntries, hiddenBackends);
      set({ settings, backendOrder, conns: { ...s.conns, [name]: newConn(name) } });
      void get().connect(name);
      return;
    }
    streams.get(name)?.off();
    streams.delete(name);
    stopRetry(name, true);
    sproutLoads.set(name, (sproutLoads.get(name) ?? 0) + 1);
    // a load still on its way for it lands nothing
    connecting.set(name, (connecting.get(name) ?? 0) + 1);
    capacityEvents.set(name, (capacityEvents.get(name) ?? 0) + 1);
    const mine = mineOf(name);
    const not = <T>(idOf: (t: T) => string) => (t: T) => !mine(idOf(t));
    const terms = s.terms.filter(not((t: TermTab) => t.id));
    const gone = s.terms.filter((t) => mine(t.id));
    const flows = recordOut(s.flows, name);
    const { [name]: _conn, ...conns } = s.conns;
    const { [name]: _agents, ...agents } = s.agents;
    const { [name]: _launchers, ...launchers } = s.launchers;
    const { [name]: _remembered, ...remembered } = s.remembered;
    const { [name]: _history, ...histories } = s.histories;
    const { [name]: _stages, ...stages } = s.stages;
    const { [name]: _ranger, ...rangers } = s.rangers;
    const { [name]: _awake, ...awake } = s.awake;
    const { [name]: _health, ...health } = s.health;
    const { [name]: _capacity, ...capacity } = s.capacity;
    const { [name]: _kit, ...kit } = s.kit;
    const { [name]: _landing, ...landing } = s.landing;
    const { [name]: _prs, ...prs } = s.prs;
    const { [name]: _triggers, ...triggers } = s.triggers;
    const { [name]: _auth, ...authByBackend } = s.authByBackend;
    const { [name]: _signIn, ...signIns } = s.signIns;
    signingIn.delete(name);
    const { [name]: _secrets, ...secrets } = s.secrets;
    const backendOrder = applyRegistry(s.home, registryEntries, hiddenBackends);
    set({
      settings,
      backendOrder,
      conns,
      repos: s.repos.filter(not((r: Repo) => r.id)),
      sources: s.sources.filter(not((x: SourceState) => x.id)),
      shells: s.shells.filter(not((t: TermInfo) => t.id)),
      kept: s.kept.filter(not((k: KeptShell) => k.id)),
      devices: s.devices.filter(not((d: Device) => d.id)),
      runs: recordOut(s.runs, name),
      flows,
      flowRuns: flowRunsOf(Object.values(flows)),
      fleets: recordOut(s.fleets, name),
      jobs: recordOut(s.jobs, name),
      tasks: recordOut(s.tasks, name),
      taskErrors: recordOut(s.taskErrors, name),
      taskAll: s.taskAll.filter((t) => backendOf(t.repoId) !== name),
      sprouts: recordOut(s.sprouts, name),
      stages,
      rangers,
      awake,
      health,
      capacity,
      kit,
      landing,
      prs,
      triggers,
      authByBackend,
      signIns,
      secrets,
      agents,
      launchers,
      remembered,
      histories,
      history: historyOf(histories, backendOrder),
      // its tabs leave this window but not the saved layout
      terms,
      parkedTerms: gone.length ? [...s.parkedTerms, ...gone] : s.parkedTerms,
      activeTerm: s.activeTerm !== null && terms.some((t) => t.id === s.activeTerm) ? s.activeTerm : (terms.filter((t) => t.place === "strip").at(-1)?.id ?? null),
      front: keepFront(s.front, terms, s.panels.filter((p) => !mine(p))),
      selected: s.selected.filter((id) => !mine(id)),
    });
  },

  setCheckoutPref: (key, backend) => set((s) => ({ checkoutPref: { ...s.checkoutPref, [key]: backend } })),
  switchCheckout: (fromId, toId) => {
    if (fromId === toId) return;
    // A solo window is its url's one panel and saves no dock, so the switch
    // is that window going to the sibling's; the card leads with it as it
    // would from the grove.
    if (dockless()) {
      const s = get();
      const card = cardOf(s, fromId);
      if (card) set({ checkoutPref: { ...s.checkoutPref, [card.key]: backendOf(toId) } });
      window.location.assign(soloUrl(toId));
      return;
    }
    set((s) => {
      const card = cardOf(s, fromId);
      // the sibling's panel may be open already; it keeps its place then.
      // Otherwise it takes the old one's place in the layout, cell, tab and
      // column width alike (rename changes nothing when the sibling is open)
      const open = s.panels.includes(toId);
      const flat = open ? s.panels.filter((p) => p !== fromId) : s.panels.map((p) => (p === fromId ? toId : p));
      const activePanel = s.activePanel === fromId ? toId : s.activePanel;
      const l = laidOut(s);
      const dockLayout = placeAll(open ? l : rename(l, fromId, toId), flat, activePanel, arrangementOf(s), widthOf(s));
      const panels = panelsFor(s, dockLayout);
      // the old panel leaving a column of its own leaves its width behind,
      // as a close does
      const lone = open ? loneColumn(l, fromId) : undefined;
      // like a close: the old panel's shell tabs go, the shells stay held
      const kept = s.terms.filter((t) => !(t.repoId === fromId && t.place === "panel"));
      const terms = dockless() ? kept : adoptTerms(kept, s.shells, s.repos, panels, skipped(s.hiddenTerms));
      return {
        panels,
        dockLayout,
        activePanel,
        // the sibling docked here by hand is out in no window any more
        ...recall(s, toId),
        terms,
        front: keepFront(s.front, terms, panels),
        ...(card ? { checkoutPref: { ...s.checkoutPref, [card.key]: backendOf(toId) } } : {}),
        ...(lone && s.panelWidths[fromId] !== lone.width ? { panelWidths: { ...s.panelWidths, [fromId]: lone.width } } : {}),
      };
    });
  },

  loadHistory: async (refresh = false, backend) => {
    const b = backend ?? get().home;
    let h: HistoryOverview;
    try {
      h = await api.history(refresh, b);
    } catch (err) {
      h = {
        available: false,
        reason: String(err instanceof Error ? err.message : err),
        fetchedAt: Date.now(),
      };
    }
    set((s) => {
      // a backend hidden while this was on its way has no place for it
      if (!isShown(s, b)) return {};
      const histories = { ...s.histories, [b]: h };
      return { histories, history: historyOf(histories, s.backendOrder) };
    });
  },

  rescan: async (backend) => {
    const b = backend ?? get().home;
    const [tree, runs, flows, fleets, jobs] = await Promise.all([
      api.rescan(b),
      api.runs(b),
      api.flows(b),
      api.fleets(b),
      api.jobs(b),
    ]);
    // a rescan can bring new repos; the server rebuilds the repo→project map
    void get().loadHistory(true, b);
    // Through applyEvent so the feed sees the scan even when this window
    // asked for it: the broadcast that follows finds nothing new to say.
    if (!isShown(get(), b)) return;
    get().applyEvent({ type: "scan", result: tree }, b);
    // runs are server state too: a stream gap may have hidden a finish
    set((s) => recordsState(s, b, { runs, flows, fleets, jobs }));
  },

  addSource: async (input, backend) => {
    const b = backend ?? get().home;
    const tree = await api.addSource(input, b);
    void get().loadHistory(true, b);
    get().applyEvent({ type: "scan", result: tree }, b);
  },
  removeSource: async (id) => {
    const tree = await api.removeSource(id);
    void get().loadHistory(true, backendOf(id));
    get().applyEvent({ type: "scan", result: tree }, backendOf(id));
  },
  rescanSource: async (id) => {
    const tree = await api.rescanSource(id);
    void get().loadHistory(true, backendOf(id));
    get().applyEvent({ type: "scan", result: tree }, backendOf(id));
  },

  setFilter: (filter) => set({ filter }),
  setDirtyOnly: (dirtyOnly) => set({ dirtyOnly }),
  setFavoritesOnly: (favoritesOnly) => set({ favoritesOnly }),
  toggleFilter: (f) =>
    set((s) => ({
      filters: s.filters.includes(f)
        ? s.filters.filter((x) => x !== f)
        : [...s.filters, f],
    })),
  toggleUser: (key) =>
    set((s) => ({
      users: s.users.includes(key)
        ? s.users.filter((x) => x !== key)
        : [...s.users, key],
    })),
  clearFilters: () => set({ filters: [], users: [], favoritesOnly: false }),
  setActiveWs: (activeWs) => set({ activeWs }),

  loadScreenProfiles: async () => {
    try {
      const { profiles } = await api.layouts();
      set({ screenProfiles: profiles });
    } catch {
      // a backend from before layouts: Settings offers none
    }
  },
  saveScreenProfile: async (what) => {
    const r =
      "from" in what
        ? await api.layoutCreate({ from: what.from })
        : what.id === null
          ? await api.layoutCreate({ profile: what.fields })
          : await api.layoutUpdate(what.id, what.fields);
    set({ screenProfiles: r.profiles });
    return r.profile;
  },
  dropScreenProfile: async (id) => {
    const r = isPresetId(id) ? await api.layoutReset(id) : await api.layoutDelete(id);
    set({ screenProfiles: r.profiles });
  },
  applyScreenLayout: (layout, withTabs = false) => {
    const st = get();
    if (withTabs && layout.tabs) {
      const got = applyTabs(layout.tabs, st.settings, tabCards(st));
      st.setSetting("sectionTabs", got.sectionTabs);
      st.setSetting("itemTabs", got.itemTabs);
      st.setSetting("panelSplits", got.panelSplits);
    }
    // through the setters the gears use, each kept for this screen
    if (layout.arrange) st.arrangeDock(layout.arrange);
    if (layout.carousel !== undefined) st.setSetting("dockCarousel", layout.carousel);
    if (layout.level) st.setSetting("level", layout.level);
    if (layout.panelZoom !== undefined) st.setSetting("zoom", withZoom(get().settings.zoom, "panel", clamp(layout.panelZoom, ZOOM_MIN, ZOOM_MAX)));
    if (layout.termFont !== undefined) st.setSetting("termFont", termFontSize(layout.termFont, TERM_FONT.size));
    if (layout.sectionsHidden) st.setSetting("sectionsHidden", sectionsHidden(layout.sectionsHidden));
    if (layout.agents) st.setSetting("agentsLayout", layout.agents);
    set((s) => {
      const l = laidOut(s);
      const w = layout.columnWidth === undefined ? undefined : clamp(layout.columnWidth, PANEL.min, PANEL.max);
      return {
        dockLayout: { columns: l.columns.map((c) => (w === undefined ? c : { ...c, width: w })) },
        ...(layout.sidebarOpen !== undefined ? { sidebarOpen: layout.sidebarOpen } : {}),
        ...(layout.sidebarWidth !== undefined ? { sidebarWidth: clamp(layout.sidebarWidth, SIDEBAR.min, SIDEBAR.max) } : {}),
        ...(layout.feedOpen !== undefined ? { feedOpen: layout.feedOpen } : {}),
      };
    });
    // The layout subscription saves only what changed, so a value the
    // profile names that already held would not reach this screen's slot,
    // and a change made on another screen would show through here later.
    const s = get();
    const named: Partial<Layout> = {
      ...(layout.sidebarOpen !== undefined ? { sidebarOpen: s.sidebarOpen } : {}),
      ...(layout.sidebarWidth !== undefined ? { sidebarWidth: s.sidebarWidth } : {}),
      ...(layout.feedOpen !== undefined ? { feedOpen: s.feedOpen } : {}),
    };
    if (Object.keys(named).length > 0) saveLayout(named);
  },

  loadTasks: async (repoId) => {
    const r = await api.tasks(repoId);
    set((s) => ({ tasks: { ...s.tasks, [repoId]: r.tasks }, taskErrors: { ...s.taskErrors, [repoId]: r.errors } }));
  },
  taskAct: async (repoId, action, name) => {
    const r = await api.taskAct(repoId, action, name);
    // Starting the dev task from any button shows what it serves: the
    // preview unfolds and comes into view, as "Run my app" does.
    const repo = get().repos.find((x) => x.id === repoId);
    const show = startsDev(action, name, r.tasks) && repo !== undefined && !repo.host && !repo.forge;
    set((s) => ({
      tasks: { ...s.tasks, [repoId]: r.tasks },
      ...(show ? { closedSections: unfoldIn(s.closedSections, repoId, "preview"), reveal: { repoId, key: "preview", at: Date.now() } } : {}),
    }));
  },
  saveTaskDef: async (repoId, name, def, target) => {
    const r = await api.taskDef(repoId, name, def, target);
    set((s) => ({ tasks: { ...s.tasks, [repoId]: r.tasks }, taskErrors: { ...s.taskErrors, [repoId]: r.errors } }));
  },
  startPanelTasks: (repoId) => {
    const repo = get().repos.find((r) => r.id === repoId);
    if (!repo || repo.forge) return;
    // nothing flagged is the common case, and the answer is the list anyway
    api
      .taskAct(repoId, "start", undefined, "panel")
      .then((r) => set((s) => ({ tasks: { ...s.tasks, [repoId]: r.tasks } })))
      .catch(() => {});
  },
  openPanel: (id, into) =>
    set((s) => {
      const next = dockPanel(s, id, into);
      // a panel shell another device opened here waits for its panel
      return { ...next, terms: dockless() ? s.terms : adoptTerms(s.terms, s.shells, s.repos, next.panels, skipped(s.hiddenTerms)) };
    }),
  showPanel: (id) =>
    set((s) => (s.panels.includes(id) ? { activePanel: id, dockLayout: activate(laidOut(s), id) } : {})),
  openRepo: (id, mods) => {
    // a repo picked from the drawer is where the eye goes next
    if (get().drawerOpen) set({ drawerOpen: false });
    // A forge repo has no panel worth opening: there is no working tree, no
    // log to read here, nothing to run. Its page is the whole of it.
    const repo = get().repos.find((r) => r.id === id);
    if (repo?.forge) {
      window.open(repo.path, "_blank", "noopener,noreferrer");
      return;
    }
    const target = mods?.shiftKey
      ? "window"
      : mods?.metaKey || mods?.ctrlKey
        ? "tab"
        : get().settings.openIn;
    if (target === "dock" || target === "tabs") get().openPanel(id);
    else openElsewhere(id, target);
  },
  openApp: async (id, app) => {
    await api.open(id, app, get().settings.terminal === "tab", helperFor(get(), backendOf(id)));
  },
  closePanel: (id) => {
    const s = get();
    // A panel's shells outlive it: closing only drops the tabs, and the
    // shells stay held on the backend, in the shells picker, until their
    // own × or "end". Reopening the panel adopts them back as tabs. A
    // closed panel keeps no popped slot either, so no window's bye brings
    // it back.
    const mine = (t: TermTab) => t.repoId === id && t.place === "panel";
    const terms = s.terms.filter((t) => !mine(t));
    const l = laidOut(s);
    // a column of its own leaves its width behind for the panel's next
    // column, a reopen or a pop-out coming back
    const lone = loneColumn(l, id);
    const own = cellOf(l, id);
    // the closed panel's own cell picks its next tab as it leaves (remove)
    const closed = placeAll(l, s.panels.filter((p) => p !== id), null, arrangementOf(s), widthOf(s));
    // The showing panel moves to its neighbour, as in a flat dock. One in
    // the closed panel's cell shows; one in another cell is not brought
    // forward over that cell's own tab, whose tab shows instead.
    const next = nextActive(s.panels, id, s.activePanel);
    let dockLayout = closed;
    let activePanel = next;
    if (next !== null && next !== s.activePanel) {
      if (own?.panels.includes(next)) dockLayout = activate(closed, next);
      else activePanel = cellOf(closed, next)?.active ?? next;
    }
    const panels = panelsFor(s, dockLayout);
    set({
      panels,
      dockLayout,
      ...recall(s, id),
      activePanel,
      terms,
      front: keepFront(s.front, terms, panels),
      ...(lone && s.panelWidths[id] !== lone.width ? { panelWidths: { ...s.panelWidths, [id]: lone.width } } : {}),
    });
  },
  movePanel: (id, to) =>
    set((s) => {
      // `to` is an index into the flat list (the gear's and the keys' left
      // and right), which laidOut makes the layout's own order; stepPanel
      // is also the gear's dry run
      const dockLayout = stepPanel(laidOut(s), id, to);
      return dockLayout === null ? s : { dockLayout, panels: panelsFor(s, dockLayout) };
    }),
  dropPanel: (id, cell, zone) =>
    set((s) => {
      const l = laidOut(s);
      // a column of its own dropped beside another keeps its width
      const width = loneColumn(l, id)?.width ?? widthOf(s)(id);
      const dockLayout = moveTo(l, id, { cell, zone }, width);
      return dockLayout === l ? s : { dockLayout, panels: panelsFor(s, dockLayout), activePanel: id };
    }),
  dropTab: (id, cell, index) =>
    set((s) => {
      const l = laidOut(s);
      const dockLayout = moveWithin(l, id, cell, index);
      return dockLayout === l ? s : { dockLayout, panels: panelsFor(s, dockLayout), activePanel: id };
    }),
  resizeColumn: (column, px) =>
    set((s) => {
      const l = laidOut(s);
      const dockLayout = sizeColumn(l, column, px, PANEL.min, PANEL.max);
      return dockLayout === l ? s : { dockLayout };
    }),
  resizeColumns: (widths) =>
    set((s) => {
      const l = laidOut(s);
      const dockLayout = sizeColumns(l, widths, PANEL.min, PANEL.max);
      return dockLayout === l ? s : { dockLayout };
    }),
  resizeSeam: (column, index, at) =>
    set((s) => {
      const l = laidOut(s);
      const dockLayout = moveSeam(l, column, index, at);
      return dockLayout === l ? s : { dockLayout };
    }),
  arrangeDock: (into) => {
    // Only a change of arrangement regroups. The dock, a tab and a window
    // all arrange the dock in columns, so picking the dock from either of
    // the other two, or the entry already lit, keeps every split and tab.
    const openIn = into === "tabs" ? "tabs" : "dock";
    const from = arrangementOf(get());
    if (get().settings.openIn !== openIn) get().setSetting("openIn", openIn);
    if (from === into) return;
    set((s) => {
      const l = laidOut(s);
      // Widths go by panel, not by place (regroup's own reuse is by
      // position): each column's width belongs to the panel leading it,
      // and a panel leading a column again takes it back. As tabs they wait
      // in panelWidths, as a closed column's do.
      const leads = leadWidths(l);
      const widths = { ...s.panelWidths, ...leads };
      if (into === "tabs") {
        // the one column takes the width of the one that was showing
        const grouped = regroup(l, "tabs", columnOf(l, s.activePanel ?? "")?.width ?? l.columns[0]?.width ?? PANEL.initial);
        const dockLayout = s.activePanel !== null ? activate(grouped, s.activePanel) : grouped;
        const keep = Object.entries(leads).every(([id, w]) => s.panelWidths[id] === w);
        return { dockLayout, panels: panelsFor(s, dockLayout), ...(keep ? {} : { panelWidths: widths }) };
      }
      const grouped = regroup(l, "columns", PANEL.initial);
      const dockLayout = {
        columns: grouped.columns.map((c) => {
          const lead = c.cells[0]?.panels[0];
          return lead === undefined ? c : { ...c, width: widths[lead] ?? PANEL.initial };
        }),
      };
      return { dockLayout, panels: panelsFor(s, dockLayout) };
    });
  },
  popOut: (id) => {
    // the window first: a blocked popup leaves the panel where it was.
    // A chat's panel has a window of its own (RunSolo, FR-047); any other
    // reserved panel is no repo's and has none
    if (!get().panels.includes(id)) return;
    const runId = runOfPanel(id);
    const win = runId !== null ? popOutRun(runId) : isReservedPanel(id) ? null : popOutWindow(id);
    if (!win) return;
    get().claimPanel(id);
    // a window closed before it loads never says hello: then it comes back
    poppedOut(id);
  },
  returnPanel: (id) =>
    set((s) => {
      const slot = s.popped[id];
      if (slot === undefined) return {};
      // a home repo gone from the scan has no panel to show; its slot stays
      // for the next tree to prune. Before the first tree, no repos says
      // nothing yet. A chat's panel is no repo's and always comes back.
      if (s.loaded && !isReservedPanel(id) && ownerOf(id) === registry().home && !s.repos.some((r) => r.id === id)) return {};
      // The slot is a hint: the panel lands beside the one that sat after
      // it, a column to its left side by side or a tab before it in its
      // cell. A split it was part of is not put back. Past the end, or
      // with no slot left in this window's layout, it goes last.
      const into = arrangementOf(s);
      const rest = s.panels.filter((p) => p !== id);
      const neighbour = s.panels.includes(id) ? undefined : rest[slot];
      let l = placeAll(laidOut(s), [...rest, id], s.activePanel, into, widthOf(s));
      const by = neighbour === undefined ? undefined : cellOf(l, neighbour);
      if (neighbour !== undefined && by) {
        l = into === "tabs" ? moveWithin(l, id, by.id, by.panels.indexOf(neighbour)) : moveTo(l, id, { cell: by.id, zone: "left" }, widthOf(s)(id));
      }
      const dockLayout = activate(l, id);
      const panels = panelsFor(s, dockLayout);
      // its held shells come back as tabs, the way openPanel adopts them
      const terms = dockless() ? s.terms : adoptTerms(s.terms, s.shells, s.repos, panels, skipped(s.hiddenTerms));
      return { popped: without(s.popped, id), panels, dockLayout, activePanel: id, terms };
    }),
  claimPanel: (id) => {
    const s = get();
    const slot = s.panels.indexOf(id);
    if (slot === -1) return;
    // closePanel drops only the panel's shell tabs, so its shells run on
    // and its folds stay. The slot is set after it, since closing forgets
    // a slot, and the panel is out again, so a later hello is its own.
    get().closePanel(id);
    set((now) => ({ popped: { ...now.popped, [id]: slot }, recalled: now.recalled.filter((r) => r !== id) }));
  },
  heardHello: (id) => {
    if (!get().recalled.includes(id)) get().claimPanel(id);
  },
  forgetPopped: (id) => set((s) => ({ popped: without(s.popped, id) })),

  applyEvent: (sent, from) => {
    // an older backend's agents event is its plain map of settings by path
    const ev: ServerEvent = sent.type === "agents" ? { type: "agents", agents: normalizeRoutes(sent.agents) } : sent;
    const before = get();
    const b = from ?? before.home;
    // a backend hidden since this was sent is not on the page any more
    if (!isShown(before, b)) return;
    beat();
    // workspaces, tailchan, the agent registry, the asks and the retro lessons are the home backend's alone
    if ((ev.type === "chan" || ev.type === "workspaces" || ev.type === "registry" || ev.type === "asks" || ev.type === "advice") && b !== before.home) return;
    // The feed says what changed, so the lines come from the event against
    // the state before it is applied, as the backend that sent it saw it.
    // a message already held (a reconnect's replay, a post heard twice) is
    // neither a feed line nor unread
    if (ev.type === "chan" && before.chanMsgs[ev.message.channel]?.some((m) => m.id === ev.message.id)) return;
    // the sweep is the home backend's alone: another backend's plan names
    // its own shells and runs by ids this page reads as home's
    if (ev.type === "sweep" && b !== before.home) return;
    const lines = describeEvent(ev, feedView(before, b), Date.now(), before.agents[b] ?? NO_ROUTES);
    if (lines.length) {
      set((s) => {
        const { feed, seq } = appendFeed(s.feed, lines, s.feedSeq);
        return { feed, feedSeq: seq };
      });
    }
    if (ev.type === "registry") {
      registryEvents += 1;
      for (const c of ev.cards) registryHeard.set(c.id, registryEvents);
      for (const id of ev.gone ?? []) registryHeard.set(id, registryEvents);
      set((s) => {
        const registry = mergeCards(s.registry, ev.cards, ev.gone);
        if (registry === s.registry) return {};
        return { registry, registryTrail: markTrail(s.registryTrail, s.registry, registry, ev.cards, Date.now(), ev.gone) };
      });
      // the broker is there after all: a first load that failed reads the
      // whole list now rather than showing this card alone
      if (!get().registryReady) void get().loadRegistry();
      return;
    }
    if (ev.type === "asks") {
      asksEvents += 1;
      for (const a of ev.asks) asksHeard.set(a.id, asksEvents);
      for (const id of ev.gone ?? []) asksHeard.set(id, asksEvents);
      set((s) => {
        const asks = mergeAsks(s.asks, ev.asks, ev.gone);
        return { ...(asks === s.asks ? {} : { asks }), ...(ev.presence ? { presence: ev.presence } : {}) };
      });
      return;
    }
    if (ev.type === "stages") {
      stagesEvents.set(b, (stagesEvents.get(b) ?? 0) + 1);
      set((st) => ({ stages: { ...st.stages, [b]: ev.stages } }));
      return;
    }
    if (ev.type === "ranger") {
      rangerEvents.set(b, (rangerEvents.get(b) ?? 0) + 1);
      set((st) => ({ rangers: { ...st.rangers, [b]: ev.ranger } }));
      return;
    }
    if (ev.type === "awake") {
      set((st) => ({ awake: { ...st.awake, [b]: ev.awake } }));
      return;
    }
    if (ev.type === "sweep") {
      // The event says only that the sweep changed, since every stream hears
      // it and the routes need admin, so the page reads it, but only when
      // home last said the read will land (not enforcing, or this page is a
      // caller with admin): a refused read on every event would mark home as
      // wanting a sign-in nothing on the page asked for. A read sent wins
      // over an older event's and over loadSweep's; an event that sends none
      // leaves those to land.
      if (!readsAdmin(before.authByBackend[b])) return;
      const mark = ++sweepEvents;
      void api.sweep().then(
        (sweep) => {
          if (sweepEvents === mark) takeSweep(get, set, sweep);
        },
        () => {},
      );
      return;
    }
    if (ev.type === "kit") {
      kitEvents.set(b, (kitEvents.get(b) ?? 0) + 1);
      set((st) => ({ kit: { ...st.kit, [b]: ev.kit } }));
      return;
    }
    if (ev.type === "landing") {
      landingEvents.set(b, (landingEvents.get(b) ?? 0) + 1);
      set((st) => ({ landing: { ...st.landing, [b]: ev.landing } }));
      return;
    }
    if (ev.type === "triggers") {
      triggersEvents.set(b, (triggersEvents.get(b) ?? 0) + 1);
      set((st) => ({ triggers: { ...st.triggers, [b]: { ...(st.triggers[b] ?? { rules: [], problems: [], keeping: true }), events: ev.events } } }));
    }
    if (ev.type === "prs") {
      prsEvents.set(b, (prsEvents.get(b) ?? 0) + 1);
      set((st) => ({ prs: { ...st.prs, [b]: ev.prs } }));
      return;
    }
    if (ev.type === "auth") {
      authEvents.set(b, (authEvents.get(b) ?? 0) + 1);
      // the event carries the pairs alone: it updates a backend already read
      set((st) => {
        const was = st.authByBackend[b];
        return was ? { authByBackend: { ...st.authByBackend, [b]: { ...was, pending: ev.pending } } } : {};
      });
      return;
    }
    if (ev.type === "secrets") {
      secretsEvents.set(b, (secretsEvents.get(b) ?? 0) + 1);
      // a broadcast carries nobody's session; keep what this page last read
      set((st) => ({ secrets: { ...st.secrets, [b]: { ...ev.info, session: st.secrets[b]?.session ?? false } } }));
      return;
    }
    if (ev.type === "health") {
      healthEvents.set(b, (healthEvents.get(b) ?? 0) + 1);
      set((st) => ({ health: { ...st.health, [b]: ev.checks } }));
      return;
    }
    if (ev.type === "capacity") {
      if (!isShown(get(), b)) return;
      capacityEvents.set(b, (capacityEvents.get(b) ?? 0) + 1);
      set((st) => ({ capacity: { ...st.capacity, [b]: ev.capacity } }));
      return;
    }
    if (ev.type === "advice") {
      adviceEvents += 1;
      set({ advice: ev.advice });
      return;
    }
    if (ev.type === "incubator") {
      sproutEvents += 1;
      sproutHeard.set(ev.sprout.id, sproutEvents);
      set((st) => ({ sprouts: { ...st.sprouts, [ev.sprout.id]: ev.sprout } }));
      return;
    }
    if (ev.type === "incubator-gone") {
      sproutEvents += 1;
      sproutHeard.set(ev.id, sproutEvents);
      set((st) => {
        if (!(ev.id in st.sprouts)) return {};
        const sprouts = { ...st.sprouts };
        delete sprouts[ev.id];
        return { sprouts };
      });
      return;
    }
    if (ev.type === "chan") {
      const m = ev.message;
      set((s) => {
        const looking = (s.chanOpen || s.chanInTab) && s.chanConv === m.channel && document.visibilityState === "visible";
        return {
          chanMsgs: { ...s.chanMsgs, [m.channel]: mergeMessages(s.chanMsgs[m.channel], [m]) },
          chanUnread: !looking && isUnread(m, s.chanAs) ? s.chanUnread + 1 : s.chanUnread,
        };
      });
      return;
    }
    if (ev.type === "repo") {
      set((s) => ({
        repos: s.repos.map((r) => (r.id === ev.repo.id ? ev.repo : r)),
        updatedAt: { ...s.updatedAt, [ev.repo.id]: Date.now() },
      }));
    } else if (ev.type === "scan") {
      set((s) => treeState(s, ev.result, b));
      // a task whose repo left the scan stays, marked by the server
      readTasks(get, set, b);
    } else if (ev.type === "workspaces") {
      set({ workspaces: ev.workspaces });
    } else if (ev.type === "agents") {
      set((s) => ({ agents: { ...s.agents, [b]: ev.agents } }));
    } else if (ev.type === "run") {
      set((s) => ({ runs: { ...s.runs, [ev.run.id]: ev.run } }));
    } else if (ev.type === "run-gone") {
      set((s) => {
        const { [ev.id]: _gone, ...runs } = s.runs;
        const sheet =
          s.sheet?.kind === "run" && s.sheet.runId === ev.id ? null : s.sheet;
        return { runs, sheet };
      });
    } else if (ev.type === "flow") {
      set((s) => {
        const flowRuns = { ...s.flowRuns };
        for (const st of ev.flow.steps) if (st.runId) flowRuns[st.runId] = ev.flow.id;
        return { flows: { ...s.flows, [ev.flow.id]: ev.flow }, flowRuns };
      });
    } else if (ev.type === "flow-gone") {
      set((s) => {
        const { [ev.id]: _gone, ...flows } = s.flows;
        const flowRuns = Object.fromEntries(Object.entries(s.flowRuns).filter(([, f]) => f !== ev.id));
        const sheet = s.sheet?.kind === "flow" && s.sheet.flowId === ev.id ? null : s.sheet;
        return { flows, flowRuns, sheet };
      });
    } else if (ev.type === "fleet") {
      set((s) => ({ fleets: { ...s.fleets, [ev.fleet.id]: ev.fleet } }));
    } else if (ev.type === "fleet-gone") {
      set((s) => {
        const { [ev.id]: _gone, ...fleets } = s.fleets;
        const sheet = s.sheet?.kind === "fleet" && s.sheet.fleetId === ev.id ? null : s.sheet;
        return { fleets, sheet };
      });
    } else if (ev.type === "tasks") {
      set((s) => {
        const others = s.taskAll.filter((t) => t.repoId !== ev.repoId);
        return { tasks: { ...s.tasks, [ev.repoId]: ev.tasks }, taskAll: [...others, ...ev.tasks.filter(listedTask)] };
      });
    } else if (ev.type === "job") {
      set((s) => ({ jobs: { ...s.jobs, [ev.job.id]: ev.job } }));
    } else if (ev.type === "job-gone") {
      set((s) => {
        const { [ev.id]: _gone, ...jobs } = s.jobs;
        return { jobs };
      });
    } else if (ev.type === "builds") {
      set((s) => ({ buildsAt: { ...s.buildsAt, [ev.repoId]: Date.now() } }));
    } else if (ev.type === "launchers") {
      set((s) => ({ launchers: { ...s.launchers, [b]: ev.launchers } }));
    } else if (ev.type === "remembered") {
      set((s) => ({ remembered: { ...s.remembered, [b]: ev.rules } }));
    } else if (ev.type === "helpers") {
      set((s) => ({ conns: withConn(s, b, { helpers: ev.helpers }) }));
    } else if (ev.type === "devices") {
      set((s) => ({ devices: sliceIn(registry(), s.devices, b, ev.devices, (d) => d.id) }));
    } else if (ev.type === "kept") {
      set((s) => ({ kept: sliceIn(registry(), s.kept, b, ev.kept, (k) => k.id) }));
    } else if (ev.type === "peers") {
      if (b === before.home) set({ peerSeen: ev.seen });
      readPeers(get, set, b);
    } else if (ev.type === "terms") {
      // a shell opened on another device shows up here too; a dockless
      // window (solo, shell) keeps no tabs of its own, but a pop-out
      // (popped=1) keeps its own panel's (adoptHere)
      const labelsToSet: Array<{ id: string; label: string; wanted: string | null }> = [];
      set((s) => {
        const shells = sliceIn(registry(), s.shells, b, ev.terms, (t) => t.id);
        const hiddenTerms = pruneHiddenOf(s.hiddenTerms, b, ev.terms);
        const pendingTermLabels = { ...s.pendingTermLabels };
        for (const shell of shells) {
          if (backendOf(shell.id) !== b) continue;
          const pending = pendingTermLabels[shell.id];
          if (!pending) continue;
          const serverLabel = shell.label ?? null;
          if (serverLabel === pending.label || serverLabel !== pending.previous) {
            // Our startup label landed, or another device changed it after
            // the socket label was sent. In either case the server is current.
            delete pendingTermLabels[shell.id];
          } else if (pending.phase === "waiting") {
            pendingTermLabels[shell.id] = { ...pending, phase: "sending" };
            labelsToSet.push({ id: shell.id, label: pending.label ?? "", wanted: pending.label });
          }
        }
        let terms = adoptPlaces(adoptLabels(adoptHere(s.terms, shells, s.repos, s.panels, skipped(hiddenTerms)), shells, (id) => connOf(s, backendOf(id)).backend.labels === true), shells);
        for (const [id, pending] of Object.entries(pendingTermLabels)) terms = renameTab(terms, id, pending.label ?? "");
        return {
          shells,
          hiddenTerms,
          terms,
          pendingTermLabels,
        };
      });
      for (const { id, label, wanted } of labelsToSet) {
        void api.labelTerm(id, label).then(() => {
          set((s) => {
            const pending = s.pendingTermLabels[id];
            if (!pending || pending.phase !== "sending" || pending.label !== wanted) return {};
            const { [id]: _done, ...rest } = s.pendingTermLabels;
            return { pendingTermLabels: rest };
          });
        }).catch(() => {
          set((s) => {
            const pending = s.pendingTermLabels[id];
            if (!pending || pending.phase !== "sending" || pending.label !== wanted) return {};
            return { pendingTermLabels: { ...s.pendingTermLabels, [id]: { ...pending, phase: "waiting" } } };
          });
        });
      }
    }
  },

  setWorkspaces: (workspaces) => set({ workspaces }),

  setSidebarWidth: (px) => set({ sidebarWidth: clamp(px, SIDEBAR.min, SIDEBAR.max) }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setDrawer: (drawerOpen) => set({ drawerOpen }),
  setCliOpen: (cliOpen) => set({ cliOpen }),
  cliPut: (entry) =>
    set((s) => {
      const at = s.cliLog.findIndex((e) => e.id === entry.id);
      if (at !== -1) return { cliLog: s.cliLog.map((e, i) => (i === at ? entry : e)) };
      return { cliLog: [...s.cliLog, entry].slice(-CLI_KEEP) };
    }),
  cliClear: () => set((s) => ({ cliLog: s.cliLog.filter((e) => e.status === "running") })),
  toggleGroup: (key) =>
    set((s) => ({
      collapsed: s.collapsed.includes(key)
        ? s.collapsed.filter((k) => k !== key)
        : [...s.collapsed, key],
    })),
  foldGroups: (keys, fold) =>
    set((s) => {
      const collapsed = foldGroupList(s.collapsed, keys, fold);
      return collapsed === s.collapsed ? {} : { collapsed };
    }),
  toggleSection: (repoId, key) =>
    set((s) => ({ closedSections: toggleIn(s.closedSections, repoId, key) })),
  foldSections: (repoId, fold) =>
    set((s) => {
      // the "waiting on you" panel folds its own groups
      const keys = isWaitingPanel(repoId)
        ? WAITING_GROUPS
        : foldKeys(s.settings.sectionOrder, s.settings.sectionsHidden, (k) => benchHolds(s.front, repoId, k));
      const closedSections = (fold ? foldAllIn : unfoldAllIn)(s.closedSections, repoId, keys);
      return closedSections === s.closedSections ? {} : { closedSections };
    }),
  setSoloWidth: (px) => set({ soloWidth: clamp(px, SOLO.min, SOLO.max) }),
  setSetting: (key, value) =>
    set((s) => {
      const settings = { ...s.settings, [key]: value };
      saveSettings(settings);
      return { settings };
    }),
  openTerm: (repoId, place, start, prompt, pick, label) => {
    const s = get();
    const repo = s.repos.find((r) => r.id === repoId);
    if (!repo || repo.forge) return;
    const where =
      place ??
      shellPlace(s.settings.shell, {
        panelOpen: s.panels.includes(repoId),
        solo: loneWindow(),
      });
    if (where === "tab" || where === "window") {
      openShellElsewhere(repoId, where);
      return;
    }
    const given = label === undefined ? undefined : cleanLabel(label);
    const tab: TermTab = {
      id: qual(backendOf(repoId), termId()),
      repoId,
      name: repo.name,
      path: repo.path,
      place: where,
      ...(given ? { label: given } : {}),
      ...(start ? { start, ...(prompt ? { prompt } : {}), ...pickFields(pick) } : {}),
    };
    // A panel shell shows only inside its repo's panel and only while that
    // section is unfolded, so open both. Otherwise the click does nothing you
    // can see.
    set({
      terms: [...s.terms, tab],
      activeTerm: where === "strip" ? tab.id : s.activeTerm,
      ...(where === "panel"
        ? { ...dockPanel(s, repoId), closedSections: unfoldIn(s.closedSections, repoId, "shell") }
        : {}),
    });
  },
  restoreShell: async (id, resume = false) => {
    const s = get();
    // said rather than skipped, so the row that asked shows why nothing came back
    const rec = s.kept.find((k) => k.id === id);
    if (!rec) throw new Error("that shell is not on offer any more");
    const repo = s.repos.find((r) => r.id === rec.repoId);
    if (!repo) throw new Error(`the repo that shell was in is not in the scan: ${rec.repoId}`);
    await api.restoreShell(id, resume);
    // the same tab the lost shell had, since it comes back under its name;
    // a tab still showing the shell that went (its socket was told the
    // shell exited) is replaced, with a new generation so its view starts
    // over instead of staying ended
    const tab: TermTab = { id, repoId: repo.id, name: repo.name, path: repo.path, place: rec.place, ...(rec.label ? { label: rec.label } : {}) };
    endedShells.delete(id);
    set((now) => ({
      kept: now.kept.filter((k) => k.id !== id),
      terms: now.terms.some((t) => t.id === id)
        ? now.terms.map((t) => (t.id === id ? { ...tab, gen: (t.gen ?? 0) + 1 } : t))
        : [...now.terms, tab],
      activeTerm: rec.place === "strip" ? id : now.activeTerm,
      ...(rec.place === "panel"
        ? { ...dockPanel(now, repo.id), closedSections: unfoldIn(now.closedSections, repo.id, "shell") }
        : {}),
    }));
  },
  forgetShell: async (id) => {
    await api.forgetShell(id);
    set((s) => ({ kept: s.kept.filter((k) => k.id !== id) }));
  },
  setKeeping: async (on, backend) => {
    const b = backend ?? get().home;
    const { keeping } = await api.setKeeping(on, b);
    set((s) => ({ conns: connsIf(s, b, { keeping }) }));
  },
  probeShells: async (ids) => {
    const got = await Promise.all(ids.map((id) => api.termAgent(id).then((r) => [id, r.agent] as const, () => [id, null] as const)));
    const shellAgents = Object.fromEntries(got);
    set((s) => (sameAgents(s.shellAgents, shellAgents) ? {} : { shellAgents }));
  },
  loadRegistry: async () => {
    if (registryRetry) clearTimeout(registryRetry);
    registryRetry = null;
    // events that land while the list is on its way are newer than it
    const mark = registryEvents;
    try {
      const info = await api.registry();
      const cards = Array.isArray(info.cards) ? info.cards : [];
      registryTries = 0;
      set((s) => {
        const registry = replaceCards(s.registry, cards, (id) => (registryHeard.get(id) ?? 0) > mark);
        // a change the list brings is a change seen; a card it no longer names takes its trail along
        const marked = markTrail(s.registryTrail, s.registry, registry, cards, Date.now());
        const registryTrail = Object.fromEntries(Object.entries(marked).filter(([id]) => Object.hasOwn(registry, id)));
        return { registry, registryReady: true, registryTrail };
      });
    } catch (e) {
      set({ registry: {}, registryReady: false, registryTrail: {} });
      // A backend with no broker says so with a 503 and is asked again only
      // when its stream comes back; a broker or a backend that did not
      // answer is asked again at doubling waits, so the view comes back.
      if ((e as { status?: unknown }).status === 503) return;
      registryRetry = setTimeout(() => {
        registryRetry = null;
        void get().loadRegistry();
      }, retryWait(registryTries++, REGISTRY_RETRY_FIRST, REGISTRY_RETRY_MAX));
    }
  },
  loadAsks: async () => {
    // events that land while the list is on its way are newer than it
    const mark = asksEvents;
    try {
      const info = await api.asks();
      const list = Array.isArray(info.asks) ? info.asks : [];
      set((s) => ({
        asks: replaceAsks(s.asks, list, (id) => (asksHeard.get(id) ?? 0) > mark),
        asksReady: true,
        presence: info.presence ?? null,
      }));
    } catch {
      set({ asks: {}, asksReady: false, presence: null });
    }
  },
  openInbox: (focus) => {
    set({ inboxOpen: true, inboxFocus: focus ?? null });
    void get().loadAsks();
  },
  closeInbox: () => set({ inboxOpen: false, inboxFocus: null }),
  loadRanger: async (backend) => {
    const b = backend ?? get().home;
    const mark = rangerEvents.get(b) ?? 0;
    try {
      const ranger = await api.ranger(b);
      if ((rangerEvents.get(b) ?? 0) === mark && isShown(get(), b)) set((s) => ({ rangers: { ...s.rangers, [b]: ranger } }));
    } catch {
      // an older backend has no ranger; nothing shows for it
    }
  },
  loadAwake: async (b) => {
    try {
      const info = await api.awake(b);
      if (isShown(get(), b)) set((s) => ({ awake: { ...s.awake, [b]: info } }));
    } catch {
      // an older backend has no keep awake; its row says so
    }
  },
  setAwake: async (b, mode) => {
    const info = await api.setAwake(mode, b);
    set((s) => ({ awake: { ...s.awake, [b]: info } }));
  },
  loadSweep: async () => {
    const mark = sweepEvents;
    try {
      const sweep = await api.sweep();
      if (sweepEvents === mark) set({ sweep });
    } catch {
      // an older backend has no sweep, and a page without the admin right
      // cannot read it; the sheet says so
    }
  },
  // the sheet reads the sweep afresh as it opens
  openSweep: () => set({ sheet: { kind: "sweep" } }),
  pickSweep: (keys) => set({ sheet: { kind: "sweep", picks: [...keys], pick: ++sweepPicks } }),
  setSweepSettings: async (patch) => {
    const settings = await api.setSweepSettings(patch);
    // the event that follows makes the page read the whole sweep again;
    // this shows the settings at once, before that read or without a stream
    set((s) => (s.sweep ? { sweep: { ...s.sweep, settings } } : {}));
  },
  closeSweep: async (keys) => {
    // No read after it: the hub sends its event before it answers, but on
    // another connection, and a read that landed first would hold the new
    // close as seen, so the event would end no panel and add no feed line.
    // A stream that was down reads the sweep again on its reconnect.
    return api.closeSweep(keys);
  },
  resumeSwept: async (runId) => {
    const run = await api.resumeSwept(runId);
    set((s) => ({ runs: { ...s.runs, [run.id]: run }, sheet: { kind: "run", runId: run.id } }));
  },
  loadHealth: async (backend) => {
    const b = backend ?? get().home;
    const mark = healthEvents.get(b) ?? 0;
    try {
      const checks = await api.health(b);
      if ((healthEvents.get(b) ?? 0) === mark && isShown(get(), b)) set((s) => ({ health: { ...s.health, [b]: checks } }));
    } catch {
      // an older backend has no health; nothing shows for it
    }
  },
  loadCapacity: async (backend) => {
    const b = backend ?? get().home;
    const mark = capacityEvents.get(b) ?? 0;
    try {
      const capacity = await api.capacity(b);
      if ((capacityEvents.get(b) ?? 0) === mark && isShown(get(), b)) set((s) => ({ capacity: { ...s.capacity, [b]: capacity } }));
    } catch {
      // an older backend has no capacity route; it remains out of the chip
    }
  },
  loadKit: async (backend) => {
    const b = backend ?? get().home;
    const mark = kitEvents.get(b) ?? 0;
    try {
      const kit = await api.kit(b);
      if ((kitEvents.get(b) ?? 0) === mark && isShown(get(), b)) set((s) => ({ kit: { ...s.kit, [b]: kit } }));
    } catch {
      // an older backend has no kit; nothing shows for it
    }
  },
  loadLanding: async (backend) => {
    const b = backend ?? get().home;
    const mark = landingEvents.get(b) ?? 0;
    try {
      const landing = await api.landing(b);
      if ((landingEvents.get(b) ?? 0) === mark && isShown(get(), b)) set((s) => ({ landing: { ...s.landing, [b]: landing } }));
    } catch {
      // an older backend has no landing queue; nothing shows for it
    }
  },
  landRun: async (id, approve, skipJudge) => {
    await api.land(id, approve, skipJudge);
  },
  landAll: (repoId) => api.landAll(repoId),
  landingDiff: async (id, path) => (await api.landingDiff(id, path)).diff,
  seenLanding: async (ids) => {
    await api.seenLanding(ids);
  },
  showApprove: (id) => set({ sheet: { kind: "approve", id } }),
  fixLanding: async (id) => {
    const run = await api.fixLanding(id);
    set((s) => ({ runs: { ...s.runs, [run.id]: run }, sheet: { kind: "run", runId: run.id } }));
  },
  dropLanding: async (id) => {
    await api.dropLanding(id);
  },
  orphanLanding: async (backend, dir, action) => {
    await api.orphanLanding(backend, dir, action);
    await get().loadLanding(backend);
  },
  loadPrs: async (backend) => {
    const b = backend ?? get().home;
    const mark = prsEvents.get(b) ?? 0;
    try {
      const prs = await api.prs(b);
      if ((prsEvents.get(b) ?? 0) === mark && isShown(get(), b)) set((s) => ({ prs: { ...s.prs, [b]: prs } }));
    } catch {
      // an older backend has no PR watch; nothing shows for it
    }
  },
  loadTriggers: async (backend) => {
    const b = backend ?? get().home;
    const mark = triggersEvents.get(b) ?? 0;
    try {
      const info = await api.triggers(b);
      if (!info || !isShown(get(), b)) return;
      // an event that came while the read was out is newer than its list
      set((s) => ({ triggers: { ...s.triggers, [b]: (triggersEvents.get(b) ?? 0) === mark ? info : { ...info, events: s.triggers[b]?.events ?? info.events } } }));
    } catch {
      // an older backend has no triggers; nothing shows for it
    }
  },
  fireTrigger: async (backend, rule, title, repo) => {
    const d = await api.fireTrigger(backend, rule, title, repo);
    void get().loadTriggers(backend);
    return d;
  },
  pollTrigger: async (backend, rule) => {
    await api.pollTrigger(backend, rule);
    void get().loadTriggers(backend);
  },
  triggerAct: async (id, act) => {
    await api.triggerAct(id, act);
  },
  dismissTrigger: async (id) => {
    await api.dismissTrigger(id);
  },
  openPr: async (id, draft) => {
    await api.openPr(id, draft);
  },
  setPr: async (id, change) => {
    await api.setPr(id, change);
  },
  closePr: async (id) => {
    await api.closePr(id);
  },
  loadAuth: async (backend) => {
    const b = backend ?? get().home;
    const mark = authEvents.get(b) ?? 0;
    const sent = readToken(originOf(baseOf(b)));
    let info: AuthInfo | null;
    try {
      info = await api.auth(b);
    } catch {
      // an older backend has no caller check; nothing shows for it
      return;
    }
    if (!info || !isShown(get(), b)) return;
    const was = get().authByBackend[b];
    // a pair event since the read is newer than the read's own list
    const pending = was && (authEvents.get(b) ?? 0) !== mark ? was.pending : info.pending;
    const auth = authOf(b, { ...info, pending }, was?.needed ?? false, sent);
    set((s) => ({ authByBackend: { ...s.authByBackend, [b]: auth } }));
  },
  signIn: async (backend, resume = false) => {
    if (signingIn.has(backend) || !isShown(get(), backend)) return;
    const origin = originOf(baseOf(backend));
    const held = readPair(origin, Date.now());
    if (resume && (!held || readToken(origin))) {
      if (held) writePair(origin, null);
      return;
    }
    const mine = ++signInSeq;
    signingIn.set(backend, mine);
    const live = () => signingIn.get(backend) === mine && isShown(get(), backend);
    const say = (signIn: SignIn | null) =>
      set((s) => {
        const { [backend]: _was, ...rest } = s.signIns;
        return { signIns: signIn ? { ...rest, [backend]: signIn } : rest };
      });
    try {
      const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
      // a sign-in the tab held over a reload goes on with the same code
      const { id, code, secret, until } =
        held ?? { ...(await api.pair(backend, pairLabel(get().settings.device || deviceName(ua)), lastPairs.get(backend))), until: Date.now() + CLAIM_WINDOW };
      if (!live()) return;
      lastPairs.set(backend, { id, secret });
      writePair(origin, { id, secret, code, until });
      say({ state: "waiting", id, code });
      for (;;) {
        let got: { token: string } | { waiting: true } | null = null;
        try {
          got = await api.claim(backend, id, secret);
        } catch (err) {
          // denied, expired or claimed (404), or too many tries (429): over.
          // No answer at all is the network's, and the next try may get one
          if (typeof (err as { status?: unknown }).status === "number") throw err;
        }
        if (!live()) return;
        if (got && "token" in got) {
          // storage that refuses would leave a caller no page can use, and a
          // sign-in after it another one
          if (!writeToken(origin, got.token)) throw new Error("this browser would not keep the token");
          lastPairs.delete(backend);
          writePair(origin, null);
          say(null);
          await get().loadAuth(backend);
          // the sweep is read only with a home token, so the page that just
          // got one reads it now: its inbox item and Settings tab need no reload
          if (backend === get().home) void get().loadSweep();
          return;
        }
        if (Date.now() >= until) throw new Error("no one approved it within ten minutes");
        await new Promise((r) => setTimeout(r, claimEvery));
        if (!live()) return;
      }
    } catch (err) {
      // over: denied, expired, claimed or out of time, so a reload asks anew
      writePair(origin, null);
      if (live()) say({ state: "failed", why: err instanceof Error ? err.message : String(err) });
    } finally {
      if (signingIn.get(backend) === mine) signingIn.delete(backend);
    }
  },
  useFirstCode: async (backend, code) => {
    const s = get().signIns[backend];
    if (s?.state !== "waiting") throw new Error("no sign-in is waiting");
    // the poll picks the token up on its next claim
    await api.firstCode(backend, s.id, code.trim());
  },
  approvePair: async (backend, id) => {
    await api.approvePair(backend, id);
    await get().loadAuth(backend);
  },
  denyPair: async (backend, id) => {
    await api.denyPair(backend, id);
    await get().loadAuth(backend);
  },
  revokeCaller: async (backend, id) => {
    await api.revokeCaller(backend, id);
    if (get().authByBackend[backend]?.youId === id) writeToken(originOf(baseOf(backend)), null);
    await get().loadAuth(backend);
  },
  loadSecrets: async (backend) => {
    const b = backend ?? get().home;
    const mark = secretsEvents.get(b) ?? 0;
    try {
      const info = await api.secrets(b);
      // a read carries this page's session, so it wins over any event that
      // came in meanwhile on that one field
      if ((secretsEvents.get(b) ?? 0) === mark && isShown(get(), b)) set((s) => ({ secrets: { ...s.secrets, [b]: info } }));
      else if (isShown(get(), b))
        set((s) => {
          const cur = s.secrets[b];
          return cur ? { secrets: { ...s.secrets, [b]: { ...cur, session: info.session } } } : {};
        });
    } catch {
      // an older backend has no secret store; nothing shows for it
    }
  },
  healCheck: async (b, id) => {
    const check = await api.healCheck(b, id);
    healthEvents.set(b, (healthEvents.get(b) ?? 0) + 1);
    set((s) => ({ health: { ...s.health, [b]: (s.health[b] ?? []).map((c) => (c.id === check.id ? check : c)) } }));
  },
  setRanger: async (b, patch) => {
    const ranger = await api.setRanger(b, patch);
    rangerEvents.set(b, (rangerEvents.get(b) ?? 0) + 1);
    set((s) => ({ rangers: { ...s.rangers, [b]: ranger } }));
  },
  rangerAct: async (b, act) => {
    const ranger = await api.rangerAct(b, act);
    rangerEvents.set(b, (rangerEvents.get(b) ?? 0) + 1);
    set((s) => ({ rangers: { ...s.rangers, [b]: ranger } }));
  },
  addRangerWake: async (b, wake) => {
    await api.addRangerWake(b, wake);
    await get().loadRanger(b);
  },
  removeRangerWake: async (b, id) => {
    const ranger = await api.removeRangerWake(b, id);
    rangerEvents.set(b, (rangerEvents.get(b) ?? 0) + 1);
    set((s) => ({ rangers: { ...s.rangers, [b]: ranger } }));
  },
  openRanger: (b) => {
    const s = get();
    const info = s.rangers[b];
    if (!info) return;
    const id = qual(b, info.term);
    const old = s.terms.find((t) => t.id === id);
    if (!old || old.exit !== undefined) {
      // the repo id is the backend's alone, so the tab and its shell agree on whose they are
      const tab: TermTab = { id, repoId: qual(b, ""), name: `@${info.handle}`, path: info.root, place: "strip", ranger: true };
      set({
        terms: old ? s.terms.map((t) => (t.id === id ? { ...tab, gen: (old.gen ?? 0) + 1 } : t)) : [...s.terms, tab],
        hiddenTerms: s.hiddenTerms.filter((h) => h !== id),
      });
    }
    set({ activeTerm: id });
  },
  loadSprouts: async (backend) => {
    const b = backend ?? get().home;
    const load = (sproutLoads.get(b) ?? 0) + 1;
    sproutLoads.set(b, load);
    const stagesMark = stagesEvents.get(b) ?? 0;
    void api
      .incubatorStages(b)
      .then((stages) => {
        if ((stagesEvents.get(b) ?? 0) === stagesMark && isShown(get(), b)) set((s) => ({ stages: { ...s.stages, [b]: stages } }));
      })
      .catch(() => {
        // an older backend has no such route; the view says nothing then
      });
    if (b === get().home) {
      const adviceMark = adviceEvents;
      void api
        .advice()
        .then((advice) => {
          if (adviceEvents === adviceMark && Array.isArray(advice)) set({ advice });
        })
        .catch(() => {
          // an older backend has no such route, and offers nothing
        });
    }
    // events that land while the list is on its way are newer than it
    const mark = sproutEvents;
    try {
      const list = await api.sprouts(b);
      // hidden while the list was on its way: it lands nothing
      if (!isShown(get(), b) || sproutLoads.get(b) !== load) return;
      set((s) => {
        const mine = mineOf(b);
        const held = Object.fromEntries(Object.entries(s.sprouts).filter(([id]) => mine(id)));
        const fresh = replaceSprouts(held, Array.isArray(list) ? list : [], (id) => (sproutHeard.get(id) ?? 0) > mark);
        return { sprouts: { ...recordOut(s.sprouts, b), ...fresh }, sproutsReady: true };
      });
    } catch {
      // a failed reload keeps what is held, so a blip does not drop the inbox's questions
    }
  },
  createSprout: async (form, backend) => {
    const sp = await api.newSprout(form, backend ?? get().home);
    sproutAnswered(get, sp);
    return sp;
  },
  addSproutInputs: async (id, form) => {
    const sp = await api.addSproutInputs(id, form);
    sproutAnswered(get, sp);
    return sp;
  },
  answerSprout: async (id, answers) => {
    sproutAnswered(get, await api.answerSprout(id, answers ? { answers } : { skip: true }));
  },
  stopSprout: async (id) => {
    sproutAnswered(get, await api.stopSprout(id));
  },
  resumeSprout: async (id, choice) => {
    sproutAnswered(get, await api.resumeSprout(id, choice));
  },
  handOffSprout: async (id, approve, head) => {
    sproutAnswered(get, await api.handOffSprout(id, approve, head));
  },
  dismissSprout: async (id) => {
    await api.dismissSprout(id);
    get().applyEvent({ type: "incubator-gone", id }, ownerOf(id));
  },
  showSprout: (id) => set({ sheet: { kind: "sprout", id } }),
  openNewSprout: () => set({ sheet: { kind: "new-sprout" } }),
  draftSprout: (draft) => set({ sheet: { kind: "new-sprout", draft } }),
  answerAdvice: async (key, accept) => {
    const { advice, accepted } = await api.answerAdvice(key, accept);
    adviceEvents += 1;
    set({ advice });
    if (accepted?.kind === "chat") {
      // the run as the answer gave it, as startRun does, so its sheet never opens on nothing
      const run = accepted.run;
      set((s) => ({
        inboxOpen: false,
        inboxFocus: null,
        chatDrafts: { ...s.chatDrafts, [accepted.runId]: accepted.draft },
        ...(run && !s.runs[run.id] ? { runs: { ...s.runs, [run.id]: run } } : {}),
      }));
      get().showRun(accepted.runId);
    }
    if (accepted?.kind === "file") set({ adviceFile: accepted });
    return accepted ?? null;
  },
  answerInbox: async (item, answer) => {
    if (item.source === "sweep") {
      if (!("sweep" in answer)) throw new Error("the sweep's ask takes close all or dismiss");
      const keys = answer.sweep === "dismiss" ? null : askCloses(item.sweep ?? []);
      if (keys?.length === 0) throw new Error("none of these can be closed from here: tick them in the sheet");
      try {
        await (keys === null ? api.dismissSweepAsk() : api.answerSweepAsk(keys));
      } catch (e) {
        // no ask pending: another device answered it first, which is done;
        // read the sweep so the item leaves even if its event was missed
        if (!askGone(e)) throw e;
        void get().loadSweep();
      }
      return;
    }
    if (item.source === "landing") {
      if (!("landing" in answer)) throw new Error("a landing item takes fix it, land anyway or drop");
      if (answer.landing === "drop") return get().dropLanding(item.id);
      get().closeInbox();
      if (answer.landing === "land") return get().landRun(item.id, undefined, true);
      return get().fixLanding(item.id);
    }
    if (item.source === "pr") {
      if (!("pr" in answer)) throw new Error("a PR's red check takes auto-fix");
      return get().setPr(item.id, { autoFix: true });
    }
    if (item.source === "auth") {
      if (!("pair" in answer) || item.backend === undefined) throw new Error("a pair request takes allow or deny");
      return answer.pair === "allow" ? get().approvePair(item.backend, item.id) : get().denyPair(item.backend, item.id);
    }
    if (item.source === "advice") {
      if (!("advice" in answer)) throw new Error("a lesson takes accept or dismiss");
      await get().answerAdvice(answer.advice, answer.accept);
      return;
    }
    if (item.source === "sprout") {
      if ("handOff" in answer) {
        if (!item.head) throw new Error("this project has no hand-off waiting");
        return get().handOffSprout(item.id, answer.handOff, item.head);
      }
      if ("choice" in answer) {
        if (answer.choice === "stop") return get().stopSprout(item.id);
        return get().resumeSprout(item.id, answer.choice);
      }
      if ("skip" in answer) return get().answerSprout(item.id, null);
      if (!("answers" in answer)) throw new Error("clarify's questions take answers, or go on assumptions");
      return get().answerSprout(item.id, answer.answers);
    }
    if (item.source === "flow") {
      if (!("choice" in answer)) throw new Error("a gate takes continue, retry or stop");
      await get().resumeFlow(item.id, answer.choice);
      return;
    }
    if (item.source === "run") {
      const a = toRunAnswer(answer);
      if (!a || !item.promptId) throw new Error("that run is not waiting on a prompt");
      await get().answerRun(item.id, item.promptId, a);
      return;
    }
    const a = toAskAnswer(answer);
    if (!a) throw new Error("an ask takes allow, deny or answers");
    const key = get().answerKey;
    if (!key) throw new Error(NO_KEY);
    const ask = await api.answerAsk(item.id, a, key);
    // through the event path, so the feed says how it ended now: the
    // broker's own event may come after this answer, and would then find
    // the ask closed already and say nothing
    get().applyEvent({ type: "asks", asks: [ask] });
  },
  setAway: async (away) => {
    const key = get().answerKey;
    if (!key) throw new Error(NO_KEY);
    const presence = await api.setAway(away, key);
    set({ presence });
  },
  pagePresence: () => {
    const now = Date.now();
    const { answerKey: key, asksReady } = get();
    if (!key || !asksReady || now - lastPageBeat < PAGE_BEAT) return;
    lastPageBeat = now;
    void api
      .presenceBeat(key)
      .then(({ presence }) => {
        if (presence) set({ presence });
      })
      .catch(() => {});
  },
  setAnswerKey: (raw) => {
    const key = raw === null ? null : cleanKey(raw);
    if (raw !== null && key === null) throw new Error("an answer key is one word: the secret half of a name:secret pair in the broker's ANSWER_TOKENS");
    writeAnswerKey(key);
    set({ answerKey: key });
  },
  testAnswerKey: async (raw) => {
    const key = cleanKey(raw);
    if (!key) return { ok: false, refused: true, why: "an answer key is one word" };
    try {
      const { presence } = await api.presenceBeat(key);
      if (presence) set({ presence });
      return keyTestOf(null);
    } catch (e) {
      return keyTestOf(e);
    }
  },
  loadChan: async () => {
    const chan = await api.tailchan().catch((e: unknown): TailchanInfo => ({ ready: false, reason: String(e instanceof Error ? e.message : e) }));
    set({ chan, chanAs: chan.ready ? chan.as : get().chanAs });
  },
  openChan: (target) => {
    const s = get();
    const conv = target ? convOf(target, s.chanAs) : s.chanConv;
    set({ chanOpen: true, chanUnread: 0, chanConv: conv });
    void get().loadChan();
    if (conv) void get().showConv(conv);
    readClips();
  },
  closeChan: () => set({ chanOpen: false }),
  chanTab: (on) => {
    if (!on) return set({ chanInTab: false });
    set({ chanInTab: true, chanUnread: 0 });
    const { loadChan, showConv, chanConv } = get();
    void loadChan();
    if (chanConv) void showConv(chanConv);
    readClips();
  },
  showConv: async (conv) => {
    set({ chanConv: conv });
    const msgs = await api.chanRead(conv, 50).catch((): ChanMessage[] => []);
    set((s) => ({ chanMsgs: { ...s.chanMsgs, [conv]: mergeMessages(s.chanMsgs[conv], msgs) } }));
  },
  // what is sent comes back as a chan event, which is what files it
  sendChan: async (target, body, kind = "text") => {
    await api.chanSend(target, body, kind);
  },
  putChan: async (target, file, note = "") => {
    await api.chanPut(target, file, note);
  },
  setChanNotify: async (on) => {
    const { notify } = await api.chanNotify(on);
    set((s) => ({ chan: s.chan?.ready ? { ...s.chan, notify } : s.chan }));
  },
  closeTerm: (id) => {
    const s = get();
    const tab = s.terms.find((t) => t.id === id);
    if (!tab) return;
    // a task's and the ranger's sessions belong to their hubs: closing the tab only leaves
    if (!tab.task && !tab.ranger) endShells([tab]);
    const terms = s.terms.filter((t) => t.id !== id);
    const { [id]: _pending, ...pendingTermLabels } = s.pendingTermLabels;
    set({ terms, pendingTermLabels, activeTerm: nextStripTab(s.terms, id, s.activeTerm), front: keepFront(s.front, terms, s.panels) });
  },
  hideTerm: (id) => {
    const s = get();
    if (!s.terms.some((t) => t.id === id)) return;
    const terms = s.terms.filter((t) => t.id !== id);
    const { [id]: _pending, ...pendingTermLabels } = get().pendingTermLabels;
    set({
      terms,
      pendingTermLabels,
      activeTerm: nextStripTab(s.terms, id, s.activeTerm),
      front: keepFront(s.front, terms, s.panels),
      hiddenTerms: s.hiddenTerms.includes(id) ? s.hiddenTerms : [...s.hiddenTerms, id],
    });
  },
  joinTerm: (id) => {
    const s = get();
    const info = s.shells.find((t) => t.id === id);
    const repo = info && s.repos.find((r) => r.id === info.repoId);
    if (!info || !repo) return;
    // a solo or shell window has no strip or dock of its own to put a tab
    // in: it becomes the shell's own window instead
    if (dockless()) {
      window.location.assign(shellUrlFor(repo.id, id));
      return;
    }
    const tab: TermTab = s.terms.find((t) => t.id === id) ?? {
      id,
      repoId: repo.id,
      name: repo.name,
      path: repo.path,
      place: info.place,
      ...(info.label ? { label: info.label } : {}),
    };
    set({
      terms: s.terms.some((t) => t.id === id) ? s.terms : [...s.terms, tab],
      hiddenTerms: s.hiddenTerms.filter((h) => h !== id),
      activeTerm: tab.place === "strip" ? id : s.activeTerm,
      ...(tab.place === "panel"
        ? { ...dockPanel(s, repo.id), closedSections: unfoldIn(s.closedSections, repo.id, "shell") }
        : {}),
    });
  },
  resumeAgent: async (repoId, session, harness) => {
    const s = get();
    const repo = s.repos.find((r) => r.id === repoId);
    if (!repo || repo.forge) return;
    // the shell setting picks panel or strip; a tab or window of its own is
    // the strip here, since the shell is started before any window opens
    const where = shellPlace(s.settings.shell, {
      panelOpen: s.panels.includes(repoId),
      solo: loneWindow(),
    });
    const place = where === "panel" ? "panel" : "strip";
    const id = qual(backendOf(repoId), termId());
    await api.resumeAgent(repoId, id, place, session, harness);
    if (dockless()) {
      window.location.assign(shellUrlFor(repoId, id));
      return;
    }
    const tab: TermTab = { id, repoId, name: repo.name, path: repo.path, place, harness };
    set((now) => ({
      terms: now.terms.some((t) => t.id === id) ? now.terms : [...now.terms, tab],
      activeTerm: place === "strip" ? id : now.activeTerm,
      ...(place === "panel"
        ? { ...dockPanel(now, repoId), closedSections: unfoldIn(now.closedSections, repoId, "shell") }
        : {}),
    }));
  },
  landMove: (oldTab, fromRepoId, toRepoId, info) => {
    get().switchCheckout(fromRepoId, toRepoId);
    const repo = get().repos.find((r) => r.id === toRepoId);
    if (!repo) return;
    // the name the tab had goes with the shell to its new backend
    const label = info.label ?? get().terms.find((t) => t.id === oldTab)?.label;
    if (label && !info.label) void api.labelTerm(info.id, label).catch(() => {});
    const tab: TermTab = { id: info.id, repoId: repo.id, name: repo.name, path: repo.path, place: info.place, ...(label ? { label } : {}) };
    set((now) => ({
      terms: [...now.terms.filter((t) => t.id !== oldTab && t.id !== info.id), tab],
      ...(info.place === "panel" ? { ...dockPanel(now, toRepoId), closedSections: unfoldIn(now.closedSections, toRepoId, "shell") } : { activeTerm: info.id }),
    }));
  },
  showTerm: (id) => set((s) => (s.terms.some((t) => t.id === id) ? { activeTerm: id, stripPage: null } : {})),
  tabSection: (repoId, key, place) => {
    const s = get();
    s.setSetting("sectionTabs", addSectionTab(s.settings.sectionTabs, place, repoId, key));
    const id = sectionTabId(place, key, repoId);
    if (place === "strip") set({ stripPage: id });
    // a folded shell section would hide the new tab
    if (place === "panel" && closedIn(s, repoId, "shell")) s.toggleSection(repoId, "shell");
  },
  tabItem: (place, item) => {
    const s = get();
    s.setSetting("itemTabs", addItemTab(s.settings.itemTabs, place, item));
    const id = itemTabId(place, item.kind, item.ref);
    if (place === "strip") set({ stripPage: id });
    if (place === "panel" && item.repoId && closedIn(s, item.repoId, "shell")) s.toggleSection(item.repoId, "shell");
    // one place only: the item leaves the dock panel it had (FR-047)
    const panel = panelOfItem(item);
    if (panel && s.panels.includes(panel)) s.closePanel(panel);
  },
  dockItem: (item, into) => {
    const s = get();
    const panel = panelOfItem(item);
    if (!panel) return;
    // one place only: out of every shell window's tab, and off its sheet
    const same = (t: { kind: string; ref: string }) => t.kind === item.kind && t.ref === item.ref;
    if (s.settings.itemTabs.some(same)) {
      s.setSetting("itemTabs", s.settings.itemTabs.filter((t) => !same(t)));
      if (s.stripPage === itemTabId("strip", item.kind, item.ref)) set({ stripPage: null });
    }
    if (item.kind === "run" && s.sheet?.kind === "run" && s.sheet.runId === item.ref) set({ sheet: null });
    s.openPanel(panel, into);
  },
  untab: (id) => {
    const s = get();
    if (s.settings.sectionTabs.some((t) => t.id === id)) s.setSetting("sectionTabs", dropSectionTab(s.settings.sectionTabs, id));
    if (s.settings.itemTabs.some((t) => t.id === id)) s.setSetting("itemTabs", s.settings.itemTabs.filter((t) => t.id !== id));
    if (s.stripPage === id) set({ stripPage: null });
  },
  showStripPage: (id) =>
    set((s) => ([...s.settings.sectionTabs, ...s.settings.itemTabs].some((t) => t.id === id && t.place === "strip") ? { stripPage: id } : {})),
  termSocketLabelSent: (id, label) =>
    set((s) => {
      const pending = s.pendingTermLabels[id];
      return pending && pending.previous !== label
        ? { pendingTermLabels: { ...s.pendingTermLabels, [id]: { ...pending, previous: label } } }
        : {};
    }),
  renameTerm: (id, label) => {
    const state = get();
    const before = state.terms;
    const previous = before.find((t) => t.id === id);
    const terms = renameTab(before, id, label);
    if (terms === before) return;
    const tab = terms.find((t) => t.id === id);
    const shellExists = state.shells.some((x) => x.id === id);
    if (tab && !tab.task && !tab.ranger && !shellExists && connOf(state, backendOf(id)).backend.labels === true) {
      const pending = state.pendingTermLabels[id];
      set({
        terms,
        pendingTermLabels: {
          ...state.pendingTermLabels,
          [id]: { previous: pending ? pending.previous : previous?.label ?? null, label: tab.label ?? null, phase: "waiting" },
        },
      });
      return;
    }
    const { [id]: _pending, ...pendingTermLabels } = state.pendingTermLabels;
    set({ terms, pendingTermLabels });
    // a task's and the ranger's sessions have names of their own; a shell
    // already listed takes a label over HTTP
    if (tab && !tab.task && !tab.ranger && shellExists) void api.labelTerm(id, tab.label ?? "").catch(() => {});
  },
  swapTerms: (a, b) => set((s) => ({ terms: swapTabs(s.terms, a, b) })),
  endTerm: (id, code) =>
    set((s) => ({ terms: s.terms.map((t) => (t.id === id ? { ...t, exit: code } : t)) })),
  setTermHeight: (px) => set({ termHeight: clamp(px, TERM.min, TERM.max) }),
  setFocusSize: (size) => set({ focusSize: size }),
  setFront: (front) => set({ front }),
  bringProject: (repoId) =>
    set((s) => (repoId === null ? { front: null } : isReservedPanel(repoId) ? {} : { ...dockPanel(s, repoId), front: projectFront(repoId) })),
  soloBench: (repoId, pane) =>
    set((s) => {
      const front = withSolo(s.front, repoId, pane);
      return front === s.front ? {} : { front };
    }),
  placeTerm: async (id, place) => {
    const tab = get().terms.find((t) => t.id === id);
    if (!tab || tab.task !== undefined || tab.ranger || tab.joinOnly) return false;
    if (tab.place === place) return true;
    try {
      await api.placeTerm(id, place);
    } catch {
      return false;
    }
    set((s) => ({
      terms: s.terms.map((t) => (t.id === id ? { ...t, place } : t)),
      ...(place === "strip"
        ? { activeTerm: id, stripPage: null }
        : { activeTerm: nextStripTab(s.terms, id, s.activeTerm), ...dockPanel(s, tab.repoId), closedSections: unfoldIn(s.closedSections, tab.repoId, "shell") }),
    }));
    return true;
  },
  bringTerm: (id) => {
    // joining gives a shell with no tab here one, and opens and unfolds a
    // panel shell's panel; a tab already here keeps its place
    get().joinTerm(id);
    const s = get();
    const tab = s.terms.find((t) => t.id === id);
    if (!tab) return;
    set({
      front: frontForTab(s.front, tab),
      ...(tab.place === "strip"
        ? { activeTerm: id }
        : { ...dockPanel(s, tab.repoId), closedSections: unfoldIn(s.closedSections, tab.repoId, "shell") }),
    });
  },
  setPanelTermHeight: (repoId, px) =>
    set((s) => ({
      panelTermHeights: { ...s.panelTermHeights, [repoId]: clamp(px, PANEL_TERM.min, PANEL_TERM.max) },
    })),

  plan: (repoId, action) => {
    // A repo with a run going shows that run instead of starting a second.
    // A coordinator holds no repo, so only a coordinator going stops a new one.
    const active = action === "coordinate" ? coordinatorFor(get(), repoId) : activeRunFor(get(), repoId);
    set({ sheet: active ? { kind: "run", runId: active.id } : { kind: "plan", repoId, action } });
  },
  openWsPlan: (name, action) => {
    const s = get();
    const ws = s.workspaces.find((w) => w.name === name);
    if (!ws) throw new Error(`no workspace named ${name}`);
    const path = effectivePrimary(ws);
    if (!path) throw new Error("the workspace has no repos");
    // a workspace holds home's checkouts, so its primary is a home card
    const primary = s.repos.find((r) => isHome(r.id) && r.path === path);
    if (!primary) throw new Error(`the primary ${path} is not in the tree`);
    // the primary's own run going shows that run, as plan does
    const active = activeRunFor(s, primary.id);
    set({
      sheet: active ? { kind: "run", runId: active.id } : { kind: "plan", repoId: primary.id, action, workspace: name },
    });
  },
  openChat: async (repoId, note = "") => {
    const active = activeRunFor(get(), repoId);
    const trimmed = note.trim();
    // The plain "chat" menu item passes no note: show whatever is already
    // going, or start a fresh idle chat with nothing to say yet. Unaffected
    // by mergeAction, which is about a caller with something to send.
    if (!trimmed) {
      if (active) {
        set({ sheet: { kind: "run", runId: active.id } });
        return;
      }
      await get().startRun(repoId, "chat", "");
      return;
    }
    if (!active) {
      await get().startRun(repoId, "chat", note);
      return;
    }
    if (mergeAction(active) === "busy") {
      throw new Error("a run is already going on this repo");
    }
    // An idle chat: the note is the next turn, not a fresh start.
    await get().sayRun(active.id, trimmed);
    set({ sheet: { kind: "run", runId: active.id } });
  },
  sendToAgent: async (repoId, text) => {
    const active = activeRunFor(get(), repoId);
    if (active) {
      if (mergeAction(active) === "busy") throw new Error("a run is already going on this repo");
      await get().sayRun(active.id, text);
      set({ sheet: { kind: "run", runId: active.id } });
      return "said";
    }
    const shell = await pasteIntoAgentShell(repoId, text, null, get().terms);
    if (shell) {
      get().showTerm(shell);
      return "pasted";
    }
    // a chat, not a new shell: a shell's first message rides its socket URL
    // and is cut at the server's prompt cap, a chat's note is not
    await get().startRun(repoId, "chat", text);
    return "started";
  },
  addNote: (note) => {
    set({ reviewNotes: updateNotes(get().reviewNotes, (all) => withNote(all, { ...note, id: noteId() })) });
  },
  removeNote: (repoId, id) => {
    set({ reviewNotes: updateNotes(get().reviewNotes, (all) => withoutNotes(all, repoId, new Set([id]))) });
  },
  clearNotes: (repoId) => {
    set({ reviewNotes: updateNotes(get().reviewNotes, (all) => withoutNotes(all, repoId, new Set((all[repoId] ?? []).map((n) => n.id)))) });
  },
  sendNotes: async (repoId) => {
    const notes = get().reviewNotes[repoId] ?? [];
    if (notes.length === 0) throw new Error("no review notes on this repo");
    const how = await get().sendToAgent(repoId, notesPrompt(notes));
    // only the ones sent: a note left while it went stays for the next send
    set({ reviewNotes: updateNotes(get().reviewNotes, (all) => withoutNotes(all, repoId, new Set(notes.map((n) => n.id)))) });
    return how;
  },
  editAgent: (repoId) => set({ sheet: { kind: "agent", repoId } }),
  setAgent: async (repoId, agent) => {
    // a backend older than routing reads anything but plain settings as its
    // defaults and deletes the entry, so it gets the whole-repo pick alone
    const routing = hasRouting(connOf(get(), backendOf(repoId)).backend);
    const agents = await api.setRepoAgent(repoId, routing ? agent : flatAgent(agent));
    set((s) => ({ agents: { ...s.agents, [backendOf(repoId)]: agents } }));
  },
  setProfile: async (backend, name, settings) => {
    const agents = await api.setProfile(name, settings, backend);
    set((s) => ({ agents: { ...s.agents, [backend]: agents } }));
  },
  setRole: async (backend, role, pick) => {
    const agents = await api.setRole(role, pick, backend);
    set((s) => ({ agents: { ...s.agents, [backend]: agents } }));
  },
  setAgentScope: async (backend, scope, pick) => {
    const agents = await api.setAgentScope(scope, pick, backend);
    set((s) => ({ agents: { ...s.agents, [backend]: agents } }));
  },
  archiveRepo: async (repoId, archived) => {
    const repo = await api.archive(repoId, archived);
    get().applyEvent({ type: "repo", repo }, backendOf(repoId));
  },
  favoriteRepo: async (repoId, favorite) => {
    const ids = favorite
      ? [repoId]
      : (cardOf(get(), repoId)?.checkouts.filter((r) => r.favorite).map((r) => r.id) ?? [repoId]);
    for (const id of ids) {
      const repo = await api.favorite(id, favorite);
      get().applyEvent({ type: "repo", repo }, backendOf(id));
    }
  },
  harnessRepo: async (repoId, harness) => {
    const ids = harness
      ? [repoId]
      : (cardOf(get(), repoId)?.checkouts.filter((r) => r.harness === true).map((r) => r.id) ?? [repoId]);
    for (const id of ids) {
      const repo = await api.harness(id, harness);
      get().applyEvent({ type: "repo", repo }, backendOf(id));
    }
  },

  sayHarness: (key) => {
    if (!HARNESS_WEEK_KEY.test(key)) return;
    set({ harnessSaid: key });
    try {
      localStorage.setItem(HARNESS_SAID_KEY, key);
    } catch {
      // the line stays quiet for this page even when storage is unavailable
    }
  },
  editLaunch: (repoId) => set({ sheet: { kind: "launch", repoId } }),
  editTask: (repoId, name) => set({ sheet: { kind: "task", repoId, name } }),
  showTasks: (repoId) =>
    set((s) => ({
      ...dockPanel(s, repoId),
      closedSections: unfoldIn(s.closedSections, repoId, "tasks"),
    })),
  showAgents: (repoId) =>
    set((s) => ({
      ...dockPanel(s, repoId),
      closedSections: unfoldIn(s.closedSections, repoId, "agents"),
    })),
  showHealth: (repoId) =>
    set((s) => ({
      ...dockPanel(s, repoId),
      closedSections: unfoldIn(s.closedSections, repoId, "health"),
    })),
  showLanding: (repoId) =>
    set((s) => ({
      ...dockPanel(s, repoId),
      closedSections: unfoldIn(s.closedSections, repoId, "landing"),
    })),
  bringTask: (repoId, task = null) =>
    set((s) => ({ ...dockPanel(s, repoId), front: frontForTask(s.front, repoId, task) })),
  dropBenchTask: (repoId) =>
    set((s) => {
      const front = clearTask(s.front, repoId);
      return front === s.front ? {} : { front };
    }),
  openTaskTab: (repoId, task, place) => {
    const s = get();
    const repo = s.repos.find((r) => r.id === repoId);
    if (!repo) return;
    const old = s.terms.find((t) => t.id === task.termId);
    if (!old || old.exit !== undefined) {
      // A tab whose task ended is replaced with a new generation, so its
      // view starts over on the restarted task instead of staying ended.
      const tab: TermTab = { id: task.termId, repoId, name: `${repo.name} · ${task.name}`, path: repo.path, place: old?.place ?? place, task: task.name };
      set({
        terms: old ? s.terms.map((t) => (t.id === task.termId ? { ...tab, gen: (old.gen ?? 0) + 1 } : t)) : [...s.terms, tab],
        hiddenTerms: s.hiddenTerms.filter((h) => h !== task.termId),
      });
    }
    const now = get();
    const tab = now.terms.find((t) => t.id === task.termId);
    if (!tab) return;
    set({
      activeTerm: tab.place === "strip" ? tab.id : now.activeTerm,
      ...(tab.place === "panel"
        ? { ...dockPanel(now, repoId), closedSections: unfoldIn(now.closedSections, repoId, "shell") }
        : {}),
    });
  },
  setLaunch: async (repoId, settings) => {
    const launchers = await api.setLaunch(repoId, settings);
    set((s) => ({ launchers: { ...s.launchers, [backendOf(repoId)]: launchers } }));
  },
  showLaunch: (repoId) =>
    set((s) => ({
      ...dockPanel(s, repoId),
      closedSections: unfoldIn(s.closedSections, repoId, "launch"),
    })),
  stopJob: async (jobId) => {
    const job = await api.stopJob(jobId);
    set((s) => ({ jobs: { ...s.jobs, [job.id]: job } }));
  },
  dismissJob: async (jobId) => {
    await api.dismissJob(jobId);
    set((s) => {
      const { [jobId]: _gone, ...jobs } = s.jobs;
      return { jobs };
    });
  },
  takeWip: async (repoId, peer, branch) => {
    const got = await api.peerAction(repoId, { action: "take", peer, branch });
    applyPeerRepo(get, got);
    return got.take ?? null;
  },
  trackBranch: async (repoId, peer, branch) => {
    applyPeerRepo(get, await api.peerAction(repoId, { action: "track", peer, branch }));
  },
  seedRepo: async (repoId) => {
    applyPeerRepo(get, await api.peerAction(repoId, { action: "seed" }));
  },
  syncPeers: async (repoId) => {
    applyPeerRepo(get, await api.peerAction(repoId, { action: "sync" }));
  },
  showRun: (runId) => {
    // a chat docked as a panel of its own (FR-047) comes forward there
    // instead of over the page, while the dock is the view
    const panel = runPanel(runId);
    const onDock = typeof window !== "undefined" && !new URLSearchParams(window.location.search).get("view");
    if (onDock && get().panels.includes(panel)) get().showPanel(panel);
    else set({ sheet: { kind: "run", runId } });
  },
  closeSheet: () => set({ sheet: null }),
  openSearch: () => set({ sheet: { kind: "search" } }),
  openKeys: (view) => set({ sheet: { kind: "keys", view } }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  searchIn: (repoId, q) =>
    set((s) => ({
      sheet: null,
      pendingSearch: { repoId, q },
      ...dockPanel(s, repoId),
      closedSections: unfoldIn(s.closedSections, repoId, "search"),
    })),
  takePendingSearch: () => set({ pendingSearch: null }),
  showGroup: groupId => set({ sheet: { kind: "group", groupId } }),
  pickRunGroup: async (id, origin) => {
    const group = await api.pickRunGroup(id, origin);
    set(s => ({ landing: withGroup(s.landing, backendOf(id), group) }));
  },
  reviewGroup: async id => {
    const group = await api.reviewGroup(id);
    set(s => ({ landing: withGroup(s.landing, backendOf(id), group) }));
  },
  dropGroup: async (id, keep) => {
    const group = await api.dropGroup(id, keep);
    set(s => ({ landing: withGroup(s.landing, backendOf(id), group) }));
  },
  startGroup: async (repoId, action, note, times, profile, autoLand = false, pr = false) => {
    if (times === 1) return get().startRun(repoId, action, note, true, pr ? true : undefined);
    const group = await api.startGroup(repoId, action, note, times, profile, autoLand, pr);
    const b = backendOf(repoId);
    set(s => {
      const info = s.landing[b] ?? { runs: [], entries: [], orphans: [] };
      return { landing: { ...s.landing, [b]: { ...info, groups: [...(info.groups ?? []).filter(g => g.id !== group.id), group] } }, sheet: { kind: "group", groupId: group.id } };
    });
  },
  startRun: async (repoId, action, note, branch, pr) => {
    const run = await api.run(repoId, action, note, clientId(), branch, pr);
    set((s) => ({
      runs: { ...s.runs, [run.id]: run },
      sheet: { kind: "run", runId: run.id },
    }));
  },
  startWsRun: async (name, action, note) => {
    const run = await api.wsRun(name, action, note);
    set((s) => ({
      runs: { ...s.runs, [run.id]: run },
      sheet: { kind: "run", runId: run.id },
    }));
  },
  answerRun: async (runId, promptId, answer) => {
    const run = await api.answerRun(runId, promptId, answer, get().answerKey);
    set((s) => ({ runs: { ...s.runs, [run.id]: run } }));
  },
  loadRemembered: async () => {
    const order = get().backendOrder;
    const got = await Promise.all(
      order.map((b) =>
        api.remembered(b).then(
          (r) => (Array.isArray(r?.rules) ? ([b, r.rules] as const) : null),
          () => null,
        ),
      ),
    );
    set((s) => ({ remembered: { ...s.remembered, ...Object.fromEntries(got.filter((g) => g !== null)) } }));
  },
  forgetRemembered: async (backend, id) => {
    const { rules } = await api.forgetRemembered(backend, id);
    set((s) => ({ remembered: { ...s.remembered, [backend]: rules } }));
  },
  sayRun: async (runId, text) => {
    const run = await api.say(runId, text);
    set((s) => {
      // a draft once sent is done with
      const { [runId]: _sent, ...chatDrafts } = s.chatDrafts;
      return { runs: { ...s.runs, [run.id]: run }, chatDrafts };
    });
  },
  stopRun: async (runId) => {
    const run = await api.stopRun(runId);
    set((s) => ({ runs: { ...s.runs, [run.id]: run } }));
  },
  coordPlanEdit: (runId, taskId, change) => api.coordTask(runId, taskId, change),
  coordRemove: (runId, taskId) => api.coordTask(runId, taskId, { remove: true }),
  coordStart: (runId) => api.coordStart(runId),
  dismissRun: async (runId) => {
    await api.dismissRun(runId);
    // a chat docked as a panel (FR-047) goes with its run
    const panel = runPanel(runId);
    if (get().panels.includes(panel)) get().closePanel(panel);
    set((s) => {
      const { [runId]: _gone, ...runs } = s.runs;
      const sheet =
        s.sheet?.kind === "run" && s.sheet.runId === runId ? null : s.sheet;
      return { runs, sheet };
    });
  },

  loadWorkflows: async (repoId) => {
    const list = await api.workflows(repoId);
    set((s) => ({ workflows: { ...s.workflows, [repoId]: list } }));
  },
  planFlow: (repoId, workflow) => {
    const active = activeFlowFor(get(), repoId) ?? undefined;
    if (active) {
      set({ sheet: { kind: "flow", flowId: active.id } });
      return;
    }
    const run = activeRunFor(get(), repoId);
    set({ sheet: run ? { kind: "run", runId: run.id } : { kind: "flow-plan", repoId, workflow } });
  },
  startFlow: async (repoId, workflow, note, request) => {
    const flow = await api.startFlow(repoId, workflow, note, request);
    set((s) => ({
      flows: { ...s.flows, [flow.id]: flow },
      flowRuns: { ...s.flowRuns, ...flowRunsOf([flow]) },
      sheet: { kind: "flow", flowId: flow.id },
    }));
  },
  resumeFlow: async (flowId, choice) => {
    const flow = await api.resumeFlow(flowId, choice);
    set((s) => ({ flows: { ...s.flows, [flow.id]: flow }, flowRuns: { ...s.flowRuns, ...flowRunsOf([flow]) } }));
  },
  stopFlow: async (flowId) => {
    const flow = await api.stopFlow(flowId);
    set((s) => ({ flows: { ...s.flows, [flow.id]: flow }, flowRuns: { ...s.flowRuns, ...flowRunsOf([flow]) } }));
  },
  dismissFlow: async (flowId) => {
    await api.dismissFlow(flowId);
    set((s) => {
      const { [flowId]: _gone, ...flows } = s.flows;
      const sheet = s.sheet?.kind === "flow" && s.sheet.flowId === flowId ? null : s.sheet;
      return { flows, sheet };
    });
  },
  showFlow: (flowId) => set({ sheet: { kind: "flow", flowId } }),
  setSelecting: (on) => set({ selecting: on, selected: [], selectAnchor: null }),
  toggleSelected: (repoId, extend = false) =>
    set((s) => {
      const repo = s.repos.find((r) => r.id === repoId);
      if (!repo || !pickable(repo)) return {};
      if (extend && s.selectAnchor && s.selectAnchor !== repoId) {
        // the range takes the anchor's state, so a shift-click after an
        // unpick clears the stretch and one after a pick fills it
        const many = multi(s);
        const order = boardOrder(
          visibleRepos(s),
          s.settings.sort,
          s.collapsed,
          many ? boardChangedAt(s) : undefined,
          many ? boardFavorite(s) : undefined,
        );
        const ids = rangeIds(order, s.selectAnchor, repoId);
        return { selected: setPick(s.selected, ids, s.selected.includes(s.selectAnchor)) };
      }
      return { selected: togglePick(s.selected, [repoId]), selectAnchor: repoId };
    }),
  setSelected: (ids) => set({ selected: ids }),
  pickAll: () => set((s) => ({ selected: pickableIds(s) })),
  pickNone: () => set({ selected: [] }),
  pickInvert: () => set((s) => ({ selected: invertPick(pickedIds(s), pickableIds(s)) })),
  pickGroup: (ids) => set((s) => ({ selected: togglePick(s.selected, ids) })),
  pickFacet: (facet) => set((s) => ({ selected: pickWhere(visibleRepos(s), facet, { healthBad: healthBad(s) }) })),
  planFleet: (workflow) => set({ sheet: { kind: "fleet-plan", workflow } }),
  startFleet: async (workflow, note, request) => {
    // one fleet per backend the picked repos are on; the sheet shows the
    // first. api.startFleet keeps asking every backend even once one has
    // failed, so a partial failure still hands back the fleets that did
    // start (as a PartialFleetError): fold those in and drop their repos
    // from the selection before the error reaches the caller, or a second
    // click would start a second fleet on repos already running one. A
    // full start clears the whole pick, as it always did.
    let started: Fleet[];
    try {
      started = await api.startFleet(workflow, pickedIds(get()), note, request);
    } catch (err) {
      if (err instanceof PartialFleetError) set((s) => foldStartedFleets(s, err.started));
      throw err;
    }
    const first = started[0];
    if (!first) return;
    set((s) => ({
      fleets: { ...s.fleets, ...Object.fromEntries(started.map((f) => [f.id, f])) },
      sheet: { kind: "fleet", fleetId: first.id },
      selecting: false,
      selected: [],
      selectAnchor: null,
    }));
  },
  stopFleet: async (fleetId) => {
    const fleet = await api.stopFleet(fleetId);
    set((s) => ({ fleets: { ...s.fleets, [fleet.id]: fleet } }));
  },
  dismissFleet: async (fleetId) => {
    await api.dismissFleet(fleetId);
    set((s) => {
      const { [fleetId]: _gone, ...fleets } = s.fleets;
      const sheet = s.sheet?.kind === "fleet" && s.sheet.fleetId === fleetId ? null : s.sheet;
      return { fleets, sheet };
    });
  },
  showFleet: (fleetId) => set({ sheet: { kind: "fleet", fleetId } }),
}));

/** Ends the shells behind some tabs on the server. Closing a socket only
 *  detaches, so this is the one way a tab's × hangs a shell up. One that
 *  already exited needs nothing. */
function endShells(tabs: TermTab[]) {
  for (const t of tabs) {
    if (t.exit !== undefined) continue;
    endedShells.add(t.id);
    void api.endTerm(t.id).catch(() => {});
  }
}

/** whether this window is a solo panel or a lone shell rather than the grove:
 *  it has no dock, so what it holds in `panels` is a copy of the grove's
 *  (plus any panel a shell opened here) and must not be written back */
/** a window that shows one panel or one section, which has no shells strip */
function loneWindow(): boolean {
  const route = parseRoute(window.location.search);
  return route.solo || route.section !== null;
}

export function dockless(): boolean {
  if (typeof window === "undefined") return false;
  const route = parseRoute(window.location.search);
  return route.solo || route.shell || route.section !== null || route.agent !== null;
}

/** The latest clips, for tailchan's "copy the latest", whether or not this
 *  handle follows the clipboard channel. */
function readClips(): void {
  void api
    .chanRead("#clipboard", 5)
    .then((msgs) => useStore.setState((st) => ({ chanMsgs: { ...st.chanMsgs, clipboard: mergeMessages(st.chanMsgs["clipboard"], msgs) } })))
    .catch(() => {});
}

// A strip shell coming forward (a new one, a join, a move) takes the strip
// back from a section tab showing there (FR-030), so no action that sets
// activeTerm has to remember to.
useStore.subscribe((s, prev) => {
  if (s.stripPage !== null && s.activeTerm !== null && s.activeTerm !== prev.activeTerm) useStore.setState({ stripPage: null });
});

// Whatever part of the layout a change touched is written as it happens, so
// no action has to remember to. Only the changed fields go: see saveLayout.
useStore.subscribe((s, prev) => {
  const patch = changed(layoutOf(s), layoutOf(prev));
  if (dockless()) {
    delete patch.panels;
    delete patch.dockLayout;
    delete patch.activePanel;
    delete patch.popped;
    delete patch.terms;
    delete patch.activeTerm;
  }
  if (Object.keys(patch).length > 0) saveLayout(patch);
});

// A window moved to another screen takes up the sizes and gear choices kept
// for that kind of screen (screens.ts). Chrome fires resize when a window crosses to a screen
// of another size, and the screen's own change event where it has one.
let screenSeen = slotsNow().join();
if (typeof window !== "undefined" && typeof window.screen !== "undefined") {
  const onScreen = () => {
    const now = slotsNow().join();
    if (now === screenSeen) return;
    screenSeen = now;
    // asked before anything is written under the new slot: the setState
    // below writes the layout it loads there
    const fresh = writesFlat() && neverArranged(storedLayout(), slotsNow()[0]);
    const layout = loadLayout();
    const settings = loadSettings();
    const sizes: Partial<Layout> = {};
    for (const k of SCREEN_LAYOUT) Object.assign(sizes, { [k]: layout[k] });
    const sized: Partial<Settings> = {};
    for (const k of SCREEN_SETTINGS) Object.assign(sized, { [k]: settings[k] });
    useStore.setState((s) => ({ ...sizes, settings: { ...s.settings, ...sized } }));
    // A screen this browser has never arranged takes the profile that fits
    // it. One arranged before keeps its own; Settings offers the rest.
    const here = fresh ? screenHere(deviceHere(settings.device)) : null;
    const match = here ? matchProfile(useStore.getState().screenProfiles, here) : null;
    if (match) useStore.getState().applyScreenLayout(match.profile.layout);
  };
  window.addEventListener("resize", onScreen);
  // not in this TS's DOM types yet: Chrome's Window Management API
  (window.screen as Partial<EventTarget>).addEventListener?.("change", onScreen);
}

/** The panels whose tasks this page has asked to start, so each open of a
 *  panel asks once: by any path that adds it to the dock (a click, the top
 *  bar's open, a shell or search landing there) and once per page load for
 *  the panels a reload brings back, once their repo is known. Closing a
 *  panel forgets it, so the next open asks again. */
const panelsStarted = new Set<string>();

useStore.subscribe((s, prev) => {
  if (s.panels === prev.panels && s.repos === prev.repos) return;
  // a solo or shell window holds the grove's panels, not panels of its own
  if (dockless()) return;
  for (const id of panelsStarted) if (!s.panels.includes(id)) panelsStarted.delete(id);
  for (const id of s.panels) {
    if (panelsStarted.has(id) || !s.repos.some((r) => r.id === id)) continue;
    panelsStarted.add(id);
    s.startPanelTasks(id);
  }
});

/** The panels that have had their shell opened on their own since they
 *  last opened: closing a panel forgets it, so the next open looks again,
 *  and closing the shell's tab leaves the open panel without one. */
const panelsShelled = new Set<string>();

useStore.subscribe((s, prev) => {
  if (s.panels === prev.panels && s.repos === prev.repos && s.shells === prev.shells) return;
  if (dockless()) return;
  for (const id of panelsShelled) if (!s.panels.includes(id)) panelsShelled.delete(id);
  for (const id of s.panels) {
    if (panelsShelled.has(id)) continue;
    // the repo lands in the same set as its backend's shell list, so a
    // known repo means held shells are already adopted or listed
    const repo = s.repos.find((r) => r.id === id);
    if (!repo || repo.forge || repo.host || repo.error) continue;
    if (!isOnline(s, backendOf(id))) continue;
    panelsShelled.add(id);
    if (!needsPanelShell(s.terms, s.shells, id)) continue;
    // Not through openTerm: that focuses the panel, and a reload that brings
    // back three panels would end on whichever was shelled last.
    const tab: TermTab = {
      id: qual(backendOf(id), termId()),
      repoId: id,
      name: repo.name,
      path: repo.path,
      place: "panel",
      ...(panelShellStart(s.settings.level, id) ? { start: "agent" as const } : {}),
    };
    useStore.setState((t) => ({ terms: [...t.terms, tab], closedSections: unfoldIn(t.closedSections, id, "shell") }));
  }
});

// `panels` is always `panelsOf(dockLayout)`. Every action writes both; this
// is the net for the rest. A layout that changed alone (another screen's,
// read by the handler above) leads, and the open set takes its order once
// it is placed over this window's panels. Panels set alone (a test, a
// write from outside the actions) lead, and the layout follows them; a
// list reordered that way rebuilds the layout flat, losing its splits, so a
// new writer of the open set goes through the layout instead. It is
// registered after every other subscription, the layout's save among
// them, so the run of them that comes last, the nested one, sees the
// reconciled pair.
useStore.subscribe((s, prev) => {
  if (s.panels === prev.panels && s.dockLayout === prev.dockLayout) return;
  if (sameList(panelsOf(s.dockLayout), s.panels)) return;
  const dockLayout =
    s.panels === prev.panels ? placeAll(s.dockLayout, s.panels, s.activePanel, arrangementOf(s), widthOf(s)) : laidOut(s);
  const panels = panelsOf(dockLayout);
  useStore.setState(sameList(panels, s.panels) ? { dockLayout } : { dockLayout, panels });
});

/** The run a repo's card should talk about: a live one first, else the most
 *  recent finished one still on the server. */
export function runFor(s: CanopyState, repoId: string): Run | undefined {
  let best: Run | undefined;
  for (const r of Object.values(s.runs)) {
    if (!ownRun(s.flowRuns, r)) continue;
    if (r.repoId !== repoId) continue;
    if (!best) {
      best = r;
      continue;
    }
    const a = isRunActive(r);
    const b = isRunActive(best);
    if (a !== b ? a : r.startedAt > best.startedAt) best = r;
  }
  return best;
}

export function activeRunFor(s: CanopyState, repoId: string): Run | undefined {
  const r = runFor(s, repoId);
  if (!r || !isRunActive(r)) return undefined;
  if (!isCoordinator(r)) return r;
  // A coordinator holds no repo, as on the server: the run going there is
  // the newest other one, if any.
  let best: Run | undefined;
  for (const o of Object.values(s.runs)) {
    if (o.repoId !== repoId || isCoordinator(o) || !isRunActive(o) || !ownRun(s.flowRuns, o)) continue;
    if (!best || o.startedAt > best.startedAt) best = o;
  }
  return best;
}

/** The coordinator going at a repo, one at a time (FR-010). */
export function coordinatorFor(s: CanopyState, repoId: string): Run | undefined {
  for (const r of Object.values(s.runs)) {
    if (r.repoId === repoId && isCoordinator(r) && isRunActive(r)) return r;
  }
  return undefined;
}

/** A repo's newest flow in its checkout, active first. A flow on a branch
 *  of its own (a trigger's) is not the checkout's, as on the server, so it
 *  never holds the card's controls; the triggers view shows it. */
export function flowFor(s: CanopyState, repoId: string): Flow | undefined {
  let best: Flow | undefined;
  for (const f of Object.values(s.flows)) {
    if (f.repoId !== repoId || f.branch) continue;
    if (!best || (isFlowActive(f) && !isFlowActive(best)) || (isFlowActive(f) === isFlowActive(best) && f.startedAt > best.startedAt)) best = f;
  }
  return best;
}

export function activeFlowFor(s: CanopyState, repoId: string): Flow | undefined {
  const f = flowFor(s, repoId);
  return f && isFlowActive(f) ? f : undefined;
}

/** All runs, newest first. */
export function allRuns(s: CanopyState): Run[] {
  return Object.values(s.runs).sort((a, b) => b.startedAt - a.startedAt);
}

/** One backend's connection, home's unless named; a fixed stand-in for one
 *  not known yet, so a selector over it is stable. */
export const connOf = (s: Pick<CanopyState, "conns" | "home">, name: string = s.home): Conn => s.conns[name] ?? NO_CONN;

/** The home backend's connection. */
export const homeConn = (s: Pick<CanopyState, "conns" | "home">): Conn => connOf(s, s.home);

/** Whether a backend answers now. */
export const isOnline = (s: Pick<CanopyState, "conns" | "home">, name: string): boolean =>
  connOf(s, name).status.state === "online";

/** Whether this page shows more than one backend. */
export const multi = (s: Pick<CanopyState, "backendOrder">): boolean => s.backendOrder.length > 1;

/** What this browser can open on a backend and through what: its chosen
 *  helper, the one at its address, the backend's own Mac, or nothing. */
export const capsFor = (s: CanopyState, name: string = s.home): ClientCaps => {
  const c = connOf(s, name);
  return clientCaps(c.client, c.helpers, s.settings.helper);
};

/** The helper name an open request to a backend carries: the one `capsFor`
 *  settled on, or none when the backend's own desktop (or nothing) is what
 *  opens. */
export const helperFor = (s: CanopyState, name: string = s.home): string | undefined => capsFor(s, name).helper?.name;

/** A backend's agent routing, an empty one until it has loaded. */
export const routesOf = (s: CanopyState, backend: string): AgentRoutes => s.agents[backend] ?? NO_ROUTES;

/** The settings a repo gets for a role on its own backend (an interactive
 *  shell unless said), through every layer of core/route. The object is
 *  the routing's own, so a selector over it settles. */
export const agentFor = (s: CanopyState, repo: Repo, role: AgentRole = "shell", scope?: AgentScope): AgentSettings =>
  resolveAgent(routesOf(s, backendOf(repo.id)), repo.path, role, undefined, scope).settings;

/** What a launch pick puts on a tab: the harness it names, or the
 *  profile. */
function pickFields(pick: LaunchPick | undefined): Pick<TermTab, "harness" | "profile"> {
  if (!pick) return {};
  return "profile" in pick ? { profile: pick.profile } : { harness: pick.harness };
}

/** The repo's launch settings on its own backend, the defaults when it has none. */
export const launchFor = (s: CanopyState, repo: Repo): LaunchSettings =>
  s.launchers[backendOf(repo.id)]?.[repo.path] ?? DEFAULT_LAUNCH;

/** The repo's jobs, newest first. Callers select through useShallow. */
export function jobsFor(s: CanopyState, repoId: string): Job[] {
  return Object.values(s.jobs)
    .filter((j) => j.repoId === repoId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** repos in the active workspace, archived ones included. A forge repo
 *  that is already cloned here is the same repo as the card next to it, so
 *  unless the setting says otherwise only the ones missing locally get one.
 *  A workspace is the home backend's, so it holds only home's checkouts. */
function inScope(s: CanopyState): Repo[] {
  const all =
    s.settings.forge === "all"
      ? s.repos
      : s.repos.filter((r) => r.forge?.clonedAs === undefined);
  if (!s.activeWs) return all;
  const ws = s.workspaces.find((w) => w.name === s.activeWs);
  return ws ? all.filter((r) => isHome(r.id) && ws.repos.includes(r.path)) : all;
}

/** repos in the active workspace, before any filter, less the archived
 *  ones unless the setting shows them */
export function scopedRepos(s: CanopyState): Repo[] {
  const all = inScope(s);
  return s.settings.hideArchived ? all.filter((r) => !r.archived) : all;
}

/** how many repos in the workspace are archived, shown or not */
export function archivedCount(s: CanopyState): number {
  return inScope(s).filter((r) => r.archived).length;
}

/** `next` itself, or `prev` when it holds the same things in the same
 *  order, so a selector over it settles */
function same<T>(prev: readonly T[] | null, next: T[]): T[] {
  return prev !== null && prev.length === next.length && prev.every((x, i) => x === next[i]) ? (prev as T[]) : next;
}

/* The board's cards, memoized on what they are made of. One store per page,
   so one slot per selector; a card whose checkouts did not move is the same
   object as before, so a repo event re-renders one card, not all of them. */
let cardsIn: { repos: Repo[]; forge: unknown; archived: boolean; ws: string | null; wss: unknown; order: string[] } | null = null;
let cardsOut: RepoCard[] = [];
let cardsByKey = new Map<string, RepoCard>();
let cardIndex = new Map<string, RepoCard>();

/** Every repo in scope as a card: one per repo, with its checkouts on every
 *  backend. With one backend, one card per repo in scan order. */
export function allCards(s: CanopyState): RepoCard[] {
  const c = cardsIn;
  if (
    c &&
    c.repos === s.repos &&
    c.forge === s.settings.forge &&
    c.archived === s.settings.hideArchived &&
    c.ws === s.activeWs &&
    c.wss === s.workspaces &&
    c.order === s.backendOrder
  )
    return cardsOut;
  const reg = registry();
  const fresh = joinRepos(scopedRepos(s), s.backendOrder, (id) => split(reg, id));
  const byKey = new Map<string, RepoCard>();
  const out = fresh.map((card) => {
    const old = cardsByKey.get(card.key);
    const keep = old && old.name === card.name && old.checkouts.length === card.checkouts.length && old.checkouts.every((x, i) => x === card.checkouts[i]);
    const it = keep ? old : card;
    byKey.set(it.key, it);
    return it;
  });
  cardsIn = { repos: s.repos, forge: s.settings.forge, archived: s.settings.hideArchived, ws: s.activeWs, wss: s.workspaces, order: s.backendOrder };
  cardsOut = same(cardsOut, out);
  cardsByKey = byKey;
  cardIndex = new Map(cardsOut.flatMap((card) => card.checkouts.map((r) => [r.id, card] as const)));
  return cardsOut;
}

/* Every repo as a card, whatever the workspace and the archived filter
   leave on the board: a panel stays open on a repo the board has scoped
   out, and its agents are still its own. Memoized like `allCards`. */
let everyIn: { repos: Repo[]; forge: unknown; order: string[] } | null = null;
let everyOut: RepoCard[] = [];
let everyIndex = new Map<string, RepoCard>();

function everyCard(s: CanopyState): RepoCard[] {
  const c = everyIn;
  if (c && c.repos === s.repos && c.forge === s.settings.forge && c.order === s.backendOrder) return everyOut;
  const reg = registry();
  // a forge repo already cloned here is the card beside it, as on the board
  const repos = s.settings.forge === "all" ? s.repos : s.repos.filter((r) => r.forge?.clonedAs === undefined);
  everyOut = joinRepos(repos, s.backendOrder, (id) => split(reg, id));
  everyIn = { repos: s.repos, forge: s.settings.forge, order: s.backendOrder };
  everyIndex = new Map(everyOut.flatMap((card) => card.checkouts.map((r) => [r.id, card] as const)));
  return everyOut;
}

let agentsIn: { registry: Record<string, AgentCard>; cards: RepoCard[] } | null = null;
let agentsOut = new Map<string, AgentCard[]>();
const NO_AGENTS: AgentCard[] = [];

/** Every repo card's agents from the registry, by card key, running first;
 *  worked out once per registry or repo change, over every repo rather
 *  than the board's scoped cards. */
export function agentsByCard(s: CanopyState): Map<string, AgentCard[]> {
  const cards = everyCard(s);
  if (agentsIn && agentsIn.registry === s.registry && agentsIn.cards === cards) return agentsOut;
  agentsIn = { registry: s.registry, cards };
  agentsOut = cardsByRepoCard(cards, Object.values(s.registry), backendOf);
  return agentsOut;
}

/** the agents on the card a checkout is on, anywhere, archived or out of
 *  the workspace or not; a stable array, so a selector over it settles */
export function agentsOn(s: CanopyState, repoId: string): AgentCard[] {
  everyCard(s);
  const card = everyIndex.get(repoId);
  return (card && agentsByCard(s).get(card.key)) || NO_AGENTS;
}

/** what a write that needs an answer key says without one */
const NO_KEY = "no answer key on this device: add yours in Settings";

/** whether this page can answer an ask: the home backend follows asks and
 *  this browser holds an answer key */
export const canAnswer = (s: Pick<CanopyState, "asksReady" | "answerKey">): boolean => s.asksReady && s.answerKey !== null;

/** how often the page's own activity tells the broker the human is here */
const PAGE_BEAT = 60_000;
let lastPageBeat = 0;

let inboxIn: {
  asks: Record<string, Ask>;
  runs: Record<string, Run>;
  flows: Record<string, Flow>;
  repos: Repo[];
  registry: Record<string, AgentCard>;
  sprouts: Record<string, Sprout>;
  advice: AdviceOffer[];
  landing: Record<string, LandingInfo>;
  prs: Record<string, PrWatch[]>;
  auth: Record<string, BackendAuth>;
  sweep: SweepInfo | null;
} | null = null;
let inboxOut: InboxItem[] = [];

/** Everything waiting on the human, oldest first: the home broker's open
 *  asks, the incubator's questions, every backend's runs on a prompt and flows at a gate. Worked out
 *  once per change of what it reads, so a selector over it settles; a
 *  countdown keeps its own time off each item's `until`. */
export function inboxItems(s: CanopyState): InboxItem[] {
  if (inboxIn && inboxIn.asks === s.asks && inboxIn.runs === s.runs && inboxIn.flows === s.flows && inboxIn.repos === s.repos && inboxIn.registry === s.registry && inboxIn.sprouts === s.sprouts && inboxIn.advice === s.advice && inboxIn.landing === s.landing && inboxIn.prs === s.prs && inboxIn.auth === s.authByBackend && inboxIn.sweep === s.sweep) {
    return inboxOut;
  }
  inboxIn = { asks: s.asks, runs: s.runs, flows: s.flows, repos: s.repos, registry: s.registry, sprouts: s.sprouts, advice: s.advice, landing: s.landing, prs: s.prs, auth: s.authByBackend, sweep: s.sweep };
  inboxOut = mergeInbox(Object.values(s.asks), s.runs, s.flows, Date.now(), {
    repos: s.repos,
    cards: s.registry,
    backendOf: (id) => (s.backendOrder.length > 1 ? backendOf(id) : ""),
    askRepos: s.repos.filter((r) => backendOf(r.id) === s.home),
    sprouts: Object.values(s.sprouts),
    advice: s.advice,
    landing: landingAll(s),
    prs: prsAll(s),
    pairs: pairsOf(s.authByBackend),
    sweep: s.sweep,
  });
  return inboxOut;
}

let harnessNoticeIn: { history: HistoryOverview | null; cards: RepoCard[]; max: number; said: string | null } | null = null;
let harnessNoticeOut: HarnessNotice | null = null;

/** The quiet weekly line for the newest full archive week. Memoized on the
 *  same inputs it reads so subscriptions stay settled between changes. */
export function harnessNoticeOf(s: CanopyState): HarnessNotice | null {
  const cards = allCards(s);
  const max = s.settings.harnessShareMax;
  if (harnessNoticeIn && harnessNoticeIn.history === s.history && harnessNoticeIn.cards === cards && harnessNoticeIn.max === max && harnessNoticeIn.said === s.harnessSaid) {
    return harnessNoticeOut;
  }
  harnessNoticeIn = { history: s.history, cards, max, said: s.harnessSaid };
  harnessNoticeOut = harnessNotice(harnessWeeks(s.history, cards), harnessNames(cards), max, s.harnessSaid);
  return harnessNoticeOut;
}

let attentionIn: { repos: Repo[]; settings: Settings; ws: string | null; workspaces: Workspace[]; landing: Record<string, LandingInfo> } | null = null;
let attentionOut: AttentionRow[] = [];

/** The repos in scope that need you, the most pressing first, for the
 *  "waiting on you" panel; worked out once per change of what it reads. */
export function attentionItems(s: CanopyState): AttentionRow[] {
  const a = attentionIn;
  if (a && a.repos === s.repos && a.settings === s.settings && a.ws === s.activeWs && a.workspaces === s.workspaces && a.landing === s.landing) return attentionOut;
  attentionIn = { repos: s.repos, settings: s.settings, ws: s.activeWs, workspaces: s.workspaces, landing: s.landing };
  attentionOut = attentionRepos(scopedRepos(s), landingAll(s).collisions ?? []);
  return attentionOut;
}

let behindIn: { repos: Repo[]; settings: Settings; ws: string | null; workspaces: Workspace[] } | null = null;
let behindOut: BehindRow[] = [];

/** The clean repos in scope behind their upstream, for the panel's folded
 *  "behind" group, which the panel's count leaves out as it does unpushed. */
export function behindItems(s: CanopyState): BehindRow[] {
  const b = behindIn;
  if (b && b.repos === s.repos && b.settings === s.settings && b.ws === s.activeWs && b.workspaces === s.workspaces) return behindOut;
  behindIn = { repos: s.repos, settings: s.settings, ws: s.activeWs, workspaces: s.workspaces };
  behindOut = behindRepos(scopedRepos(s));
  return behindOut;
}

let failedIn: {
  runs: Record<string, Run>;
  flowRuns: Record<string, string>;
  tasks: TaskInfo[];
  rangers: Record<string, RangerInfo>;
  health: Record<string, HealthCheck[]>;
} | null = null;
let failedOut: FailedRow[] = [];

/** The runs, tasks, rangers and health checks that failed, newest first,
 *  for the same panel. */
export function failedItems(s: CanopyState): FailedRow[] {
  const f = failedIn;
  if (f && f.runs === s.runs && f.flowRuns === s.flowRuns && f.tasks === s.taskAll && f.rangers === s.rangers && f.health === s.health) return failedOut;
  failedIn = { runs: s.runs, flowRuns: s.flowRuns, tasks: s.taskAll, rangers: s.rangers, health: s.health };
  const health = Object.entries(s.health).flatMap(([backend, checks]) => checks.map((check) => ({ backend, check })));
  failedOut = failedRows(Object.values(s.runs), s.flowRuns, s.taskAll, Object.entries(s.rangers), health);
  return failedOut;
}

let turnIn: {
  runs: Record<string, Run>;
  flowRuns: Record<string, string>;
  registry: Record<string, AgentCard>;
  asks: Record<string, Ask>;
  repos: Repo[];
  rangers: Record<string, RangerInfo>;
  landing: Record<string, LandingInfo>;
} | null = null;
let turnOut: TurnRow[] = [];

/** The chats and terminal agents whose turn it is, for the same panel; a
 *  ranger's card is left out, since it is reached by DM and sits at its
 *  prompt by design (a permission it waits on is in the inbox). */
export function turnItems(s: CanopyState): TurnRow[] {
  const t = turnIn;
  if (t && t.runs === s.runs && t.flowRuns === s.flowRuns && t.registry === s.registry && t.asks === s.asks && t.repos === s.repos && t.rangers === s.rangers && t.landing === s.landing) return turnOut;
  turnIn = { runs: s.runs, flowRuns: s.flowRuns, registry: s.registry, asks: s.asks, repos: s.repos, rangers: s.rangers, landing: s.landing };
  const rangers = rangerSessions(s.rangers);
  const cards = Object.values(s.registry).filter((c) => c.session === null || !rangers.has(c.session));
  turnOut = turnRows(Object.values(s.runs), s.flowRuns, cards, Object.values(s.asks), s.repos, landingAll(s));
  return turnOut;
}

/** how many things in the "waiting on you" panel need you now: everything
 *  it lists but the unpushed commits, which can wait */
export const waitingCount = (s: CanopyState): number =>
  turnItems(s).length + inboxItems(s).length + attentionItems(s).filter((r) => !isUnpushed(r)).length + failedItems(s).length;

/** the page's load and each backend's connection state, which the burst
 *  guard in notify.ts re-seeds on whenever it changes */
const connSign = (s: CanopyState): string => [s.loaded ? "1" : "0", ...s.backendOrder.map((b) => `${b}=${connOf(s, b).status.state}`)].join("|");

let notifyWatch: Watch | null = null;
let notifyIn: { turns: TurnRow[]; inbox: InboxItem[]; failed: FailedRow[]; runs: Record<string, Run>; repos: Repo[]; conns: string } | null = null;

/** A system notification whose click brings this window up on the repo. */
function showNote(n: Notice): void {
  const shown = new Notification(n.title, { body: n.body, tag: n.key });
  shown.onclick = () => {
    window.focus();
    const s = useStore.getState();
    if (n.groupId) s.showGroup(n.groupId);
    else if (n.repoId && s.repos.some((r) => r.id === n.repoId)) s.openPanel(n.repoId);
    shown.close();
  };
}

// System notifications and the title's count (notify.ts). Every window
// counts in its title; only the grove notifies, so a solo or shell window
// open beside it never shows the same one twice. The snapshot follows along
// with notify off too, so turning it on never bursts.
useStore.subscribe((s) => {
  setTitleCount(s.settings.notify ? waitingCount(s) : 0);
  if (dockless()) return;
  const turns = turnItems(s);
  const inbox = inboxItems(s);
  const failed = failedItems(s);
  const conns = connSign(s);
  const n = notifyIn;
  if (n && n.turns === turns && n.inbox === inbox && n.failed === failed && n.runs === s.runs && n.repos === s.repos && n.conns === conns) return;
  notifyIn = { turns, inbox, failed, runs: s.runs, repos: s.repos, conns };
  const names = new Map(s.repos.map((r) => [r.id, r.name]));
  const next = snapshot({ turns, inbox, failed, runs: Object.values(s.runs) }, (id) => names.get(id) ?? "");
  const step = watch(notifyWatch, next, conns, Date.now());
  notifyWatch = step.watch;
  if (step.notes.length === 0 || !s.settings.notify || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted" || !document.hidden) return;
  for (const note of step.notes) showNote(note);
});

/** The card a checkout is on, whichever checkout of it. */
export function cardOf(s: CanopyState, repoId: string): RepoCard | undefined {
  allCards(s);
  return cardIndex.get(repoId);
}

let badIn: CanopyState["health"] | null = null;
let badOut: ReadonlySet<string> = new Set();

/** the qualified ids of the repos with a health check down or given up */
export function healthBad(s: Pick<CanopyState, "health">): ReadonlySet<string> {
  if (badIn !== s.health) {
    badIn = s.health;
    badOut = badRepoIds(s.health);
  }
  return badOut;
}

let viewIn: { cards: RepoCard[]; filters: unknown; users: unknown; attention: boolean; favorites: boolean; text: string; bad: ReadonlySet<string> } | null =
  null;
let viewOut: RepoCard[] = [];

/** The cards the filters leave: a card is in view when any of its
 *  checkouts passes. Callers select through useShallow. */
export function visibleCards(s: CanopyState): RepoCard[] {
  const cards = allCards(s);
  const v = viewIn;
  if (
    v &&
    v.cards === cards &&
    v.filters === s.filters &&
    v.users === s.users &&
    v.attention === s.dirtyOnly &&
    v.favorites === s.favoritesOnly &&
    v.text === s.filter &&
    // the health facet alone reads it: a check's tick does not rebuild the view
    (v.bad === healthBad(s) || !s.filters.includes("health"))
  )
    return viewOut;
  const bad = healthBad(s);
  const q = { filters: s.filters, users: s.users, attention: s.dirtyOnly, favorites: s.favoritesOnly, text: s.filter, healthBad: bad };
  viewIn = { cards, filters: s.filters, users: s.users, attention: s.dirtyOnly, favorites: s.favoritesOnly, text: s.filter, bad };
  viewOut = same(viewOut, cards.filter((card) => applyQuery(card.checkouts, q, plainOf).length > 0));
  return viewOut;
}

let leadIn: { cards: RepoCard[]; pref: Record<string, string>; online: string } | null = null;
let leadOut: Repo[] = [];

/** The checkout each card in view shows and opens: see `leadOf`. With one
 *  backend, the repos the filters leave, as they always were. Callers
 *  select through useShallow. */
export function visibleRepos(s: CanopyState): Repo[] {
  const cards = visibleCards(s);
  const online = s.backendOrder.map((b) => (isOnline(s, b) ? "1" : "0")).join("");
  const l = leadIn;
  if (l && l.cards === cards && l.pref === s.checkoutPref && l.online === online) return leadOut;
  leadIn = { cards, pref: s.checkoutPref, online };
  leadOut = same(
    leadOut,
    cards.map((card) => leadOf(card, s.checkoutPref[card.key], (b) => isOnline(s, b), backendOf)),
  );
  return leadOut;
}

/** When a repo last changed, for the board's grouping: its card's newest
 *  checkout's change, which is its own with one backend. */
export function boardChangedAt(s: CanopyState): (r: Repo) => number {
  return (r) => {
    const card = cardOf(s, r.id);
    return card ? cardChangedAt(card) : changedAt(r);
  };
}

/** Whether a repo is starred, for the board's grouping: whether any
 *  checkout on its card is, which is its own star with one backend. */
export function boardFavorite(s: CanopyState): (r: Repo) => boolean {
  return (r) => {
    const card = cardOf(s, r.id);
    return card ? cardFavorite(card) : r.favorite === true;
  };
}

/** Whether the card a repo is on is starred; a boolean, so a selector over
 *  it settles. */
export function isFavorite(s: CanopyState, repoId: string): boolean {
  const card = cardOf(s, repoId);
  return card ? cardFavorite(card) : s.repos.some((r) => r.id === repoId && r.favorite === true);
}

/** Whether the card a repo is on counts as the harness. */
export function isHarness(s: CanopyState, repoId: string): boolean {
  const card = cardOf(s, repoId);
  return card ? isHarnessCard(card) : s.repos.some((r) => r.id === repoId && r.harness === true);
}

/** how many cards in the workspace are starred */
export function favoriteCount(s: CanopyState): number {
  return allCards(s).filter(cardFavorite).length;
}

/** how many repos the "needs attention" toggle would keep */
export function attentionCount(s: CanopyState): number {
  return scopedRepos(s).filter(needsAttention).length;
}

/** how many chips the filter menu has lit */
export function activeFilterCount(s: CanopyState): number {
  return s.filters.length + s.users.length + (s.favoritesOnly ? 1 : 0);
}


/** The ids a fleet could be pointed at right now: pickable and in view.
 *  Callers select through useShallow. */
export function pickableIds(s: CanopyState): string[] {
  return selectable(visibleRepos(s)).map((r) => r.id);
}

/** The picked repos the view still shows. A pick survives a filter that
 *  hides it and comes back when the filter goes, but never rides along on a
 *  fleet or the count unseen. Callers select through useShallow. */
export function pickedIds(s: CanopyState): string[] {
  const have = new Set(s.selected);
  return pickableIds(s).filter((id) => have.has(id));
}

/** Fold newly started fleets into the store: their entries added, and their
 *  repos dropped from the selection. Used on a full start and, through a
 *  `PartialFleetError`, on one that reached some backends and not others,
 *  so a second click after a partial failure only asks the backends that
 *  still have not started one. */
export function foldStartedFleets(
  s: Pick<CanopyState, "fleets" | "selected">,
  started: readonly Fleet[],
): Pick<CanopyState, "fleets" | "selected"> {
  if (started.length === 0) return s;
  const ids = new Set(started.flatMap((f) => f.repos.map((r) => r.repoId)));
  return {
    fleets: { ...s.fleets, ...Object.fromEntries(started.map((f) => [f.id, f])) },
    selected: s.selected.filter((id) => !ids.has(id)),
  };
}

const NO_TASKS: TaskInfo[] = [];
/** a repo's tasks as last read or told; a stable empty list when none */
export const tasksOf = (s: CanopyState, repoId: string): TaskInfo[] => s.tasks[repoId] ?? NO_TASKS;

let landingIn: Record<string, LandingInfo> | null = null;
let landingOut: LandingInfo = { runs: [], entries: [], orphans: [] };

/** Every backend's landing queue as one, worked out once per change. */
export function landingAll(s: Pick<CanopyState, "landing">): LandingInfo {
  if (landingIn !== s.landing) {
    landingIn = s.landing;
    landingOut = mergeLanding(s.landing);
  }
  return landingOut;
}

let prsIn: Record<string, PrWatch[]> | null = null;
let prsOut: PrWatch[] = [];

/** Every backend's PRs as one list, worked out once per change. */
export function prsAll(s: Pick<CanopyState, "prs">): PrWatch[] {
  if (prsIn !== s.prs) {
    prsIn = s.prs;
    prsOut = mergePrs(s.prs);
  }
  return prsOut;
}

/** The pair requests the inbox shows: each backend's where this page holds
 *  a page token, the one kind of caller that may approve them. */
export function pairsOf(auth: Record<string, BackendAuth>): Record<string, PendingPair[]> {
  const out: Record<string, PendingPair[]> = {};
  for (const [b, a] of Object.entries(auth)) if (a.you === "page" && a.pending.length) out[b] = a.pending;
  return out;
}

/** Whether the top bar offers to sign in to a backend: its check is on, it
 *  does not know this page, and this page holds no token for it or a call
 *  was just refused for want of one. */
export const wantsSignIn = (a: BackendAuth | undefined): boolean =>
  a !== undefined && a.mode !== "off" && a.you === "none" && (!a.hasToken || a.needed);

// another window of this browser left or sent notes: show them here too
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === REVIEW_NOTES_STORE || e.key === null) useStore.setState({ reviewNotes: loadNotes() });
  });
}

/** A mutation can arrive before its SSE update, including immediately after fanout. */
function withGroup(byBackend: Record<string, LandingInfo>, backend: string, group: RunGroup): Record<string, LandingInfo> {
  const info = byBackend[backend] ?? { runs: [], entries: [], orphans: [] };
  return { ...byBackend, [backend]: { ...info, groups: [...(info.groups ?? []).filter(g => g.id !== group.id), group] } };
}

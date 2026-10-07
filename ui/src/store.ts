import { create } from "zustand";
import { api, onBackendSignal, PartialFleetError, resolveBase, subscribe } from "./api";
import { backendOf, homeName, isHome, plainOf, qual, registry, setBase, setRegistry } from "./registry";
import { backendState, RETRY_FIRST, retryWait, sliceIn, split, type BackendStatus, type Reg } from "./backends";
import { mergeHistory } from "./qualify";
import { applyQuery, type RepoFilter } from "./filters";
import { cardChangedAt, cardFavorite, joinRepos, leadOf, type RepoCard } from "./checkouts";
import { changedAt } from "./grouping";
import { focusPanel, movePanel as moveIn, nextActive } from "./dock";
import { heldShellUrl, openElsewhere, openShellElsewhere, parseRoute, popOutWindow, soloUrl } from "./routes";
import { poppedOf, restorePanel, without } from "./panes";
import { loadSettings, saveSettings, SCREEN_SETTINGS, shellPlace, type Settings, type ShellPlace } from "./settings";
import { PANEL_TERM_ROWS, adoptPoppedTerms, adoptTerms, loadFocusSize, loadTermTabs, needsPanelShell, nextStripTab, panelShellStart, reconcileTerms, rowsPx, termId, type FocusSize, type TermTab } from "./term";
import { clearTask, frontForTab, frontForTask, keepFront, projectFront, withSolo, type BenchPane, type Front } from "./front";
import { clientId, identity } from "./client";
export type { TermTab } from "./term";
import { clamp, needsAttention } from "./util";
import { beat } from "./live";
import { ownRun, pickable, selectable } from "./flows";
import { boardOrder, invertPick, pickWhere, rangeIds, setPick, togglePick } from "./select";
import { appendFeed, describeEvent, type FeedEntry, type FeedSnapshot } from "./feed";
import { mergeAction } from "./peers";
import { convOf, isUnread, mergeMessages } from "./chan";
import type { AdviceAccepted, AdviceOffer, AgentCard, Ask, ChanMessage, IncubatorStages, Presence, Sprout, TailchanInfo } from "../../src/core/types";
import { mergeAsks, mergeInbox, replaceAsks, toAskAnswer, toRunAnswer, type InboxAnswer, type InboxItem } from "./inbox";
import { replaceSprouts, staleSprout } from "./sprouts";
import { cardsByRepoCard, markTrail, mergeCards, replaceCards, type TrailMark } from "./agentcards";
import { clientCaps } from "../../src/core/client";
import { normalizeRoutes, resolveAgent } from "../../src/core/route";
import { flatAgent, hasRouting, NO_ROUTES } from "./agents";
import { cleanKey, keyTestOf, readAnswerKey, writeAnswerKey, type KeyTest } from "./answerKey";
import { listedTask } from "../../src/core/tasks";
import { startsDev } from "./tasks";
import { putScreen, slotsNow, withScreen, writesFlat } from "./screens";
import {
  DEFAULT_LAUNCH,
  effectivePrimary,
  isFlowActive,
  isRunActive,
  type About,
  type AgentPick,
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
/** a dock panel; the room the cards leave caps it before max does (`dockRoom`) */
export const PANEL = { min: 240, max: 2400, initial: 440 };
/** the dock when it is one tabbed panel, capped the same way */
export const DOCK = { min: 240, max: 2400, initial: 440 };
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
const DEFAULT_CLOSED = ["search", "history", "claude", "launch", "peers", "preview", "agents"];
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

/** the folded sections of one repo's panel */
export function sectionsFor(closed: ClosedSections, repoId: string): string[] {
  return closed[repoId] ?? DEFAULT_CLOSED;
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

/** the fields of `next` that are not the same value as in `before` */
export function changed<T extends object>(next: T, before: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(next) as (keyof T)[]) {
    if (next[k] !== before[k]) out[k] = next[k];
  }
  return out;
}

const LAYOUT_KEY = "canopy.layout";

/** the layout kept per kind of screen and window (screens.ts): its sizes,
 *  and the feed being up, which the feed's gear puts away */
export const SCREEN_LAYOUT = [
  "feedOpen",
  "sidebarWidth",
  "panelWidths",
  "soloWidth",
  "dockWidth",
  "termHeight",
  "panelTermHeights",
  "focusSize",
  "feedHeight",
] as const satisfies readonly (keyof Layout)[];

/** how often a window re-reads the archive overview on its own */
const HISTORY_REFRESH = 10 * 60_000;

interface Layout {
  sidebarWidth: number;
  panelWidths: Record<string, number>;
  /** px width of the panel in the solo view, shared by every solo tab */
  soloWidth: number;
  /** px width of the dock when it is tabbed, whichever tab shows */
  dockWidth: number;
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

function loadLayout(): Layout {
  const fallback: Layout = {
    sidebarWidth: SIDEBAR.initial,
    panelWidths: {},
    soloWidth: SOLO.initial,
    dockWidth: DOCK.initial,
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
      dockWidth:
        typeof dw === "number" && Number.isFinite(dw)
          ? clamp(dw, DOCK.min, DOCK.max)
          : DOCK.initial,
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
      panels: strings(saved.panels),
      activePanel: typeof saved.activePanel === "string" ? saved.activePanel : null,
      popped: poppedOf(saved.popped),
      terms: loadTermTabs(saved.terms),
      activeTerm: typeof saved.activeTerm === "string" ? saved.activeTerm : null,
      hiddenTerms: strings(saved.hiddenTerms),
      checkoutPref: stringMap(saved.checkoutPref),
    };
  } catch {
    return fallback;
  }
}

/** a record of strings to strings, anything else in it left out */
function stringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
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

/** whether an id is one backend's */
const mineOf =
  (from: string) =>
  (id: string): boolean =>
    ownerOf(id) === from;

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

interface CanopyState {
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
  /** the agent registry, the home backend's broker's cards by id */
  registry: Record<string, AgentCard>;
  /** whether the home backend has a registry to show; false shows nothing
   *  registry-related */
  registryReady: boolean;
  /** the states this page saw each card take, by card id (`markTrail`) */
  registryTrail: Record<string, TrailMark[]>;
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
  /** the incubator's sprouts by id, the home backend's alone */
  sprouts: Record<string, Sprout>;
  /** whether home answered the incubator's list */
  sproutsReady: boolean;
  /** where home runs the incubator's stages; null until it says (an older
   *  backend never does) */
  stages: IncubatorStages | null;
  /** the retro lessons home has on offer, which the inbox shows as one item */
  advice: AdviceOffer[];
  /** an accepted lesson's text by chat run id, which that chat's message box
   *  starts with; the user sends it, or not */
  chatDrafts: Record<string, string>;
  /** the user's own workflow file an accepted lesson named, until put away */
  adviceFile: Extract<AdviceAccepted, { kind: "file" }> | null;
  /** whether the inbox popover is up, and the item it opened on */
  inboxOpen: boolean;
  inboxFocus: string | null;
  workspaces: Workspace[];
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
  /** repo ids pinned open in the dock, left to right */
  panels: string[];
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
  /** folded sections in the tree and the grid, as sectionKey strings */
  collapsed: string[];
  /** folded panel sections (changes, shell, history, claude…) by repo id */
  closedSections: ClosedSections;
  /** repo id → px width of its dock panel; missing means PANEL.initial */
  panelWidths: Record<string, number>;
  /** px width of the solo view's panel, dragged by its edge handles */
  soloWidth: number;
  /** px width of the tabbed dock, dragged by its left edge */
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
  /** reads a repo's tasks from its backend */
  loadTasks: (repoId: string) => Promise<void>;
  taskAct: (repoId: string, action: TaskAction, name?: string) => Promise<void>;
  saveTaskDef: (repoId: string, name: string, def: TaskPatch | null, target: "canopy" | "repo") => Promise<void>;
  /** opening a panel starts its tasks flagged to start with it */
  startPanelTasks: (repoId: string) => void;
  /** opens a repo's panel in the dock, or brings its tab forward */
  openPanel: (id: string) => void;
  /** brings an open panel's tab forward without opening anything */
  showPanel: (id: string) => void;
  /** opens a repo where the settings say to; modifier keys override that
   *  the way they do for links (cmd/ctrl → tab, shift → window) */
  openRepo: (id: string, mods?: ClickModifiers) => void;
  /** opens a repo in an app through the server, as a tab when the settings
   *  say so; rejects with the server's reason */
  openApp: (id: string, app: OpenerId) => Promise<void>;
  closePanel: (id: string) => void;
  /** moves an open panel to index `to` of the dock (clamped); the panel
   *  showing stays the one showing */
  movePanel: (id: string, to: number) => void;
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
  /** folds or unfolds one section; the tree and the grid fold together */
  toggleGroup: (key: string) => void;
  /** folds or unfolds one section (changes, shell, history, claude…) of one repo's panel */
  toggleSection: (repoId: string, key: string) => void;
  setPanelWidth: (id: string, px: number) => void;
  setSoloWidth: (px: number) => void;
  setDockWidth: (px: number) => void;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  /** opens a new shell at a repo where the settings say: its panel, the
   *  strip, or a tab or window of its own; `place` overrides the setting */
  openTerm: (repoId: string, place?: ShellPlace, start?: "agent", prompt?: string, pick?: LaunchPick) => void;
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
  showTerm: (id: string) => void;
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
  /** reads the asks, whether they can be answered, and presence off the
   *  home backend; a backend without a broker leaves them off */
  loadAsks: () => Promise<void>;
  /** opens the inbox, on one item (`ask:<id>`, `run:<id>`, `flow:<id>`) when given */
  openInbox: (focus?: string) => void;
  closeInbox: () => void;
  /** routes an answer to where the item came from: a run's prompt, a
   *  flow's gate, or the broker's ask with this browser's answer key */
  answerInbox: (item: InboxItem, answer: InboxAnswer) => Promise<void>;
  /** reads the incubator's list off the home backend */
  loadSprouts: () => Promise<void>;
  /** accepts or dismisses a retro lesson; a chat it opened is shown, a file
   *  is answered for the inbox to name */
  answerAdvice: (key: string, accept: boolean) => Promise<AdviceAccepted | null>;
  /** a new project from the + project sheet or n; answers before the seed is made */
  createSprout: (form: FormData) => Promise<Sprout>;
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
  /** shows a conversation and reads its history */
  showConv: (conv: string) => Promise<void>;
  sendChan: (target: string, body: string, kind?: "text" | "clip") => Promise<void>;
  putChan: (target: string, file: File, note?: string) => Promise<void>;
  setChanNotify: (on: boolean) => Promise<void>;
  /** marks a shell whose process has ended; its tab stays until closed */
  endTerm: (id: string, code: number | null) => void;
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

  /** opens the pre-flight dialog for an action on a repo */
  plan: (repoId: string, action: RunAction) => void;
  /** the pre-flight dialog for a run across a workspace, on its primary;
   *  throws when the workspace has no primary in the tree */
  openWsPlan: (name: string, action: RunAction) => void;
  /** opens a chat with Claude in a repo: the repo's live run if it has one,
   *  else a new idle chat whose first message starts Claude (the peers
   *  panel's "merge with claude" passes one; the menu's plain chat does not) */
  openChat: (repoId: string, note?: string) => Promise<void>;
  /** opens the repo's agent override */
  editAgent: (repoId: string) => void;
  /** stores a repo's override on its backend; an empty one removes it */
  setAgent: (repoId: string, agent: RepoAgent) => Promise<void>;
  /** writes or (null) deletes a profile on a backend */
  setProfile: (backend: string, name: string, settings: AgentSettings | null) => Promise<void>;
  /** points a role at a pick on a backend, or (null) back at the default */
  setRole: (backend: string, role: AgentRole, pick: AgentPick | null) => Promise<void>;
  /** archives a repo in canopy, or brings it back */
  archiveRepo: (repoId: string, archived: boolean) => Promise<void>;
  /** stars a repo in canopy; unstarring takes the star off every checkout
   *  of its card, since the card shows one star for them all */
  favoriteRepo: (repoId: string, favorite: boolean) => Promise<void>;
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
  takeWip: (repoId: string, peer: string, branch: string) => Promise<void>;
  /** tracks a branch that exists only on a peer, as a local branch here */
  trackBranch: (repoId: string, peer: string, branch: string) => Promise<void>;
  /** seeds the allow-listed files (.env and the like) from a peer that has them */
  seedRepo: (repoId: string) => Promise<void>;
  /** runs the peer pass for just this repo, instead of waiting for the timer */
  syncPeers: (repoId: string) => Promise<void>;
  /** shows a run's console */
  showRun: (runId: string) => void;
  closeSheet: () => void;
  /** opens the search across every repo in view */
  openSearch: () => void;
  setSearchQuery: (q: string) => void;
  /** closes the search sheet, opens the repo's panel with its search section
   *  unfolded, and hands that section the term */
  searchIn: (repoId: string, q: string) => void;
  /** the section took its term */
  takePendingSearch: () => void;
  startRun: (repoId: string, action: RunAction, note: string) => Promise<void>;
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

  /** loads (or reloads) the workflows a repo can run, for the menu */
  loadWorkflows: (repoId: string) => Promise<void>;
  /** opens the pre-flight for a workflow on a repo, or its live flow/run */
  planFlow: (repoId: string, workflow: string) => void;
  startFlow: (repoId: string, workflow: string, note: string) => Promise<void>;
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
  startFleet: (workflow: string, note: string) => Promise<void>;
  stopFleet: (fleetId: string) => Promise<void>;
  dismissFleet: (fleetId: string) => Promise<void>;
  showFleet: (fleetId: string) => void;
}

export type Sheet =
  /** `workspace` makes it a run across that workspace; `repoId` is then its primary */
  | { kind: "plan"; repoId: string; action: RunAction; workspace?: string }
  | { kind: "run"; runId: string }
  | { kind: "agent"; repoId: string }
  | { kind: "new-sprout" }
  | { kind: "sprout"; id: string }
  | { kind: "launch"; repoId: string }
  | { kind: "task"; repoId: string; name: string | null }
  | { kind: "search" }
  | { kind: "flow-plan"; repoId: string; workflow: string }
  | { kind: "flow"; flowId: string }
  | { kind: "fleet-plan"; workflow: string }
  | { kind: "fleet"; fleetId: string };

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
  const kept = s.panels.filter((id) => !mine(id) || tree.repos.some((r) => r.id === id));
  const panels = kept.length === s.panels.length ? s.panels : kept;
  return {
    root: from === s.home ? tree.root : s.root,
    sources: sliceIn(reg, s.sources, from, tree.sources, (x) => x.id),
    repos: sliceIn(reg, s.repos, from, tree.repos, (r) => r.id),
    conns: withConn(s, from, { backend: tree.backend }),
    panels,
    // a bench whose repo left the scan goes with its panel
    front: panels === s.panels ? s.front : keepFront(s.front, s.terms, panels),
    // the showing tab may be among the dropped; then its neighbour shows
    activePanel:
      s.activePanel !== null && panels.includes(s.activePanel)
        ? s.activePanel
        : (panels[0] ?? null),
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
function applyPeerRepo(get: () => CanopyState, result: Repo & { take?: { how: string; branch?: string } }): void {
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
/* and the stages events, so a read on its way never undoes a newer one */
let stagesEvents = 0;
/** the same for the advice on offer */
let adviceEvents = 0;

/** an action's answer about a sprout, applied like its event unless an
 *  event already moved the sprout on past it (checked first, so a stale
 *  answer adds no feed line either) */
function sproutAnswered(get: () => CanopyState, sp: Sprout): void {
  if (staleSprout(get().sprouts, sp)) return;
  get().applyEvent({ type: "incubator", sprout: sp });
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
    void get().loadRegistry();
    void get().loadAsks();
    void get().loadSprouts();
  }
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

/** `focusPanel`, and a panel docked here is out in no window of its own any
 *  more (`recall`). Every way into the dock by hand goes through this. */
function dockPanel(s: Pick<CanopyState, "panels" | "popped" | "recalled">, id: string) {
  return { ...focusPanel(s.panels, id), ...recall(s, id) };
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
  kept: [],
  chan: null,
  chanAs: "",
  chanMsgs: {},
  chanUnread: 0,
  chanOpen: false,
  chanConv: null,
  registry: {},
  registryReady: false,
  registryTrail: {},
  asks: {},
  asksReady: false,
  answerKey: readAnswerKey(),
  presence: null,
  sprouts: {},
  sproutsReady: false,
  stages: null,
  advice: [],
  chatDrafts: {},
  adviceFile: null,
  inboxOpen: false,
  inboxFocus: null,
  workspaces: [],
  loaded: false,
  loadError: null,
  filter: "",
  dirtyOnly: false,
  favoritesOnly: false,
  filters: [],
  users: [],
  activeWs: null,
  panels: layout.panels,
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
      const { panels, closedSections, popped } = openSavedPanels(s.panels, s.closedSections, s.popped, dockless() ? [] : terms);
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
        popped,
        activePanel: s.activePanel ?? panels[0] ?? null,
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
    // what home runs, for naming the machines; a page with one backend
    // names none, so it does not ask
    if (order.length > 1) {
      void api
        .about()
        .then((about) => set((s) => ({ conns: connsIf(s, home, { about }) })))
        .catch(() => {});
    }
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
      const { panels, closedSections, popped } = openSavedPanels(t.panels, t.closedSections, t.popped, dockless() ? [] : back);
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
        popped,
        activePanel: t.activePanel ?? panels[0] ?? null,
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
    // a load still on its way for it lands nothing
    connecting.set(name, (connecting.get(name) ?? 0) + 1);
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
      // the sibling's panel may be open already; it keeps its place then
      const panels = s.panels.includes(toId)
        ? s.panels.filter((p) => p !== fromId)
        : s.panels.map((p) => (p === fromId ? toId : p));
      const activePanel = s.activePanel === fromId ? toId : s.activePanel;
      // like a close: the old panel's shell tabs go, the shells stay held
      const kept = s.terms.filter((t) => !(t.repoId === fromId && t.place === "panel"));
      const terms = dockless() ? kept : adoptTerms(kept, s.shells, s.repos, panels, skipped(s.hiddenTerms));
      const width = s.panelWidths[fromId];
      return {
        panels,
        activePanel,
        // the sibling docked here by hand is out in no window any more
        ...recall(s, toId),
        terms,
        front: keepFront(s.front, terms, panels),
        ...(width !== undefined && s.panelWidths[toId] === undefined ? { panelWidths: { ...s.panelWidths, [toId]: width } } : {}),
        ...(card ? { checkoutPref: { ...s.checkoutPref, [card.key]: backendOf(toId) } } : {}),
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
  openPanel: (id) =>
    set((s) => {
      const next = dockPanel(s, id);
      // a panel shell another device opened here waits for its panel
      return { ...next, terms: dockless() ? s.terms : adoptTerms(s.terms, s.shells, s.repos, next.panels, skipped(s.hiddenTerms)) };
    }),
  showPanel: (id) =>
    set((s) => (s.panels.includes(id) ? { activePanel: id } : {})),
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
    const panels = s.panels.filter((p) => p !== id);
    set({
      panels,
      ...recall(s, id),
      activePanel: nextActive(s.panels, id, s.activePanel),
      terms,
      front: keepFront(s.front, terms, panels),
    });
  },
  movePanel: (id, to) => set((s) => ({ panels: moveIn(s.panels, id, to) })),
  popOut: (id) => {
    // the window first: a blocked popup leaves the panel where it was
    if (!get().panels.includes(id) || !popOutWindow(id)) return;
    get().claimPanel(id);
  },
  returnPanel: (id) =>
    set((s) => {
      const slot = s.popped[id];
      if (slot === undefined) return {};
      // a home repo gone from the scan has no panel to show; its slot stays
      // for the next tree to prune. Before the first tree, no repos says
      // nothing yet.
      if (s.loaded && ownerOf(id) === registry().home && !s.repos.some((r) => r.id === id)) return {};
      const panels = restorePanel(s.panels, id, slot);
      // its held shells come back as tabs, the way openPanel adopts them
      const terms = dockless() ? s.terms : adoptTerms(s.terms, s.shells, s.repos, panels, skipped(s.hiddenTerms));
      return { popped: without(s.popped, id), panels, activePanel: id, terms };
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
    // workspaces, tailchan, the agent registry, the asks and the incubator are the home backend's alone
    if ((ev.type === "chan" || ev.type === "workspaces" || ev.type === "registry" || ev.type === "asks" || ev.type === "incubator" || ev.type === "incubator-gone" || ev.type === "stages" || ev.type === "advice") && b !== before.home) return;
    // The feed says what changed, so the lines come from the event against
    // the state before it is applied, as the backend that sent it saw it.
    // a message already held (a reconnect's replay, a post heard twice) is
    // neither a feed line nor unread
    if (ev.type === "chan" && before.chanMsgs[ev.message.channel]?.some((m) => m.id === ev.message.id)) return;
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
      stagesEvents += 1;
      set({ stages: ev.stages });
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
        const looking = s.chanOpen && s.chanConv === m.channel && document.visibilityState === "visible";
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
      set((s) => {
        const shells = sliceIn(registry(), s.shells, b, ev.terms, (t) => t.id);
        const hiddenTerms = pruneHiddenOf(s.hiddenTerms, b, ev.terms);
        return {
          shells,
          hiddenTerms,
          terms: adoptHere(s.terms, shells, s.repos, s.panels, skipped(hiddenTerms)),
        };
      });
    }
  },

  setWorkspaces: (workspaces) => set({ workspaces }),

  setSidebarWidth: (px) => set({ sidebarWidth: clamp(px, SIDEBAR.min, SIDEBAR.max) }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setDrawer: (drawerOpen) => set({ drawerOpen }),
  toggleGroup: (key) =>
    set((s) => ({
      collapsed: s.collapsed.includes(key)
        ? s.collapsed.filter((k) => k !== key)
        : [...s.collapsed, key],
    })),
  toggleSection: (repoId, key) =>
    set((s) => ({ closedSections: toggleIn(s.closedSections, repoId, key) })),
  setPanelWidth: (id, px) =>
    set((s) => ({ panelWidths: { ...s.panelWidths, [id]: clamp(px, PANEL.min, PANEL.max) } })),
  setSoloWidth: (px) => set({ soloWidth: clamp(px, SOLO.min, SOLO.max) }),
  setDockWidth: (px) => set({ dockWidth: clamp(px, DOCK.min, DOCK.max) }),
  setSetting: (key, value) =>
    set((s) => {
      const settings = { ...s.settings, [key]: value };
      saveSettings(settings);
      return { settings };
    }),
  openTerm: (repoId, place, start, prompt, pick) => {
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
    const tab: TermTab = {
      id: qual(backendOf(repoId), termId()),
      repoId,
      name: repo.name,
      path: repo.path,
      place: where,
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
    const rec = s.kept.find((k) => k.id === id);
    if (!rec) return;
    const repo = s.repos.find((r) => r.id === rec.repoId);
    if (!repo) return;
    await api.restoreShell(id, resume);
    // the same tab the lost shell had, since it comes back under its name;
    // a tab still showing the shell that went (its socket was told the
    // shell exited) is replaced, with a new generation so its view starts
    // over instead of staying ended
    const tab: TermTab = { id, repoId: repo.id, name: repo.name, path: repo.path, place: rec.place };
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
  loadSprouts: async () => {
    const stagesMark = stagesEvents;
    void api
      .incubatorStages()
      .then((stages) => {
        if (stagesEvents === stagesMark) set({ stages });
      })
      .catch(() => {
        // an older backend has no such route; the view says nothing then
      });
    const adviceMark = adviceEvents;
    void api
      .advice()
      .then((advice) => {
        if (adviceEvents === adviceMark && Array.isArray(advice)) set({ advice });
      })
      .catch(() => {
        // an older backend has no such route, and offers nothing
      });
    // events that land while the list is on its way are newer than it
    const mark = sproutEvents;
    try {
      const list = await api.sprouts();
      set((s) => ({
        sprouts: replaceSprouts(s.sprouts, Array.isArray(list) ? list : [], (id) => (sproutHeard.get(id) ?? 0) > mark),
        sproutsReady: true,
      }));
    } catch {
      // a failed reload keeps what is held, so a blip does not drop the inbox's questions
    }
  },
  createSprout: async (form) => {
    const sp = await api.newSprout(form);
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
    get().applyEvent({ type: "incubator-gone", id });
  },
  showSprout: (id) => set({ sheet: { kind: "sprout", id } }),
  openNewSprout: () => set({ sheet: { kind: "new-sprout" } }),
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
    // the latest clips, for "copy the latest", whether or not this handle
    // follows the clipboard channel
    void api
      .chanRead("#clipboard", 5)
      .then((msgs) => set((st) => ({ chanMsgs: { ...st.chanMsgs, clipboard: mergeMessages(st.chanMsgs["clipboard"], msgs) } })))
      .catch(() => {});
  },
  closeChan: () => set({ chanOpen: false }),
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
    if (!tab.task) endShells([tab]);
    const terms = s.terms.filter((t) => t.id !== id);
    set({ terms, activeTerm: nextStripTab(s.terms, id, s.activeTerm), front: keepFront(s.front, terms, s.panels) });
  },
  hideTerm: (id) => {
    const s = get();
    if (!s.terms.some((t) => t.id === id)) return;
    const terms = s.terms.filter((t) => t.id !== id);
    set({
      terms,
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
  showTerm: (id) => set((s) => (s.terms.some((t) => t.id === id) ? { activeTerm: id } : {})),
  endTerm: (id, code) =>
    set((s) => ({ terms: s.terms.map((t) => (t.id === id ? { ...t, exit: code } : t)) })),
  setTermHeight: (px) => set({ termHeight: clamp(px, TERM.min, TERM.max) }),
  setFocusSize: (size) => set({ focusSize: size }),
  setFront: (front) => set({ front }),
  bringProject: (repoId) =>
    set((s) => (repoId === null ? { front: null } : { ...dockPanel(s, repoId), front: projectFront(repoId) })),
  soloBench: (repoId, pane) =>
    set((s) => {
      const front = withSolo(s.front, repoId, pane);
      return front === s.front ? {} : { front };
    }),
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
    const active = activeRunFor(get(), repoId);
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
    applyPeerRepo(get, await api.peerAction(repoId, { action: "take", peer, branch }));
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
  showRun: (runId) => set({ sheet: { kind: "run", runId } }),
  closeSheet: () => set({ sheet: null }),
  openSearch: () => set({ sheet: { kind: "search" } }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  searchIn: (repoId, q) =>
    set((s) => ({
      sheet: null,
      pendingSearch: { repoId, q },
      ...dockPanel(s, repoId),
      closedSections: unfoldIn(s.closedSections, repoId, "search"),
    })),
  takePendingSearch: () => set({ pendingSearch: null }),
  startRun: async (repoId, action, note) => {
    const run = await api.run(repoId, action, note, clientId());
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
    const run = await api.answerRun(runId, promptId, answer);
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
  dismissRun: async (runId) => {
    await api.dismissRun(runId);
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
  startFlow: async (repoId, workflow, note) => {
    const flow = await api.startFlow(repoId, workflow, note);
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
  pickFacet: (facet) => set((s) => ({ selected: pickWhere(visibleRepos(s), facet) })),
  planFleet: (workflow) => set({ sheet: { kind: "fleet-plan", workflow } }),
  startFleet: async (workflow, note) => {
    // one fleet per backend the picked repos are on; the sheet shows the
    // first. api.startFleet keeps asking every backend even once one has
    // failed, so a partial failure still hands back the fleets that did
    // start (as a PartialFleetError): fold those in and drop their repos
    // from the selection before the error reaches the caller, or a second
    // click would start a second fleet on repos already running one. A
    // full start clears the whole pick, as it always did.
    let started: Fleet[];
    try {
      started = await api.startFleet(workflow, pickedIds(get()), note);
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
  return route.solo || route.shell || route.section !== null;
}

// Whatever part of the layout a change touched is written as it happens, so
// no action has to remember to. Only the changed fields go: see saveLayout.
useStore.subscribe((s, prev) => {
  const patch = changed(layoutOf(s), layoutOf(prev));
  if (dockless()) {
    delete patch.panels;
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
    const layout = loadLayout();
    const fresh = loadSettings();
    const sizes: Partial<Layout> = {};
    for (const k of SCREEN_LAYOUT) Object.assign(sizes, { [k]: layout[k] });
    const sized: Partial<Settings> = {};
    for (const k of SCREEN_SETTINGS) Object.assign(sized, { [k]: fresh[k] });
    useStore.setState((s) => ({ ...sizes, settings: { ...s.settings, ...sized } }));
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
  return r && isRunActive(r) ? r : undefined;
}

/** A repo's newest flow, active first. */
export function flowFor(s: CanopyState, repoId: string): Flow | undefined {
  let best: Flow | undefined;
  for (const f of Object.values(s.flows)) {
    if (f.repoId !== repoId) continue;
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
export const agentFor = (s: CanopyState, repo: Repo, role: AgentRole = "shell"): AgentSettings =>
  resolveAgent(routesOf(s, backendOf(repo.id)), repo.path, role).settings;

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
} | null = null;
let inboxOut: InboxItem[] = [];

/** Everything waiting on the human, oldest first: the home broker's open
 *  asks, the incubator's questions, every backend's runs on a prompt and flows at a gate. Worked out
 *  once per change of what it reads, so a selector over it settles; a
 *  countdown keeps its own time off each item's `until`. */
export function inboxItems(s: CanopyState): InboxItem[] {
  if (inboxIn && inboxIn.asks === s.asks && inboxIn.runs === s.runs && inboxIn.flows === s.flows && inboxIn.repos === s.repos && inboxIn.registry === s.registry && inboxIn.sprouts === s.sprouts && inboxIn.advice === s.advice) {
    return inboxOut;
  }
  inboxIn = { asks: s.asks, runs: s.runs, flows: s.flows, repos: s.repos, registry: s.registry, sprouts: s.sprouts, advice: s.advice };
  inboxOut = mergeInbox(Object.values(s.asks), s.runs, s.flows, Date.now(), {
    repos: s.repos,
    cards: s.registry,
    backendOf: (id) => (s.backendOrder.length > 1 ? backendOf(id) : ""),
    askRepos: s.repos.filter((r) => backendOf(r.id) === s.home),
    sprouts: Object.values(s.sprouts),
    advice: s.advice,
  });
  return inboxOut;
}

/** The card a checkout is on, whichever checkout of it. */
export function cardOf(s: CanopyState, repoId: string): RepoCard | undefined {
  allCards(s);
  return cardIndex.get(repoId);
}

let viewIn: { cards: RepoCard[]; filters: unknown; users: unknown; attention: boolean; favorites: boolean; text: string } | null =
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
    v.text === s.filter
  )
    return viewOut;
  const q = { filters: s.filters, users: s.users, attention: s.dirtyOnly, favorites: s.favoritesOnly, text: s.filter };
  viewIn = { cards, filters: s.filters, users: s.users, attention: s.dirtyOnly, favorites: s.favoritesOnly, text: s.filter };
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

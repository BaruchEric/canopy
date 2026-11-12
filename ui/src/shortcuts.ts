/**
 * The page's keyboard shortcuts as one table. App.tsx's key handler reads a
 * press through `shortcutFor`, `chordView` and `copyKeyOf`, and the ? sheet
 * lists `shortcutsOn`, `GO` and `YANK`, so the sheet cannot drift from what
 * the keys do (FR-021, FR-022; the ring's keys are FR-023's, the copy keys
 * FR-025's). Pure and tested (shortcuts.test.ts).
 */

export type KeyAction =
  | "help"
  | "command"
  | "find"
  | "go"
  | "yank"
  | "new"
  | "filter"
  | "filters"
  | "tree"
  | "feed"
  | "waiting"
  | "clips"
  | "dirty"
  | "favorites"
  | "select"
  | "select-all"
  | "sort"
  | "next"
  | "prev"
  | "peek"
  | "enter"
  | "escape";

export interface Shortcut {
  action: KeyAction;
  /** the press as `pressOf` says it: a bare key, or `mod+` (⌘ or Ctrl) with a lowercase one */
  press: string;
  what: string;
  /** the views it works on, every view when absent */
  views?: readonly string[];
  /** it works from inside a text box too, like an editor's chord */
  anywhere?: boolean;
}

const GIT = ["git"];
/** the views the keyboard ring walks (FR-023, kbfocus.ts) */
const RING = ["git", "triggers"];

/** Every shortcut, in the order the sheet lists them. */
export const SHORTCUTS: readonly Shortcut[] = [
  { action: "help", press: "?", what: "Every shortcut on this view" },
  { action: "command", press: "mod+k", what: "The command line, from a box or a shell too", anywhere: true },
  { action: "command", press: ":", what: "The command line" },
  { action: "go", press: "g", what: "Then a letter, go to a view (below)" },
  { action: "yank", press: "y", what: "Then a letter, copy from the ringed card or row, or the open run sheet (below)" },
  { action: "find", press: "mod+shift+f", what: "Search the files of every repo in view", views: GIT, anywhere: true },
  { action: "new", press: "n", what: "A new project", views: ["git", "incubator"] },
  { action: "filter", press: "/", what: "Filter the repos", views: GIT },
  { action: "filters", press: "f", what: "The filters menu", views: GIT },
  { action: "tree", press: "[", what: "Show or hide the tree", views: GIT },
  { action: "feed", press: "e", what: "Show or hide the feed", views: GIT },
  { action: "waiting", press: "w", what: "Open what is waiting on you", views: GIT },
  { action: "clips", press: "v", what: "Open the clipboard: every copy, from every shell, page and device", views: GIT },
  { action: "dirty", press: "d", what: "Only repos with changes, or all", views: GIT },
  { action: "favorites", press: "*", what: "Only starred repos, or all", views: GIT },
  { action: "sort", press: "s", what: "The next sort", views: GIT },
  { action: "select", press: "x", what: "Select mode, on or off", views: GIT },
  { action: "select-all", press: "mod+a", what: "In select mode, select every card shown", views: GIT },
  { action: "next", press: "j", what: "Ring the next card or row", views: RING },
  { action: "prev", press: "k", what: "Ring the one before", views: RING },
  { action: "next", press: "ArrowDown", what: "The next one, as j", views: RING },
  { action: "prev", press: "ArrowUp", what: "The one before, as k", views: RING },
  { action: "peek", press: " ", what: "Peek at the ringed one's run in its sheet; Esc closes it and the ring stays", views: RING },
  { action: "enter", press: "Enter", what: "Go into the ringed one: a card's repo, a trigger's repo, an inbox row's form", views: RING },
  { action: "escape", press: "Escape", what: "Close the drawer, leave select mode, or hide the ring", views: RING },
];

/** How long `g` and `y` wait for their letter. */
export const CHORD_MS = 1500;

/** g then a letter, and the view it goes to: the agents view opens on its board. */
export const GO: readonly { key: string; view: string; what: string }[] = [
  { key: "g", view: "git", what: "git, every repo" },
  { key: "b", view: "agents", what: "the agents board" },
  { key: "s", view: "sessions", what: "sessions" },
  { key: "t", view: "triggers", what: "triggers" },
  { key: "o", view: "clock", what: "the clock" },
  { key: "i", view: "incubator", what: "the incubator" },
  { key: "l", view: "library", what: "the library" },
  { key: "p", view: "ports", what: "ports" },
  { key: "h", view: "health", what: "health" },
  { key: "c", view: "costs", what: "costs" },
  { key: "k", view: "kit", what: "the kit" },
  { key: "e", view: "plugins", what: "plugins" },
  { key: "w", view: "work", what: "the work ledger" },
];

/** what y then a letter copies (FR-025, kbcopy.ts): the branch, the PR's link, the run's id */
export type CopyKey = "b" | "p" | "r";

/** y then a letter, and what it copies off the ringed card or row, or the run sheet's run. */
export const YANK: readonly { key: CopyKey; what: string }[] = [
  { key: "b", what: "its branch" },
  { key: "p", what: "its PR's link" },
  { key: "r", what: "its run's id" },
];

/** the parts of a KeyboardEvent a press is read from */
export interface KeyPress {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * A key press as the table names it: `mod+` for ⌘ or Ctrl, then `shift+`
 * when held, then the key in lowercase; a bare key as it came, since Shift
 * is what types `?`, `*` and `:`. Null with Alt, which no shortcut uses.
 */
export function pressOf(e: KeyPress): string | null {
  if (e.altKey) return null;
  if (e.metaKey || e.ctrlKey) return `mod+${e.shiftKey ? "shift+" : ""}${e.key.toLowerCase()}`;
  return e.key;
}

const onView = (s: Shortcut, view: string): boolean => !s.views || s.views.includes(view);

/** The shortcut a press means on a view, or null. */
export function shortcutFor(press: string, view: string): Shortcut | null {
  return SHORTCUTS.find((s) => s.press === press && onView(s, view)) ?? null;
}

/** The shortcuts that work on a view, in the table's order. */
export const shortcutsOn = (view: string): Shortcut[] => SHORTCUTS.filter((s) => onView(s, view));

/** The view `g` then `key` goes to, or null. */
export const chordView = (key: string): string | null => GO.find((g) => g.key === key)?.view ?? null;

/** What `y` then `key` copies, or null. */
export const copyKeyOf = (key: string): CopyKey | null => YANK.find((y) => y.key === key)?.key ?? null;

/** the keys the sheet names rather than prints */
const NAMED_CAPS: Readonly<Record<string, string>> = { Escape: "Esc", " ": "Space", Enter: "Enter", ArrowDown: "↓", ArrowUp: "↑" };

/** A press as the sheet shows it, one string per key: `mod` is ⌘ on an
 *  Apple keyboard and Ctrl elsewhere. */
export function keyCaps(press: string, apple: boolean): string[] {
  const named = NAMED_CAPS[press];
  if (named) return [named];
  if (!press.startsWith("mod+")) return [press];
  const parts = press.split("+");
  return parts.map((p) => (p === "mod" ? (apple ? "⌘" : "Ctrl") : p === "shift" ? (apple ? "⇧" : "Shift") : p.toUpperCase()));
}

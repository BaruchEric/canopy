/**
 * The page's keyboard shortcuts as one table. App.tsx's key handler reads a
 * press through `shortcutFor` and `chordView`, and the ? sheet lists
 * `shortcutsOn` and `GO`, so the sheet cannot drift from what the keys do
 * (FR-021, FR-022). Pure and tested (shortcuts.test.ts).
 */

export type KeyAction =
  | "help"
  | "command"
  | "find"
  | "go"
  | "new"
  | "filter"
  | "filters"
  | "tree"
  | "feed"
  | "waiting"
  | "dirty"
  | "favorites"
  | "select"
  | "select-all"
  | "sort"
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

/** Every shortcut, in the order the sheet lists them. */
export const SHORTCUTS: readonly Shortcut[] = [
  { action: "help", press: "?", what: "Every shortcut on this view" },
  { action: "command", press: "mod+k", what: "The command line, from a box or a shell too", anywhere: true },
  { action: "command", press: ":", what: "The command line" },
  { action: "go", press: "g", what: "Then a letter, go to a view (below)" },
  { action: "find", press: "mod+shift+f", what: "Search the files of every repo in view", views: GIT, anywhere: true },
  { action: "new", press: "n", what: "A new project", views: ["git", "incubator"] },
  { action: "filter", press: "/", what: "Filter the repos", views: GIT },
  { action: "filters", press: "f", what: "The filters menu", views: GIT },
  { action: "tree", press: "[", what: "Show or hide the tree", views: GIT },
  { action: "feed", press: "e", what: "Show or hide the feed", views: GIT },
  { action: "waiting", press: "w", what: "Open what is waiting on you", views: GIT },
  { action: "dirty", press: "d", what: "Only repos with changes, or all", views: GIT },
  { action: "favorites", press: "*", what: "Only starred repos, or all", views: GIT },
  { action: "sort", press: "s", what: "The next sort", views: GIT },
  { action: "select", press: "x", what: "Select mode, on or off", views: GIT },
  { action: "select-all", press: "mod+a", what: "In select mode, select every card shown", views: GIT },
  { action: "escape", press: "Escape", what: "Close the drawer, or leave select mode", views: GIT },
];

/** How long `g` waits for its letter. */
export const CHORD_MS = 1500;

/** g then a letter, and the view it goes to: the agents view opens on its board. */
export const GO: readonly { key: string; view: string; what: string }[] = [
  { key: "g", view: "git", what: "git, every repo" },
  { key: "b", view: "agents", what: "the agents board" },
  { key: "s", view: "sessions", what: "sessions" },
  { key: "t", view: "triggers", what: "triggers" },
  { key: "i", view: "incubator", what: "the incubator" },
  { key: "l", view: "library", what: "the library" },
  { key: "p", view: "ports", what: "ports" },
  { key: "h", view: "health", what: "health" },
  { key: "c", view: "costs", what: "costs" },
  { key: "k", view: "kit", what: "the kit" },
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

/** A press as the sheet shows it, one string per key: `mod` is ⌘ on an
 *  Apple keyboard and Ctrl elsewhere. */
export function keyCaps(press: string, apple: boolean): string[] {
  if (press === "Escape") return ["Esc"];
  if (!press.startsWith("mod+")) return [press];
  const parts = press.split("+");
  return parts.map((p) => (p === "mod" ? (apple ? "⌘" : "Ctrl") : p === "shift" ? (apple ? "⇧" : "Shift") : p.toUpperCase()));
}

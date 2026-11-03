/** Push on this browser (FR-042): the words the device tab says, the
 * payload the worker reads, and where a notification click lands. ESNext
 * only: the worker imports this module, so it reads no browser global. */

export type PushPermission = "default" | "granted" | "denied" | "none";

/** what stands between this browser and a push, as the row sees it */
export interface PushPlace {
  on: boolean;
  secure: boolean;
  /** the Vite dev server registers no worker */
  dev: boolean;
  /** the browser has PushManager and Notification */
  hasPush: boolean;
  ios: boolean;
  standalone: boolean;
  permission: PushPermission;
  /** the home backend's public key: null when it has none, undefined
   *  before it answered */
  key: string | null | undefined;
  /** the backend's own words for a missing key */
  keyWhy: string | null;
  /** this browser's entry on the backend, when it has one */
  mine: { stale: boolean } | null;
}

export const PUSH_WORDS = {
  http: "This page is on plain http; push needs https or localhost",
  dev: "The Vite dev server registers no worker, so push is not available here; the built page has it.",
  ios: "Push needs the page installed to the home screen on an iPhone: share → Add to Home Screen, then turn this on from there",
  none: "This browser has no push",
  denied: "The browser blocks notifications for this site. Allow them in its site settings, then turn this off and on again.",
  asked: "The browser has not been asked yet: turn this off and on again to ask.",
  noKey: "The backend has no push key (its config dir is read-only)",
  stale: "stale: the last 3 pushes failed",
} as const;

/** why a push cannot reach this browser, in a line, or null when it can
 *  (or the setting is off, when there is nothing to explain) */
export function pushWhyNot(p: PushPlace): string | null {
  if (!p.on) return null;
  if (!p.secure) return PUSH_WORDS.http;
  if (p.dev) return PUSH_WORDS.dev;
  if (p.ios && !p.standalone) return PUSH_WORDS.ios;
  if (!p.hasPush || p.permission === "none") return PUSH_WORDS.none;
  if (p.permission === "denied") return PUSH_WORDS.denied;
  if (p.permission === "default") return PUSH_WORDS.asked;
  if (p.key === null) return p.keyWhy ? `${PUSH_WORDS.noKey}. ${p.keyWhy}` : PUSH_WORDS.noKey;
  if (p.mine?.stale) return PUSH_WORDS.stale;
  return null;
}

/** what a push carries, as `core/push.ts` writes it; the worker shows it
 *  as is, so nothing here is a token, a key or a command */
export interface PushPayload {
  key: string;
  title: string;
  body: string;
  /** a path on the page's own origin */
  url: string;
  /** how many things wait, for the badge */
  count: number;
}

const isPath = (s: string): boolean => s.startsWith("/") && !s.startsWith("//");

/** The payload a push event carried, or a plain note when it was not
 *  canopy's JSON: a push service never adds a body of its own, but a
 *  test tool might. */
export function parsePushPayload(text: string | null): PushPayload {
  const plain: PushPayload = { key: "push", title: "canopy", body: text?.trim() ?? "", url: "/", count: 0 };
  if (text === null || text === "") return plain;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return plain;
  }
  if (!parsed || typeof parsed !== "object") return plain;
  const o = parsed as Record<string, unknown>;
  const str = (v: unknown, or: string): string => (typeof v === "string" && v !== "" ? v : or);
  const url = str(o.url, "/");
  const count = typeof o.count === "number" && Number.isInteger(o.count) && o.count > 0 ? o.count : 0;
  return { key: str(o.key, plain.key), title: str(o.title, plain.title), body: typeof o.body === "string" ? o.body : "", url: isPath(url) ? url : "/", count };
}

/** the url a shown notification kept in its `data` */
export function notificationUrl(data: unknown): string {
  if (data && typeof data === "object" && "url" in data && typeof data.url === "string" && isPath(data.url)) return data.url;
  return "/";
}

/** The message the worker posts to a page on a click, and what the page
 *  does with the url: an ask opens in the inbox, a repo pins its panel,
 *  anything else is a page to load. */
export const OPEN_MESSAGE = "canopy:open";
export interface OpenMessage { type: typeof OPEN_MESSAGE; url: string }
export const isOpenMessage = (data: unknown): data is OpenMessage =>
  !!data && typeof data === "object" && "type" in data && data.type === OPEN_MESSAGE && "url" in data && typeof data.url === "string";

export type PushTarget = { kind: "ask"; id: string } | { kind: "repo"; id: string } | { kind: "page"; url: string };
export function pushTarget(url: string, origin: string): PushTarget {
  const u = new URL(url, origin);
  const ask = u.searchParams.get("ask");
  if (ask) return { kind: "ask", id: ask };
  const repo = u.searchParams.get("repo");
  if (repo) return { kind: "repo", id: repo };
  return { kind: "page", url: `${u.pathname}${u.search}` };
}

/** which open window a click goes to: a focused one on this origin, else
 *  the first on this origin; -1 when a new window is needed */
export function pickClient(windows: readonly { url: string; focused: boolean }[], origin: string): number {
  const ours = windows.map((w, i) => ({ w, i })).filter(({ w }) => w.url.startsWith(`${origin}/`) || w.url === origin);
  const focused = ours.find(({ w }) => w.focused);
  return (focused ?? ours[0])?.i ?? -1;
}

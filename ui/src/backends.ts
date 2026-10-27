import { LAUNCH_SOURCE, type BackendEntry } from "../../src/core/types";
import { SEP, split, type Reg } from "../../src/core/backendid";
export { qualify, split, SEP, type Reg } from "../../src/core/backendid";

/* Several canopy backends behind one page. Pure, so the api layer, the
   store and the tests share one reading of an id and of which URL to use. */

/** A host less its first label; an address or a one- or two-label name is
 *  its own parent. */
function parentOf(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  return parts.length > 2 ? parts.slice(1).join(".") : host;
}

/** Whether a page is on the public side: its host, or its parent domain, is
 *  a public URL's. The gate's cookie is scoped to that parent, so only such
 *  a page can carry a sign-in to another backend. */
export function onPublicSide(pageHost: string, entries: readonly BackendEntry[]): boolean {
  const page = parentOf(pageHost);
  return entries.some((e) => {
    if (!e.public) return false;
    const host = new URL(e.public).hostname;
    return host === pageHost || parentOf(host) === page;
  });
}

export interface UrlPick {
  /** the URL to try; null when the entry has none this page can use */
  first: string | null;
  /** the URL to fall back to when `first` does not answer */
  fallback: string | null;
}

/** Which of a backend's URLs this page should use. A public-side page uses
 *  `public`; any other uses `tailnet` and falls back to `public`. An https
 *  page never takes an http URL (mixed content), and a URL that is the
 *  page's own origin is skipped, since that backend is home. */
export function pickUrl(pageOrigin: string, entry: BackendEntry, entries: readonly BackendEntry[]): UrlPick {
  const page = new URL(pageOrigin);
  const usable = (u: string | undefined): string | null => {
    if (!u) return null;
    const origin = new URL(u).origin;
    if (page.protocol === "https:" && !origin.startsWith("https:")) return null;
    return origin === page.origin ? null : origin;
  };
  const pub = usable(entry.public);
  const tail = usable(entry.tailnet);
  if (onPublicSide(page.hostname, entries)) return { first: pub ?? tail, fallback: null };
  return tail ? { first: tail, fallback: pub } : { first: pub, fallback: null };
}

/** Whether the registry named any backend besides home: the chip that shows
 *  and controls every backend stays hidden while there is nothing else to
 *  show, even when the config lists home itself as one of its own entries. */
export function hasOtherBackend(entries: readonly BackendEntry[], home: string): boolean {
  return entries.some((e) => e.name !== home);
}

export type BackendState = "connecting" | "online" | "offline" | "signin";

export interface BackendStatus {
  state: BackendState;
  /** why it is offline */
  reason?: string;
  /** the gate's login page, when it asked for a sign-in */
  login?: string;
}

/** What the api layer saw of a backend. */
export type BackendSignal =
  /** a response came back, whatever its status (bar the gate's 401) */
  | { kind: "answered" }
  /** no response: a network error, a CORS refusal, a timeout */
  | { kind: "unreachable"; reason: string }
  /** the gate answered 401 with where to sign in */
  | { kind: "signin"; login: string }
  /** canopy's own caller check refused a call for want of a token or a
   *  right: the backend answered, and this page should sign in to it */
  | { kind: "refused"; status: number; need: string; token: string | null }
  | { kind: "stream-open" }
  | { kind: "stream-lost" }
  /** the page is trying again */
  | { kind: "retry" };

/** A backend's state after a signal; `prev` itself when nothing changed, so
 *  the store does not churn. A dropped stream after a sign-in prompt is
 *  still a sign-in: the gate refuses the stream the same way. */
export function backendState(prev: BackendStatus, sig: BackendSignal): BackendStatus {
  switch (sig.kind) {
    case "answered":
    case "refused":
    case "stream-open":
      return prev.state === "online" ? prev : { state: "online" };
    case "signin":
      return prev.state === "signin" && prev.login === sig.login ? prev : { state: "signin", login: sig.login };
    case "unreachable":
      if (prev.state === "signin") return prev;
      return prev.state === "offline" && prev.reason === sig.reason ? prev : { state: "offline", reason: sig.reason };
    case "stream-lost":
      if (prev.state === "signin" || prev.state === "offline") return prev;
      return { state: "offline", reason: "the event stream dropped" };
    case "retry":
      return prev.state === "connecting" ? prev : { state: "connecting" };
  }
}

/** The first wait before the page tries a backend again by itself after a
 *  failed connect, and the longest: the wait doubles per failure in a row. */
export const RETRY_FIRST = 2_000;
export const RETRY_MAX = 60_000;

/** How long to wait before the next automatic try, after `tries` failed
 *  ones in a row (0 for the first). */
export function retryWait(tries: number, first = RETRY_FIRST, max = RETRY_MAX): number {
  return Math.min(max, first * 2 ** Math.max(0, Math.min(tries, 30)));
}

/** A merged list with one backend's part replaced by `next`, in registry
 *  order and, within a backend, in the order each came. With one backend
 *  it is `next` itself. */
export function sliceIn<T>(reg: Reg, list: readonly T[], from: string, next: T[], idOf: (t: T) => string): T[] {
  if (reg.names.length <= 1) return next;
  const rank = (t: T): number => {
    const i = reg.names.indexOf(split(reg, idOf(t))[0]);
    return i < 0 ? reg.names.length : i;
  };
  const kept = list.filter((t) => split(reg, idOf(t))[0] !== from);
  return [...kept, ...next].sort((a, b) => rank(a) - rank(b));
}

/** The websocket URL for a path on a backend: the page's own host for home
 *  (an empty base), else the backend's base with ws in place of http. */
export function wsUrl(base: string, page: { protocol: string; host: string }, path: string): string {
  if (!base) return `${page.protocol === "https:" ? "wss" : "ws"}://${page.host}${path}`;
  return `${base.replace(/^http/, "ws")}${path}`;
}

/** Whether a source id is a backend's launch root, whichever backend. */
export const isLaunchSource = (source: string): boolean =>
  source === LAUNCH_SOURCE || source.endsWith(`${SEP}${LAUNCH_SOURCE}`);

/** The gate's login URL with `next` set to a backend's own base, so it sends
 *  the browser back to that backend once it signs in: one shared cookie
 *  covers every backend, but the redirect target is not the page's own. */
export function signinUrl(login: string, next: string): string {
  const sep = login.includes("?") ? "&" : "?";
  return `${login}${sep}next=${encodeURIComponent(next)}`;
}

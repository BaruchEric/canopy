/* This page's caller tokens: one per backend, minted when the page signs in
   to it (a pair request someone approved) and sent as `X-Canopy-Token` on
   every call to that backend and no other. Kept in localStorage under
   `canopy.token.<backend origin>`, so two backends' tokens stay apart and a
   bundled dashboard on the same origin (the Library's) can read its own.
   Read and written through try/catch, since storage can be blocked; pure but
   for the storage calls, which take the storage as an argument; tested. */

import type { PendingPair } from "../../src/core/types";
import { kindOfLabel, KIND_RIGHTS, type CallerKind, type PairKind, type Right } from "../../src/core/callers";

/** the header a token rides in */
export const TOKEN_HEADER = "X-Canopy-Token";

/** where a backend's token is kept, by its origin */
export const tokenKey = (origin: string): string => `canopy.token.${origin}`;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const local = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** A backend's origin from its base URL: the page's own for "" (home), and
 *  "" where there is no page (tests). The same string `location.origin`
 *  gives, so a page on that origin finds the same key. */
export function originOf(base: string): string {
  if (!base) return typeof location === "undefined" ? "" : location.origin;
  try {
    return new URL(base).origin;
  } catch {
    return base;
  }
}

/** the token this page holds for a backend, or null */
export function readToken(origin: string, store: Store | null = local()): string | null {
  try {
    const t = store?.getItem(tokenKey(origin))?.trim();
    return t ? t : null;
  } catch {
    return null;
  }
}

/** Keeps a backend's token (null forgets it); false when storage refused. */
export function writeToken(origin: string, token: string | null, store: Store | null = local()): boolean {
  try {
    if (!store) return false;
    if (token === null) store.removeItem(tokenKey(origin));
    else store.setItem(tokenKey(origin), token);
    return true;
  } catch {
    return false;
  }
}

/** The headers a call to a backend carries: what the caller passed, and the
 *  token when this page holds one for that origin. */
export function tokenHeaders(origin: string, init?: HeadersInit, store: Store | null = local()): Headers {
  const h = new Headers(init);
  const t = readToken(origin, store);
  if (t) h.set(TOKEN_HEADER, t);
  return h;
}

/** A page's pair label. The request names its kind, but a server from before
 *  that still reads the kind from a "cli " or "helper " prefix, so a device
 *  named that way is marked as a page. */
export function pairLabel(device: string): string {
  const d = device.trim();
  if (!d) return "a browser";
  return /^(cli|helper) /.test(d) ? `page ${d}` : d;
}

const LABEL_SHOWN = 40;

/** How a pair request reads to the person who approves it: the heading with
 *  who asks, from where, and the kind it would get, then the rights that
 *  grants. `admin` is flagged, since one approval of it lets the asker
 *  approve and revoke. The label is cut for the card and whole in `title`. A
 *  request from a backend older than the kind has none, so the label rule
 *  the backend itself applies is used. */
export function pairAsk(p: PendingPair, backend: string): { head: string; title: string; rights: readonly Right[]; admin: boolean } {
  const kind: PairKind = (p as { kind?: PairKind }).kind ?? kindOfLabel(p.label);
  const rights = KIND_RIGHTS[kind];
  const label = p.label.length > LABEL_SHOWN ? `${p.label.slice(0, LABEL_SHOWN - 1)}\u2026` : p.label;
  return { head: `${label} asks to sign in${backend ? ` to ${backend}` : ""}, from ${p.addr}. It would get ${kind} rights:`, title: p.label, rights, admin: rights.includes("admin") };
}

/** Whether what was typed in the first-code box is the pair's own code, which
 *  is shown to match and is not the first code. */
export function isOwnCode(typed: string, own: string): boolean {
  const t = typed.trim().toUpperCase();
  return t !== "" && t === own.trim().toUpperCase();
}

/** What `GET /api/auth` answers: the mode, the refusals so far, the callers
 *  the backend knows, the pair requests waiting, and who this page is. */
export interface AuthInfo {
  mode: "off" | "log" | "enforce";
  refused: { count: number; recent: { kind: CallerKind; route: string; origin: string; ua: string; at: number }[] };
  callers: { id: string; kind: CallerKind; label: string; term?: string; run?: string; created: number; used: number }[];
  pending: PendingPair[];
  you: CallerKind;
  youId: string | null;
}

/** One backend's sign-in as the page keeps it: what it last said, whether
 *  this page holds a token for it, and whether a call was refused for want
 *  of one since. */
export interface BackendAuth extends AuthInfo {
  hasToken: boolean;
  needed: boolean;
}

/** A sign-in on its way: waiting on approval with the code to match, or one
 *  that ended without a token. */
export type SignIn = { state: "waiting"; id: string; code: string } | { state: "failed"; why: string };

/** How a shell's socket dials: with the ticket it got, bare where the
 *  backend lets a ticketless shell through (log, off, or no caller check at
 *  all), or not until this page signs in. A refused ticket on a backend whose
 *  mode is not read yet counts as enforce, since only a check refuses. */
export type DialPlan = { kind: "ticket"; ticket: string } | { kind: "bare" } | { kind: "wait" };

export function dialPlan(mode: AuthInfo["mode"] | undefined, ticket: string | null, refused: boolean): DialPlan {
  if (ticket) return { kind: "ticket", ticket };
  if (mode === "enforce") return { kind: "wait" };
  if (refused && mode === undefined) return { kind: "wait" };
  return { kind: "bare" };
}

/** whether a reply is `/api/auth`'s, not an older backend's 404 or a stub's */
export const isAuthInfo = (v: unknown): v is AuthInfo =>
  typeof v === "object" && v !== null && typeof (v as { mode?: unknown }).mode === "string" && Array.isArray((v as { pending?: unknown }).pending);

/* The wall a team's folders make (FR-074, plan 2), as the page keeps to it.
   A backend that holds this page to its teams' folders refuses every route
   the wall does not file. The page asks no such route of it: the request
   function waits until the backend's auth answer says whether the page is
   held, then answers a closed route itself, with the refusal the backend
   would give, and nothing goes over the wire. The table is the server's own
   (core/scope.ts), so the two cannot drift. Pure but for the per-backend
   state, which the request function and the auth read share; tested.
   A role is kept the same way: a route the page's own rights do not cover
   on a backend that checks them is answered here with the role's refusal,
   so a viewer's page sends nothing the backend would refuse. */

import { needs, type Right } from "../../src/core/callers";
import { SCOPE_CLOSED, scopeRule } from "../../src/core/scope";

/** whether a held page may ask a backend for this, by the wall's table: a
 *  route open to anyone, or one the wall files */
export function scopeReaches(method: string, path: string): boolean {
  const bare = path.split("?", 1)[0] ?? path;
  return needs(method, bare) === "open" || scopeRule(method, bare) !== null;
}

/** the refusal a closed route answers, as the request function throws it */
export const scopeRefusal = (): Error & { status: number; body: { error: string; scoped: true } } =>
  Object.assign(new Error(SCOPE_CLOSED), { status: 403, body: { error: SCOPE_CLOSED, scoped: true as const } });

/** the right a request needs, by the server's own table; open for one any
 *  caller reaches */
export const needOf = (method: string, path: string): Right | "open" => needs(method, path.split("?", 1)[0] ?? path);

/** the refusal the backend gives a role that does not hold a right */
export const roleRefusal = (need: Right): Error & { status: number; body: { error: string; need: Right } } => {
  const error = `this call needs the ${need} right; your role on this backend does not hold it`;
  return Object.assign(new Error(error), { status: 403, body: { error, need } });
};

/** how long a closed route waits for the auth answer before going anyway */
export const SCOPE_WAIT = 4000;

interface Held {
  scoped: boolean | null;
  /** what the last answer said, kept through a drop */
  last: boolean | null;
  waiters: ((scoped: boolean) => void)[];
}

/** Whether each backend holds this page to its teams' folders, and the
 *  requests waiting to know. A backend not heard from yet is unknown. */
export class ScopeBook {
  private held = new Map<string, Held>();

  private of(b: string): Held {
    let h = this.held.get(b);
    if (!h) {
      h = { scoped: null, last: null, waiters: [] };
      this.held.set(b, h);
    }
    return h;
  }

  /** what a backend's auth answer said; the requests waiting on it go */
  known(b: string, scoped: boolean): void {
    const h = this.of(b);
    h.scoped = scoped;
    h.last = scoped;
    const waiting = h.waiters;
    h.waiters = [];
    for (const w of waiting) w(scoped);
  }

  /** forgets it, after a stream drop that may have been a change of teams:
   *  the next auth read says again */
  unknown(b: string): void {
    this.of(b).scoped = null;
  }

  /** an auth read that did not answer: what the last answer said stands,
   *  so a page held before a drop stays held while the backend is away; a
   *  backend never heard from holds nothing back */
  failed(b: string): void {
    this.known(b, this.of(b).last ?? false);
  }

  /** whether the backend holds this page, once its auth answer says; a
   *  backend that never answers is taken for one that does not */
  scoped(b: string, wait = SCOPE_WAIT): Promise<boolean> {
    const h = this.of(b);
    if (h.scoped !== null) return Promise.resolve(h.scoped);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), wait);
      h.waiters.push((v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }

  /** what is known now, with no wait: null for unknown */
  now(b: string): boolean | null {
    return this.held.get(b)?.scoped ?? null;
  }
}

/** The views a page held to its teams' folders loads: the board, the
 *  shells, and the people. Every other view reads routes the wall closes. */
export const HELD_VIEWS: readonly string[] = ["git", "sessions", "people"];

/** whether every backend this page shows holds it to its teams' folders */
export const heldEverywhere = (order: readonly string[], auths: Readonly<Record<string, { scope?: string[] | null } | undefined>>): boolean =>
  order.length > 0 && order.every((b) => (auths[b]?.scope?.length ?? 0) > 0);

/** whether a view shows, held everywhere or not */
export const viewShown = (view: string, held: boolean): boolean => !held || HELD_VIEWS.includes(view);

/** whether an error is the wall's refusal, the page's own or the backend's */
export function isScoped(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("body" in err)) return false;
  const body: unknown = err.body;
  return typeof body === "object" && body !== null && "scoped" in body && body.scoped === true;
}

/** a read a held page goes without: the wall's refusal answers `empty`,
 *  anything else still fails */
export const scopedOr =
  <T,>(empty: T) =>
  (err: unknown): T => {
    if (isScoped(err)) return empty;
    throw err;
  };

/** Who a request is being handled for (FR-074): the person, by id, and the
 *  kind of caller they came through. route() sets it around a request and a
 *  socket's open, so the few places that mint a token or start a run in
 *  someone's name read it here instead of taking a caller through every
 *  signature between.
 *
 *  Node's AsyncLocalStorage follows every promise and timer made inside the
 *  request, a queue's later pump included. So only a start a person asked
 *  for reads it (`byWhom` in index.ts, which a start made in another's name
 *  skips), never the runner or a hub on its own. Bun-only. */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CallerKind } from "../core/callers";

export interface Actor {
  /** the person's id */
  person: string;
  kind: CallerKind;
}

const store = new AsyncLocalStorage<Actor>();

export const asActor = <T>(who: Actor, fn: () => T): T => store.run(who, fn);

export const actor = (): Actor | undefined => store.getStore();

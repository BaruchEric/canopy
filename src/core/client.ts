/**
 * Which desktop a browser opens on. Browser-safe (the store derives the
 * menu's openers from it) and pure; the server uses the same `isLoopback`
 * and `clientKey` to say what it knows of a browser. Tested in
 * client.test.ts.
 */
import { OPENER_IDS, type ClientCaps, type ClientInfo, type HelperInfo, type OpenerId } from "./types";

/** What a browser can open and through what. Its own choice of helper
 *  (`chosen`, a name in its settings) wins when that helper is attached;
 *  with no choice, the one helper at the browser's own address is adopted
 *  (never when the address is `shared`, a proxy's, or loopback: every
 *  browser behind that proxy or on the backend's own machine would claim
 *  it); else the backend's own desktop when the browser is on it (`local`);
 *  else nothing. */
export function clientCaps(client: ClientInfo, helpers: HelperInfo[], chosen: string | null): ClientCaps {
  const picked = chosen === null ? null : (helpers.find((h) => h.name === chosen) ?? null);
  const helper = picked ?? (chosen === null ? adoptable(client, helpers) : null);
  if (helper) return { openers: helper.openers, via: "helper", helper };
  if (client.local) return { openers: ALL, via: "backend", helper: null };
  return { openers: NONE, via: null, helper: null };
}

// the same arrays every time, so a store selector over this compares
// shallow-equal between calls and does not re-render its component forever
const ALL: OpenerId[] = [...OPENER_IDS];
const NONE: OpenerId[] = [];

function adoptable(client: ClientInfo, helpers: HelperInfo[]): HelperInfo | null {
  if (client.shared || isLoopback(client.address)) return null;
  const here = helpers.filter((h) => h.address === client.address);
  return here.length === 1 ? here[0]! : null;
}

/** whether an address is the machine the server runs on: a browser there
 *  gets the backend's own desktop when it has one */
export function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
}

/** one address as the helper map keys it: an IPv4-mapped IPv6 address
 *  becomes the IPv4 it carries, so a helper over one family matches a
 *  browser over the other */
export function clientKey(address: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return m ? m[1]! : address;
}

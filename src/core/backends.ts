import { isPeerName } from "./peers";
import type { BackendEntry } from "./types";

/** whether `v` is exactly an origin (no path, query or trailing slash) with
 *  one of the protocols given */
function isOrigin(v: unknown, protocols: readonly string[]): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return protocols.includes(u.protocol) && u.origin === v;
  } catch {
    return false;
  }
}

/** The config's `backends`, validated field by field like `normalizePeers`:
 *  a peer name, at least one url, `public` https, `tailnet` http or https,
 *  names unique (the first wins). */
export function normalizeBackends(v: unknown): BackendEntry[] {
  if (!Array.isArray(v)) return [];
  const out: BackendEntry[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = r["name"];
    if (typeof name !== "string" || !isPeerName(name)) continue;
    if (out.some((b) => b.name === name)) continue;
    const entry: BackendEntry = { name };
    if (r["public"] !== undefined) {
      if (!isOrigin(r["public"], ["https:"])) continue;
      entry.public = r["public"];
    }
    if (r["tailnet"] !== undefined) {
      if (!isOrigin(r["tailnet"], ["http:", "https:"])) continue;
      entry.tailnet = r["tailnet"];
    }
    if (!entry.public && !entry.tailnet) continue;
    out.push(entry);
  }
  return out;
}

/** This backend's name: its peer name when set, else its hostname's first
 *  label as a peer-name slug. */
export function selfName(self: string | null, host: string): string {
  if (self) return self;
  const label = (host.split(".")[0] ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
  if (!label) return "canopy";
  return /^[a-z]/.test(label) ? label : `b-${label}`;
}

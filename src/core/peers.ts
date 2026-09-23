/** Peer sync, the pure half: every machine keeps its own clone of each repo
 *  and pulls the others' branches and WIP snapshots. Browser-safe: no Bun or
 *  node imports, since the UI reads the types and words from here. */
import type { Peer, PeerRole, PeerSync } from "./types";

export const PEER_SYNC: readonly PeerSync[] = ["off", "dry", "on"];
export const DEFAULT_SEED = [".env", ".env.local"];

/** A peer's name is a git remote name too, so it stays plain; `origin` is
 *  taken by the repo's own remote. */
export const isPeerName = (s: string): boolean => /^[a-z][a-z0-9-]{0,31}$/.test(s) && s !== "origin";

/** SSH alias validation regex, mirrors isSshHost from host.ts, kept here so
 *  the UI can import this file without importing from host.ts. */
const SSH_ALIAS = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isRole = (v: unknown): v is PeerRole => v === "git" || v === "mirror";

export function normalizePeers(v: unknown): Peer[] {
  if (!Array.isArray(v)) return [];
  const out: Peer[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const { name, alias, root } = r;
    if (typeof name !== "string" || !isPeerName(name)) continue;
    if (typeof alias !== "string" || !SSH_ALIAS.test(alias)) continue;
    if (typeof root !== "string" || root === "" || root.includes("..")) continue;
    if (out.some((p) => p.name === name)) continue;
    const peer: Peer = { name, alias, root, role: isRole(r["role"]) ? r["role"] : "git" };
    if (Array.isArray(r["repos"])) peer.repos = r["repos"].filter((g): g is string => typeof g === "string" && g !== "");
    out.push(peer);
  }
  return out;
}

/** Seed entries are file names or simple globs, never paths. */
export function normalizeSeed(v: unknown): string[] {
  if (!Array.isArray(v)) return [...DEFAULT_SEED];
  return v.filter((s): s is string => typeof s === "string" && s !== "" && !s.includes("/"));
}

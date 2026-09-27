/** Peer sync, the pure half: every machine keeps its own clone of each repo
 *  and pulls the others' branches and WIP snapshots. Browser-safe: no Bun or
 *  node imports, since the UI reads the types and words from here. */
import type { Peer, PeerBranch, PeerRole, PeerState, PeerSync, PeerWip, PeerWipPath, Repo } from "./types";

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

export const NO_PUSH = "canopy-peer-no-push";

export function peerUrl(peer: Peer, id: string): string {
  const path = `${peer.root.replace(/\/+$/, "")}/${id}`;
  return peer.alias === null ? path : `${peer.alias}:${path}`;
}

export const peerRefspecs = (name: string): [string, string] => [
  `+refs/heads/*:refs/remotes/${name}/*`,
  `+refs/wip/*:refs/peer-wip/${name}/*`,
];

export function globMatch(glob: string, s: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(s);
}

export const repoWanted = (peer: Peer, id: string): boolean =>
  !peer.repos || peer.repos.some((g) => globMatch(g, id));

export const seedWanted = (allow: string[], file: string): boolean => {
  const base = file.split("/").pop() ?? file;
  return allow.some((g) => globMatch(g, base));
};

/** Whether a repo id or seed file name from a peer's listing is safe to
 *  turn into a path here: a relative path with no empty, "." or ".."
 *  segment, no leading "-" on the whole name (so it is never taken for a
 *  flag), no leading "/", and no NUL or newline. A peer's listing is
 *  untrusted input, whatever runs on the far end of it; anything that
 *  fails this is skipped rather than guessed at. */
export function isSafeRel(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.startsWith("-") || /[\0\n]/.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

export const BUSY_MARKERS = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock"] as const;

export interface Tip { peer: string; hash: string; ahead: number; behind: number }
export type FfDecision = { to?: { peer: string; hash: string }; diverged: PeerBranch[] };

/** Where a branch may fast-forward to. A tip strictly ahead of ours is a
 *  candidate; one that also lacks some of ours has diverged from us. Of the
 *  candidates, the one that contains every other wins; when none does, the
 *  peers disagree with each other and nothing moves. */
export function ffTarget(branch: string, tips: Tip[], contains: (a: string, b: string) => boolean): FfDecision {
  const diverged: PeerBranch[] = tips
    .filter((t) => t.ahead > 0 && t.behind > 0)
    .map((t) => ({ branch, peer: t.peer, ahead: t.ahead, behind: t.behind }));
  const ahead = tips.filter((t) => t.ahead > 0 && t.behind === 0);
  if (ahead.length === 0) return { diverged };
  const top = ahead.find((t) => ahead.every((o) => contains(t.hash, o.hash)));
  if (top) return { to: { peer: top.peer, hash: top.hash }, diverged };
  return {
    diverged: [...diverged, ...ahead.map((t) => ({ branch, peer: t.peer, ahead: t.ahead, behind: t.behind }))],
  };
}

export function parseRefLines(out: string): { ref: string; hash: string }[] {
  return out.split("\n").filter(Boolean).flatMap((l) => {
    const sp = l.indexOf(" ");
    if (sp === -1) return [];
    return [{ hash: l.slice(0, sp), ref: l.slice(sp + 1) }];
  });
}

export function parseWipLines(out: string, peer: string): Omit<PeerWip, "files">[] {
  const prefix = `refs/peer-wip/${peer}/`;
  return out.split("\n").filter(Boolean).flatMap((l) => {
    const [hash, unix, parent, ref] = l.split(" ");
    if (!hash || !unix || !parent || !ref?.startsWith(prefix)) return [];
    return [{ peer, branch: ref.slice(prefix.length), at: Number(unix) * 1000, parent, hash }];
  });
}

/** How many of a WIP's paths ride along in PeerState. It goes out over SSE
 *  on every change, so a WIP of thousands of files sends its count, not
 *  its whole list. */
export const WIP_PATHS = 50;

/** `git diff --name-status -z --no-renames` output: a status word and a
 *  path per entry, NUL-separated. --no-renames keeps every entry at two
 *  fields; a rename reads as a D and an A. */
export function parseNameStatus(out: string, cap = WIP_PATHS): { files: number; paths: PeerWipPath[] } {
  const words = out.split("\0");
  const paths: PeerWipPath[] = [];
  let files = 0;
  for (let i = 0; i + 1 < words.length; i += 2) {
    const status = words[i]?.charAt(0);
    const path = words[i + 1];
    if (!status || !path) continue;
    files++;
    if (paths.length < cap) paths.push({ status, path });
  }
  return { files, paths };
}

export const peerMissing = (stderr: string): boolean =>
  /does not appear to be a git repository|not a repo:|repository .* not found|No such file or directory/i.test(stderr);

export const peerUnreachable = (stderr: string): boolean =>
  /ssh: (connect to host|Could not resolve)|Connection (closed|refused|timed out|reset)|Operation timed out|Host is down|No route to host|Permission denied \(publickey/i.test(stderr);

/** POSIX words as ssh hands them over: bare words, single quotes (with the
 *  '\'' idiom), double quotes holding no `$`, backtick or backslash. Anything
 *  a shell would expand, redirect or chain is refused, so the gate never
 *  needs a shell. */
export function parseQuotedWords(line: string): string[] | null {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === " " || c === "\t") {
      if (inWord) { words.push(cur); cur = ""; inWord = false; }
      continue;
    }
    inWord = true;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      const end = line.indexOf('"', i + 1);
      if (end === -1) return null;
      const body = line.slice(i + 1, end);
      if (/[$`\\]/.test(body)) return null;
      cur += body;
      i = end;
    } else if (c === "\\") {
      if (i + 1 >= line.length) return null;
      const next = line[i + 1]!;
      if (next === "\n") return null;
      cur += next;
      i++;
    } else if (/[A-Za-z0-9_@%+=:,./-]/.test(c)) {
      cur += c;
    } else {
      return null;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

export const linkPeers = (repos: Repo[], states: Map<string, PeerState>): Repo[] =>
  repos.map((r) => {
    const p = states.get(r.id);
    return p && r.peers !== p ? { ...r, peers: p } : r;
  });

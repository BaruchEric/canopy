/** A local commit that upstream holds an amended copy of (FR-048,
 *  `docs/superpowers/specs/2026-11-02-push-amend-design.md`). Pure and
 *  browser-safe: git.ts gathers the facts and moves the branch, and the
 *  page reads an offer off a refused push with `isStaleOffer`. */

/** One commit as the match reads it. */
export interface CommitFacts {
  hash: string;
  /** how many parents: a merge has two or more */
  parents: number;
  /** author time, unix seconds */
  at: number;
  email: string;
  /** subject and body as git keeps them, trailing whitespace off */
  message: string;
}

/** A stale local commit and the upstream commit that is its amend. */
export interface StaleCopy {
  stale: string;
  copy: string;
  subject: string;
}

/** What a refused push offers: drop `copies` (oldest first) by moving
 *  `branch` onto `onto`, the tip of `upstream`, keeping the `kept` local
 *  commits that came after them. */
export interface StaleOffer {
  branch: string;
  upstream: string;
  onto: string;
  copies: StaleCopy[];
  kept: number;
}

/** what `log` prints for each commit, read back by `parseCommits` */
export const COMMIT_FORMAT = "%H%x1f%P%x1f%at%x1f%ae%x1f%B%x1e";

export function parseCommits(out: string): CommitFacts[] {
  const commits: CommitFacts[] = [];
  for (const record of out.split("\x1e")) {
    const [hash, parents, at, email, ...message] = record.replace(/^\n+/, "").split("\x1f");
    if (!hash || at === undefined || email === undefined) continue;
    commits.push({
      hash,
      parents: (parents ?? "").split(" ").filter(Boolean).length,
      at: Number(at),
      email,
      message: message.join("\x1f").trimEnd(),
    });
  }
  return commits;
}

export const subjectOf = (c: CommitFacts): string => c.message.split("\n")[0] ?? "";
const short = (hash: string): string => hash.slice(0, 7);
const commits = (n: number): string => `${n} commit${n === 1 ? "" : "s"}`;

/** An amend keeps the message, the author and the author time. */
export const sameCommit = (a: CommitFacts, b: CommitFacts): boolean =>
  a.message === b.message && a.at === b.at && a.email === b.email;

export type Pairing = { pairs: { stale: CommitFacts; copy: CommitFacts }[] } | { ambiguous: string };

/** Each local commit with the upstream commit that matches it. A local
 *  commit matching two upstream ones, or two local commits matching one,
 *  cannot say which is the amend. */
export function pairCopies(local: readonly CommitFacts[], upstream: readonly CommitFacts[]): Pairing {
  const pairs: { stale: CommitFacts; copy: CommitFacts }[] = [];
  const taken = new Set<string>();
  for (const stale of local) {
    const found = upstream.filter((u) => sameCommit(stale, u));
    if (found.length > 1) {
      return { ambiguous: `${short(stale.hash)} has ${found.length} commits upstream with its message and author time, so canopy cannot tell which one is its amend.` };
    }
    const copy = found[0];
    if (!copy) continue;
    if (taken.has(copy.hash)) {
      return { ambiguous: `More than one local commit has the message and author time of upstream's ${short(copy.hash)}, so canopy cannot tell which one it amends.` };
    }
    taken.add(copy.hash);
    pairs.push({ stale, copy });
  }
  return { pairs };
}

/** The paths, of `paths`, where `diff --numstat -z --no-renames` from the
 *  stale commit to its copy removes a line or sees a binary change: the
 *  files whose lines the copy leaves out. */
export function linesLeftOut(paths: readonly string[], numstat: string): string[] {
  const wanted = new Set(paths);
  const out: string[] = [];
  for (const record of numstat.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t([^]*)$/.exec(record);
    if (!m) continue;
    const [, , removed, path = ""] = m;
    if (wanted.has(path) && removed !== "0") out.push(path);
  }
  return out;
}

export type StaleVerdict =
  | { kind: "none" }
  | { kind: "refuse"; why: string }
  | { kind: "drop"; copies: StaleCopy[]; kept: number };

/** Whether the local commits (merge base to HEAD, oldest first) start with
 *  stale copies canopy can drop with one `rebase --onto`. `leftOut` holds,
 *  per stale hash, the files whose lines its copy leaves out; a stale
 *  commit missing from it counts as not checked. */
export function judgeCopies(
  local: readonly CommitFacts[],
  pairing: Pairing,
  leftOut: ReadonlyMap<string, readonly string[]>,
): StaleVerdict {
  if ("ambiguous" in pairing) return { kind: "refuse", why: pairing.ambiguous };
  const { pairs } = pairing;
  if (pairs.length === 0) return { kind: "none" };
  const first = pairs[0]!.stale.hash;
  if (local.some((c) => c.parents > 1)) {
    return { kind: "refuse", why: `Upstream holds an amended copy of ${short(first)}, but the branch has merge commits of its own, which moving it would flatten.` };
  }
  for (const [i, { stale }] of pairs.entries()) {
    if (local[i]?.hash !== stale.hash) {
      const under = local.findIndex((c) => c.hash === stale.hash) - i;
      return {
        kind: "refuse",
        why: `Upstream holds an amended copy of ${short(stale.hash)}, but it sits on ${commits(under)} of your own that upstream lacks, and moving the branch past it would drop those too.`,
      };
    }
  }
  for (const { stale, copy } of pairs) {
    const files = leftOut.get(stale.hash);
    if (!files || files.length > 0) {
      return {
        kind: "refuse",
        why: `Upstream's ${short(copy.hash)} has the message and author time of ${short(stale.hash)}, but it leaves out lines ${short(stale.hash)} has${files?.length ? ` in ${files.join(", ")}` : ""}, so canopy will not drop it.`,
      };
    }
  }
  return {
    kind: "drop",
    copies: pairs.map(({ stale, copy }) => ({ stale: stale.hash, copy: copy.hash, subject: subjectOf(stale) })),
    kept: local.length - pairs.length,
  };
}

/** The sentence a refused push adds about the copies, and what dropping
 *  them does. */
export function offerWords(o: StaleOffer): string {
  const one = o.copies.length === 1 ? o.copies[0] : undefined;
  const head = one
    ? `Upstream holds an amended copy of ${short(one.stale)} ${one.subject} (${short(one.copy)}: same message and author time, and every line ${short(one.stale)} left in its files).`
    : `Upstream holds amended copies of ${commits(o.copies.length)}: ${o.copies.map((c) => `${short(c.stale)} ${c.subject} (${short(c.copy)})`).join(", ")}. Each has the same message and author time, and every line the stale one left in its files.`;
  const keep = o.kept > 0 ? ` and keeps the ${commits(o.kept)} after ${one ? "it" : "them"}` : "";
  return `${head} Dropping the stale ${one ? "copy" : "copies"} moves ${o.branch} onto ${o.upstream} with git rebase --onto${keep}.`;
}

/** The button's words. */
export const offerAction = (o: StaleOffer): string =>
  `drop the stale ${o.copies.length === 1 ? "copy" : "copies"}${o.kept > 0 ? " and push" : ""}`;

/** a whole commit hash, sha1 or sha256: what the offer carries and the
 *  action takes back, so nothing shorter can name a different commit */
export const isFullHash = (v: unknown): v is string => typeof v === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v);

/** An offer as it came over the wire, or false. */
export function isStaleOffer(v: unknown): v is StaleOffer {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["branch"] === "string" &&
    typeof o["upstream"] === "string" &&
    isFullHash(o["onto"]) &&
    typeof o["kept"] === "number" &&
    Array.isArray(o["copies"]) &&
    o["copies"].length > 0 &&
    o["copies"].every((c: unknown) => {
      const r = c as Record<string, unknown> | null;
      return typeof r === "object" && r !== null && isFullHash(r["stale"]) && isFullHash(r["copy"]) && typeof r["subject"] === "string";
    })
  );
}

/** the newest stale commit, which `rebase --onto` names as the old base */
export const newestStale = (o: Pick<StaleOffer, "copies">): string => o.copies[o.copies.length - 1]!.stale;

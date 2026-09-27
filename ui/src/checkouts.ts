import type { Repo } from "../../src/core/types";
import { webUrl } from "../../src/core/remote";
import { changedAt } from "./grouping";

/** One repo on the board, with every machine that has it checked out. */
export interface RepoCard {
  /** what ties its checkouts: the first remote with a web page as
   *  lowercase host/owner/name, `rel:<plain id>` without one, `forge:<id>`
   *  for a repo that lives only on a forge; `#<plain id>` after it for a
   *  second checkout on one backend */
  key: string;
  name: string;
  /** at most one per backend, in the registry's order; never empty */
  checkouts: Repo[];
}

/** A repo's first remote that maps to a web page, as lowercase
 *  host/owner/name. A peer remote is an ssh alias and never maps. */
export function remoteKey(repo: Repo): string | null {
  for (const url of repo.remotes ?? []) {
    const web = webUrl(url);
    if (!web) continue;
    const u = new URL(web);
    return `${u.host}${u.pathname}`.toLowerCase();
  }
  return null;
}

/** Every repo as a card, checkouts of one repo on different backends on
 *  one card. A second checkout on a backend that already has one on the
 *  card gets its own, so one backend's board is one card per repo, in the
 *  order given. */
export function joinRepos(
  repos: readonly Repo[],
  names: readonly string[],
  split: (id: string) => [string, string],
): RepoCard[] {
  const rank = (r: Repo): number => {
    const i = names.indexOf(split(r.id)[0]);
    return i < 0 ? names.length : i;
  };
  const byKey = new Map<string, RepoCard>();
  const out: RepoCard[] = [];
  for (const r of [...repos].sort((a, b) => rank(a) - rank(b))) {
    const [backend, plain] = split(r.id);
    let key = r.forge ? `forge:${r.id}` : (remoteKey(r) ?? `rel:${plain}`);
    if (byKey.get(key)?.checkouts.some((c) => split(c.id)[0] === backend)) key = `${key}#${plain}`;
    let card = byKey.get(key);
    if (!card) {
      card = { key, name: r.name, checkouts: [] };
      byKey.set(key, card);
      out.push(card);
    }
    card.checkouts.push(r);
  }
  return out;
}

/** The checkout a card shows and opens: the one last used for it while
 *  its backend is online, else the first online one, else the last used,
 *  else the first. */
export function leadOf(
  card: RepoCard,
  pref: string | undefined,
  online: (backend: string) => boolean,
  backendOf: (id: string) => string,
): Repo {
  const on = (c: Repo) => online(backendOf(c.id));
  const mine = (c: Repo) => backendOf(c.id) === pref;
  return (
    card.checkouts.find((c) => mine(c) && on(c)) ??
    card.checkouts.find(on) ??
    card.checkouts.find(mine) ??
    (card.checkouts[0] as Repo)
  );
}

/** When anything on the card last changed: its newest checkout's change. */
export const cardChangedAt = (card: RepoCard): number => Math.max(0, ...card.checkouts.map(changedAt));

import type { Repo } from "../../src/core/types";
import type { RepoCard } from "../../src/core/cards";
import { changedAt } from "./grouping";
export { joinRepos, remoteKey, type RepoCard } from "../../src/core/cards";

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
/** A card is a favorite when any of its checkouts is starred. */
export const cardFavorite = (card: RepoCard): boolean => card.checkouts.some((r) => r.favorite === true);
export const cardChangedAt = (card: RepoCard): number => Math.max(0, ...card.checkouts.map(changedAt));

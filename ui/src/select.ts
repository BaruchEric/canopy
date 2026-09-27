import type { Repo } from "../../src/core/types";
import { matchesFilter, REPO_FILTERS, type RepoFilter } from "./filters";
import { pickable } from "./flows";
import { groupRepos, sectionKey } from "./grouping";
import type { SortMode } from "./settings";

/** How much of a set is picked: the word a tri-state tick shows. */
export type PickState = "all" | "some" | "none";

/** How many of `ids` are in `selected`. */
export function pickCount(selected: readonly string[], ids: readonly string[]): number {
  const have = new Set(selected);
  let n = 0;
  for (const id of ids) if (have.has(id)) n++;
  return n;
}

/** Nothing to pick reads as none, so an empty group's tick is blank. */
export function pickState(selected: readonly string[], ids: readonly string[]): PickState {
  if (!ids.length) return "none";
  const n = pickCount(selected, ids);
  return n === 0 ? "none" : n === ids.length ? "all" : "some";
}

/** `ids` set to `on`; the rest of `selected` stays, in the order it came. */
export function setPick(selected: readonly string[], ids: readonly string[], on: boolean): string[] {
  if (!on) {
    const drop = new Set(ids);
    return selected.filter((x) => !drop.has(x));
  }
  const have = new Set(selected);
  return [...selected, ...ids.filter((x) => !have.has(x))];
}

/** A group's tick: picks the whole group unless every member is picked already, then clears it. */
export function togglePick(selected: readonly string[], ids: readonly string[]): string[] {
  return setPick(selected, ids, pickState(selected, ids) !== "all");
}

/** Every id in `ids` flipped; ids outside it stay as they were. */
export function invertPick(selected: readonly string[], ids: readonly string[]): string[] {
  const have = new Set(selected);
  const flip = new Set(ids);
  return [...selected.filter((x) => !flip.has(x)), ...ids.filter((x) => !have.has(x))];
}

/** The ids from `anchor` to `target` in `order`, inclusive, either way round.
 *  With no anchor in `order`, just the target: a shift-click on a fresh
 *  board is a plain click. */
export function rangeIds(order: readonly string[], anchor: string | null, target: string): string[] {
  const a = anchor === null ? -1 : order.indexOf(anchor);
  const b = order.indexOf(target);
  if (a < 0 || b < 0) return [target];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** The pickable repos in the order the board lays them out, group by group,
 *  so a range reads top to bottom the way the eye does. A folded group is
 *  left out: a range drawn between two cards should not take what sits
 *  hidden between them. */
export function boardOrder(
  repos: Repo[],
  sort: SortMode,
  collapsed: readonly string[] = [],
  at?: (r: Repo) => number,
): string[] {
  return groupRepos(repos, sort, undefined, at)
    .filter((g) => !collapsed.includes(sectionKey(sort, g.key)))
    .flatMap((g) => g.repos.filter(pickable).map((r) => r.id));
}

/** The facets the bar offers as one-click picks. Unreadable repos are never
 *  pickable, so that facet would pick nothing. */
export const PICK_FACETS = REPO_FILTERS.filter((f) => f !== "unreadable");

/** The pickable repos in `repos` that answer yes to the facet. */
export function pickWhere(repos: Repo[], facet: RepoFilter): string[] {
  return repos.filter((r) => pickable(r) && matchesFilter(r, facet)).map((r) => r.id);
}

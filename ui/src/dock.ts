/** The dock's tab arithmetic: which panel shows when the dock is tabbed.
 *  Pure, so the store's four ways of opening a panel all go through one
 *  place and the close rule is tested rather than guessed. */

/** Adds `id` to the open panels if it is not there and makes it the one
 *  showing. Opening a panel that is already open just brings its tab
 *  forward, which is what a second click on a card should do. */
export function focusPanel(
  panels: readonly string[],
  id: string,
): { panels: string[]; activePanel: string } {
  return {
    panels: panels.includes(id) ? [...panels] : [...panels, id],
    activePanel: id,
  };
}

/** The tab to show after `closing` leaves `panels`: the one it was showing
 *  if that stays, else the tab to its right, else the one to its left, else
 *  nothing. `active` may already be stale (a scan pruned it); then the first
 *  remaining tab shows. */
export function nextActive(
  panels: readonly string[],
  closing: string,
  active: string | null,
): string | null {
  const rest = panels.filter((p) => p !== closing);
  if (rest.length === 0) return null;
  if (active !== null && active !== closing && rest.includes(active)) return active;
  const i = panels.indexOf(closing);
  if (i === -1) return rest[0] ?? null;
  // `rest` is `panels` with one gap at `i`, so index `i` in it is the tab
  // that sat to the right of the closed one
  return rest[Math.min(i, rest.length - 1)] ?? null;
}

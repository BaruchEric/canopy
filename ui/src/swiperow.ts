/** A phone's swipe row (the side by side dock below PHONE): which of its
 *  panels is showing, from where the row is scrolled to. Pure, so the
 *  dots under the row (Dock.tsx, FR-008) are tested here. */

/** The index of the panel showing: the one whose left edge is nearest the
 *  row's scroll position, the earlier of two at the same distance, so
 *  mid-swipe the dot moves once the next panel is more than half in.
 *  `edges` are the panels' left edges in the row's order; -1 with none. */
export function showingAt(edges: readonly number[], scrollLeft: number): number {
  let at = -1;
  let best = Infinity;
  edges.forEach((edge, i) => {
    const d = Math.abs(edge - scrollLeft);
    if (d < best) {
      best = d;
      at = i;
    }
  });
  return at;
}

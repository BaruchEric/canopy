/**
 * The size a seam is being dragged to, said beside the pointer (FR-063): one
 * small label on the body, shown from a drag's first move to its release.
 * Every handle that sizes something says it here, a width or a height in
 * px, a share as a percent, a box as width by height, so two panes can be
 * set to the same size by eye. Written straight to the DOM like the sizes
 * themselves: a drag never goes through React.
 */

/** how far the label sits from the pointer, in px */
const GAP = 14;
/** the gap it keeps from the window's edges */
const EDGE = 6;

export interface Point {
  x: number;
  y: number;
}

/** Where the label's top left corner goes: below and right of the pointer,
 *  or on the other side of it where that would leave the window. */
export function tagPlace(at: Point, view: { w: number; h: number }, tag: { w: number; h: number }): Point {
  const right = at.x + GAP;
  const below = at.y + GAP;
  const x = right + tag.w > view.w - EDGE ? at.x - GAP - tag.w : right;
  const y = below + tag.h > view.h - EDGE ? at.y - GAP - tag.h : below;
  return { x: Math.max(EDGE, x), y: Math.max(EDGE, y) };
}

/** a width or a height */
export const pxWord = (px: number): string => `${Math.round(px)} px`;
/** a share of the room two parts split */
export const shareWord = (share: number): string => `${Math.round(share * 100)}%`;
/** a box sized on both axes */
export const boxWord = (w: number, h: number): string => `${Math.round(w)} × ${Math.round(h)}`;

let tag: HTMLElement | null = null;

/** Shows `text` by the pointer, or takes the label away for null. */
export function seamTag(text: string | null, at?: { clientX: number; clientY: number }): void {
  if (typeof document === "undefined") return;
  if (text === null) {
    tag?.remove();
    tag = null;
    return;
  }
  if (!tag || !tag.isConnected) {
    tag = document.createElement("div");
    tag.className = "seam-tag";
    tag.setAttribute("aria-hidden", "true");
    document.body.append(tag);
  }
  if (tag.textContent !== text) tag.textContent = text;
  if (!at) return;
  const to = tagPlace({ x: at.clientX, y: at.clientY }, { w: window.innerWidth, h: window.innerHeight }, { w: tag.offsetWidth, h: tag.offsetHeight });
  tag.style.translate = `${Math.round(to.x)}px ${Math.round(to.y)}px`;
}

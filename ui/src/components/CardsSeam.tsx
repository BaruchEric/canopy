import { useLayoutEffect, useRef, useState } from "react";
import { CARDS, cardsFloor, cardsTop, chosenWidth, sharedRoom } from "../cardswidth";
import { useStore } from "../store";
import { Resizer } from "./Resizer";

/** The room the cards and the dock share, read off the page around the
 *  seam: the body's width less what sits left of the cards (`.main`, the
 *  seam's previous sibling) and the seam itself. */
function roomAt(handle: HTMLElement): number {
  const body = handle.parentElement;
  const main = handle.previousElementSibling;
  if (!body || !main) return Infinity;
  const before = main.getBoundingClientRect().left - body.getBoundingClientRect().left - body.clientLeft;
  return sharedRoom(body.clientWidth, before);
}

/** Writes the cards' floor for `chosen` on the body as `--cards-min`, which
 *  the body's tracks and the dock's max-width read; with nothing chosen the
 *  stylesheet's own value stands. */
function holdCards(handle: HTMLElement, chosen: number | null): void {
  const body = handle.parentElement;
  if (!body) return;
  if (chosen === null) body.style.removeProperty("--cards-min");
  else body.style.setProperty("--cards-min", `${cardsFloor(chosen, roomAt(handle))}px`);
}

/**
 * The seam between the cards and the dock (FR-015), shown while both are
 * side by side. Dragged, or stepped with the arrows while focused, it sets
 * the width the cards keep (cardswidth.ts): columns then take room from
 * the cards only down to it, and past it the dock scrolls. A double-click
 * goes back to the cards taking what the dock leaves. The width is kept
 * per kind of screen and window with the rest of the layout, and a screen
 * layout profile can name it.
 *
 * The floor is written on the body, not through React, and again whenever
 * the window resizes, since a narrow window lowers it (`cardsFloor`).
 */
export function CardsSeam() {
  const chosen = useStore((s) => s.cardsWidth);
  const setCardsWidth = useStore((s) => s.setCardsWidth);
  // the tree's width and whether it shows move the room the floor fits in
  const tree = useStore((s) => (s.sidebarOpen ? s.sidebarWidth : 0));
  const ref = useRef<HTMLDivElement>(null);
  // the cards' width now, for the drag's start, the keys and screen readers
  const [shown, setShown] = useState<number>(CARDS.min);
  // the cards' width as the last drag began, so one let go where it
  // started changes nothing (`chosenWidth`); null for a key
  const start = useRef<number | null>(null);

  useLayoutEffect(() => {
    const handle = ref.current;
    const body = handle?.parentElement;
    const main = handle?.previousElementSibling;
    if (!handle || !body || !(main instanceof HTMLElement)) return;
    const hold = () => holdCards(handle, chosen);
    const measure = () => setShown(Math.round(main.getBoundingClientRect().width));
    const down = (e: PointerEvent) => {
      if (e.button === 0) start.current = Math.round(main.getBoundingClientRect().width);
    };
    hold();
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(main);
    window.addEventListener("resize", hold);
    handle.addEventListener("pointerdown", down);
    return () => {
      seen.disconnect();
      window.removeEventListener("resize", hold);
      handle.removeEventListener("pointerdown", down);
      body.style.removeProperty("--cards-min");
    };
  }, [chosen, tree]);

  const commit = (px: number | null) => {
    const handle = ref.current;
    const next =
      px === null ? null : chosenWidth(px, { start: start.current, room: handle ? roomAt(handle) : Infinity, chosen: useStore.getState().cardsWidth });
    start.current = null;
    setCardsWidth(next);
    // a drag wrote its own value live; put the floor for what was kept back,
    // since an unchanged width re-renders nothing
    if (handle) holdCards(handle, next);
  };

  return (
    <Resizer
      ref={ref}
      className="cards-resizer"
      label="Cards width"
      value={shown}
      min={CARDS.min}
      max={CARDS.max}
      initial={CARDS.min}
      onReset={() => commit(null)}
      dir={1}
      cssVar="--cards-min"
      target={(h) => h.parentElement}
      fit={(h) => cardsTop(roomAt(h))}
      onCommit={(px) => commit(px)}
    />
  );
}

/** One menu open at a time across the page: a gear's and a card's ⋯ alike.
 *  Each menu's trigger stops its own pointerdown and keys from reaching
 *  what holds it, so an open menu cannot count on hearing another one open;
 *  opening one closes the other here instead, by mouse or by keyboard. */
let current: (() => void) | null = null;

/** Closes the menu open now, if another, and makes `close` the open one.
 *  Returns what the menu calls once it is closed. */
export function oneMenu(close: () => void): () => void {
  const before = current;
  current = close;
  if (before && before !== close) before();
  return () => {
    if (current === close) current = null;
  };
}

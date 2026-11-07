import { useEffect, useState, useSyncExternalStore } from "react";
import { typesInto } from "./softkeys";

/** The widths the layout turns at, the same numbers styles.css uses: a phone
 *  gets its own top bar, and below `NARROW` the tree leaves the page for a
 *  drawer. */
export const PHONE = "(max-width: 760px)";
export const NARROW = "(max-width: 1100px)";

/** Whether a media query matches, following it as the window changes. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const change = () => setOn(mq.matches);
    change();
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, [query]);
  return on;
}

/** a window's size in CSS px */
export interface ViewSize {
  w: number;
  h: number;
}

/** The window's size without what a phone's keyboard took: a height that
 *  fell while a text field held the focus on a touch screen, at the same
 *  width, is the keyboard coming up, so the size from before it stands.
 *  Any other change (a new width, the height growing, nothing typing) is
 *  the window's own. Pure; `useBenchOne` feeds it. */
export function restSize(rest: ViewSize | null, now: ViewSize, keyboard: boolean): ViewSize {
  if (!rest || !keyboard || now.w !== rest.w || now.h >= rest.h) return now;
  return rest;
}

/** the widths and heights below which the bench shows one part at a time */
export const BENCH_ONE_W = 760;
export const BENCH_ONE_H = 480;

/** whether a window of `size` is too small for the bench's parts side by side */
export const benchOneAt = (size: ViewSize): boolean => size.w <= BENCH_ONE_W || size.h <= BENCH_ONE_H;

let rest: ViewSize | null = null;
let watching = false;
const subs = new Set<() => void>();

function measure(): void {
  const el = document.activeElement;
  const keyboard = el instanceof HTMLElement && typesInto(el) && matchMedia("(pointer: coarse)").matches;
  rest = restSize(rest, { w: innerWidth, h: innerHeight }, keyboard);
}

function subscribe(on: () => void): () => void {
  if (!watching) {
    watching = true;
    addEventListener("resize", () => {
      measure();
      for (const f of subs) f();
    });
  }
  subs.add(on);
  return () => subs.delete(on);
}

function benchOneNow(): boolean {
  if (!rest) measure();
  return rest !== null && benchOneAt(rest);
}

/** Whether the bench shows one part at a time: a phone's width, or a window
 *  too short for its parts side by side, either way up. The height is the
 *  window's without the phone's keyboard (`restSize`): with
 *  `interactive-widget=resizes-content` the keyboard shortens the page, and
 *  a bench that switched then would hide the shell being typed in, which
 *  blurs it, puts the keyboard down and switches back, over and over. One
 *  watcher for the page, so a bench brought up while the keyboard is up
 *  still knows the height from before it. styles.css reads `.bench-one`. */
export function useBenchOne(): boolean {
  return useSyncExternalStore(subscribe, benchOneNow, () => false);
}

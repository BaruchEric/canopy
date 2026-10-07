/** True full screen for a panel: the browser's Fullscreen API on the whole
 *  document, with the panel's own `surface-full` mode doing the filling.
 *  Never on the panel element: gear menus and sheets are portals to body
 *  and would not show inside it. */
import { useEffect, useRef } from "react";

interface FsDoc {
  fullscreenEnabled: boolean;
  documentElement: { requestFullscreen(): Promise<void> };
}

export const fullWord = (supported: boolean): string => (supported ? "full screen" : "fill the window");

/** True when the browser went full screen; false where it cannot or refused. */
export async function enterFull(doc: FsDoc): Promise<boolean> {
  if (!doc.fullscreenEnabled) return false;
  try {
    await doc.documentElement.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

/** The keyboard lock, where the browser has one (Chromium): while held in
 *  full screen, Escape reaches the page and only a held Escape leaves. */
interface KeyNav {
  keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
}

/** the page's own keyboard lock, read without trusting its shape: the DOM
 *  types here do not know `navigator.keyboard` */
function pageNav(): KeyNav | undefined {
  if (typeof navigator === "undefined" || !("keyboard" in navigator)) return undefined;
  const kb: unknown = navigator.keyboard;
  if (!kb || typeof kb !== "object") return undefined;
  const lock: unknown = "lock" in kb ? kb.lock : undefined;
  const unlock: unknown = "unlock" in kb ? kb.unlock : undefined;
  return {
    keyboard: {
      lock:
        typeof lock === "function"
          ? async (keys) => {
              await Reflect.apply(lock, kb, [keys]);
            }
          : undefined,
      unlock: typeof unlock === "function" ? () => void Reflect.apply(unlock, kb, []) : undefined,
    },
  };
}

/** Takes Escape from the browser, so a shell in a full-screen panel gets
 *  it (an agent's interrupt) and a single press no longer leaves. True when
 *  the browser locked it; false where it cannot or refused. */
export async function lockEscape(nav: KeyNav | undefined = pageNav()): Promise<boolean> {
  const kb = nav?.keyboard;
  if (!kb?.lock) return false;
  try {
    await kb.lock(["Escape"]);
    return true;
  } catch {
    return false;
  }
}

export function unlockKeys(nav: KeyNav | undefined = pageNav()): void {
  nav?.keyboard?.unlock?.();
}

/** Leaves the browser's full screen and lets go of the keys, which a
 *  browser that already left may still hold for the next time. */
export function leaveFull(
  doc: { fullscreenElement: Element | null; exitFullscreen(): Promise<void> },
  nav: KeyNav | undefined = pageNav(),
): void {
  unlockKeys(nav);
  if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {});
}

/** While `on`, a browser exit from full screen (Esc, F11) calls `onExit`.
 *  The callback is read through a ref, so a new one each render does not
 *  re-subscribe. */
export function useFullscreenExit(on: boolean, onExit: () => void): void {
  const exit = useRef(onExit);
  exit.current = onExit;
  useEffect(() => {
    if (!on) return;
    const h = () => {
      if (!document.fullscreenElement) exit.current();
    };
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, [on]);
}

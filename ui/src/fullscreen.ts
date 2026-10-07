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

export function leaveFull(doc: { fullscreenElement: Element | null; exitFullscreen(): Promise<void> }): void {
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

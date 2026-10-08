// A panel drag's steps (Dock.tsx, startPanelDrag), pure: what each pointer
// or key event does in each phase, so a missed release can never leave a
// drag live.

/** pressed: down on a handle, under the slop; dragging: the layer shows;
 *  cancelled: Escape hid it and the release is still to come */
export type DragPhase = "pressed" | "dragging" | "cancelled";

/** `cancel` is a pointercancel, a lost pointer capture, a window blur or a
 *  context menu: any sign the release may never come. `hold` is a finger
 *  kept still on the handle for `TOUCH_HOLD`. */
export type DragInput =
  | { type: "move"; dx: number; dy: number; buttons: number }
  | { type: "up" }
  | { type: "cancel" }
  | { type: "escape" }
  | { type: "hold" };

/** How long a finger rests on a handle before it picks the panel up. A
 *  finger that moves sooner is scrolling, and the drag never starts. */
export const TOUCH_HOLD = 350;

/** none: nothing to do; start: show the layer; track: redraw it; drop:
 *  drop on the target; hide: take the layer down but keep listening for
 *  the release; cancel: take everything down. `swallow`: the release is
 *  no click. */
export interface DragStep {
  phase: DragPhase | "ended";
  effect: "none" | "start" | "track" | "drop" | "hide" | "cancel";
  swallow?: true;
}

/** `byHold`: a touch, which starts on a `hold` alone, so a move past the
 *  slop before it ends the gesture and leaves the row to scroll. */
export function dragStep(phase: DragPhase, input: DragInput, slop: number, byHold = false): DragStep {
  switch (input.type) {
    case "hold":
      return phase === "pressed" ? { phase: "dragging", effect: "start" } : { phase, effect: "none" };
    case "cancel":
      return { phase: "ended", effect: "cancel" };
    case "move":
      // no left button held: the release went somewhere this page never heard
      if ((input.buttons & 1) === 0) return { phase: "ended", effect: "cancel" };
      if (phase === "cancelled") return { phase, effect: "none" };
      if (phase === "dragging") return { phase, effect: "track" };
      if (Math.hypot(input.dx, input.dy) < slop) return { phase, effect: "none" };
      return byHold ? { phase: "ended", effect: "cancel" } : { phase: "dragging", effect: "start" };
    case "up":
      if (phase === "dragging") return { phase: "ended", effect: "drop", swallow: true };
      if (phase === "cancelled") return { phase: "ended", effect: "none", swallow: true };
      return { phase: "ended", effect: "none" };
    case "escape":
      if (phase === "dragging") return { phase: "cancelled", effect: "hide" };
      if (phase === "cancelled") return { phase, effect: "none" };
      return { phase: "ended", effect: "cancel" };
  }
}

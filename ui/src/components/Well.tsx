import type { PaneKey } from "../../../src/core/panesizes";
import { PaneSeam } from "./PaneSeam";

/** what `fullHeight` reads off a scroller */
export interface Scroller {
  /** its height in its own px, borders and a scrollbar's track included */
  offsetHeight: number;
  /** the height its content shows through */
  clientHeight: number;
  /** the height of everything it holds */
  scrollHeight: number;
  /** its box on the screen, under every zoom over it */
  getBoundingClientRect(): { height: number };
}

/** The height a scroller would be with everything it holds showing, in px
 *  on the screen: what it shows now, and what it has scrolled out of sight
 *  under the zoom the first is already drawn at. 0 for one not laid out. */
export function fullHeight(box: Scroller | null): number {
  if (!box || box.offsetHeight <= 0) return 0;
  const shown = box.getBoundingClientRect().height;
  return shown + Math.max(0, box.scrollHeight - box.clientHeight) * (shown / box.offsetHeight);
}

/**
 * The seam under a capped scroller (FR-063): a diff, a task's log, a job's
 * output. Each scrolls under a cap so one long one does not push the rest
 * of its section off the screen, and the cap is a pane: dragging the
 * scroller's bottom edge sets it for every scroller of that kind, kept per
 * kind of screen like any other pane's size.
 *
 * The scroller and this seam sit alone in a `.well`, the scroller first.
 * The cap is written on the well as `--pane-<name>` and the scroller's
 * `max-height` reads it. A drag stops at the height of what the scroller
 * holds (`reach`), and one holding less than the pane's floor has no seam.
 */
export function WellSeam({ pane, label }: { pane: PaneKey; label: string }) {
  return (
    <PaneSeam
      pane={pane}
      label={label}
      className="well-seam"
      axis="y"
      dir={1}
      target={(h) => h.parentElement}
      reach={(h) => {
        const box = h.previousElementSibling;
        return fullHeight(box instanceof HTMLElement ? box : null);
      }}
    />
  );
}

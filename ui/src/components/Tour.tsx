import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TOUR_TEXT, tourStep, type TourStep } from "../guided";

interface Spot {
  top: number;
  left: number;
}

/** Three coach marks, each under the thing it names, with next and skip.
 *  A step whose target is not on screen is passed over. */
export function Tour({ targets, onDone }: { targets: Array<() => Element | null>; onDone: () => void }) {
  const [step, setStep] = useState<TourStep>(0);
  const [spot, setSpot] = useState<Spot | null>(null);
  useEffect(() => {
    if (step === "done") onDone();
  }, [step, onDone]);
  useLayoutEffect(() => {
    if (step === "done") return;
    const place = () => {
      const el = targets[step]?.();
      if (!el) {
        setStep((s) => (s === "done" ? s : tourStep(s, "next")));
        return;
      }
      const r = el.getBoundingClientRect();
      const top = Math.min(r.bottom + 8, window.innerHeight - 120);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 288));
      setSpot({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [step, targets]);
  if (step === "done" || !spot) return null;
  return createPortal(
    <div className="tour" role="dialog" aria-label="Getting started" style={{ top: spot.top, left: spot.left }}>
      <p>{TOUR_TEXT[step]}</p>
      <div className="tour-actions">
        <span className="tour-count">{step + 1} of 3</span>
        <span className="spacer" />
        <button type="button" className="mini" onClick={() => setStep("done")}>
          skip tour
        </button>
        <button type="button" className="mini" onClick={() => setStep((s) => tourStep(s, "next"))}>
          {step === 2 ? "done" : "next"}
        </button>
      </div>
    </div>,
    document.body,
  );
}

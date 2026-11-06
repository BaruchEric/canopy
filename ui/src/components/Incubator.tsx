/**
 * The incubator: one card per new project with its stage strip. The
 * + project button and the sheets are `IncubatorSheets.tsx`.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { dropSproutHere, sproutHere } from "../routes";
import { backendOf } from "../registry";
import { sortSprouts, sproutActivity, sproutWord, stagesWord } from "../sprouts";
import { multi, useStore } from "../store";
import { ago } from "../util";
import { InboxChip } from "./Inbox";
import { NewProjectButton, StageStrip } from "./IncubatorSheets";
import { WidgetGear, shareEntries, useZoom, zoomStyle } from "./Surface";

/** One project's card. It moves with what it is doing: an agent at work
 *  runs sap along its top, one waiting on you breathes rust, and any change
 *  the stream brings ripples it once. */
function SproutCard({ id, i }: { id: string; i: number }) {
  const s = useStore((st) => st.sprouts[id]);
  const show = useStore((st) => st.showSprout);
  const many = useStore(multi);
  const updatedAt = s?.updatedAt;
  const [pulse, setPulse] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    // the card's first paint is its rise in, not a change
    if (first.current) {
      first.current = false;
      return;
    }
    if (updatedAt === undefined) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 1200);
    return () => clearTimeout(t);
  }, [updatedAt]);
  if (!s) return null;
  const activity = sproutActivity(s);
  return (
    <button
      type="button"
      className={`sprout-card ${activity}${pulse ? " pulse" : ""}`}
      style={{ "--i": i } as CSSProperties}
      aria-busy={activity === "working"}
      onClick={() => show(s.id)}
    >
      <span className="sprout-head">
        <span className="sprout-title">
          {s.title}
          {many && <span className="backend-word">{backendOf(s.id)}</span>}
        </span>
        <span className={`sprout-word st-${s.status}`}>{sproutWord(s)}</span>
      </span>
      <StageStrip id={s.id} />
      {s.parked && <span className="sprout-parked">{s.parked}</span>}
      <span className="sprout-meta">
        {s.inputs.length} {s.inputs.length === 1 ? "input" : "inputs"} · {s.spent.runs} {s.spent.runs === 1 ? "run" : "runs"} · {ago(s.updatedAt / 1000)}
      </span>
    </button>
  );
}

/** Where each backend runs its stages, through the stage runner, there
 *  unisolated, or nowhere, named by backend when the page shows several;
 *  nothing from a backend too old to say. */
function StagesWord() {
  const order = useStore((s) => s.backendOrder);
  const stages = useStore((s) => s.stages);
  const many = order.length > 1;
  const words = order.flatMap((b) => {
    const st = Object.hasOwn(stages, b) ? stages[b] : undefined;
    return st ? [{ b, ...stagesWord(st) }] : [];
  });
  return (
    <>
      {words.map(({ b, word, title, warn }) => (
        <span key={b} className={`stages-word${warn ? " not" : ""}`} title={title}>
          {many ? `${b}: ${word}` : word}
        </span>
      ))}
    </>
  );
}

export function IncubatorView({ onGit }: { onGit?: () => void }) {
  const ready = useStore((s) => s.sproutsReady);
  const ids = useStore(useShallow((s) => sortSprouts(Object.values(s.sprouts)).map((x) => x.id)));
  const show = useStore((s) => s.showSprout);
  const waiting = useStore(
    useShallow((s) =>
      s.backendOrder.flatMap((b) => {
        const w = Object.hasOwn(s.stages, b) ? s.stages[b]?.waiting : null;
        return w ? [`queued${multi(s) ? ` on ${b}` : ""}: ${w}`] : [];
      }),
    ),
  );
  const body = useRef<HTMLDivElement>(null);
  const { zoom, entry: zoomEntry } = useZoom("incubator");
  // `canopy new` prints a link to its project: open it once the list is in
  useEffect(() => {
    const id = sproutHere(window.location.search);
    if (!id || !ready) return;
    show(id);
    dropSproutHere();
  }, [ready, show]);
  return (
    <section className="incubator-view" aria-label="Incubator">
      <div className="agents-bar">
        <NewProjectButton />
        <StagesWord />
        <span className="agents-has">
          <InboxChip onGit={onGit} />
        </span>
        <WidgetGear label="the incubator" what="incubator" zoom={zoomEntry} share={shareEntries({ el: () => body.current, label: "incubator" })} />
      </div>
      <div ref={body} className="incubator-body" style={zoomStyle(zoom)}>
        {waiting.map((w) => (
          <p key={w} className="stages-waiting">
            {w}
          </p>
        ))}
        {!ready ? (
          <p className="sheet-empty">No backend has an incubator to show, or none has answered yet.</p>
        ) : ids.length === 0 ? (
          <div className="incubator-empty">
            <p>Nothing in the incubator. A project starts from an idea, a link, a file, a voice memo or a repo, and is clarified and researched before anything is built.</p>
            <NewProjectButton />
          </div>
        ) : (
          <div className="sprout-grid">
            {ids.map((id, i) => (
              <SproutCard key={id} id={id} i={i} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

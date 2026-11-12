import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { isLiveAgent, type Repo } from "../../../src/core/types";
import { durationWord, type TrailMark } from "../agentcards";
import {
  LINGER_MS,
  departed,
  lastEnded,
  liveFlow,
  liveGlyph,
  liveGroups,
  liveHead,
  liveMarks,
  traceFits,
  traceTip,
  traceUntil,
  traceWords,
  type Gone,
  type LiveGroup,
  type LiveMark,
  type LiveTrace,
  type ShownMark,
} from "../cardlive";
import { backendOf, plainOf } from "../registry";
import { agentsOn, statusFacts, useStore } from "../store";
import { keepKeys } from "../surface";
import { useNow } from "./Registry";

const split = (id: string): [string, string] => [backendOf(id), plainOf(id)];

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

/** The marks that ended a moment ago, kept for `LINGER_MS` so the row can
 *  show them go: the difference between the marks of the last render and
 *  this one, dropped again by a timer. */
function useDeparted(marks: readonly LiveMark[]): LiveMark[] {
  const [gone, setGone] = useState<readonly Gone<LiveMark>[]>([]);
  const prev = useRef(marks);
  useEffect(() => {
    const before = prev.current;
    prev.current = marks;
    if (before !== marks) setGone((g) => departed(before, marks, g, Date.now(), LINGER_MS));
  }, [marks]);
  useEffect(() => {
    if (gone.length === 0) return;
    const until = Math.min(...gone.map((g) => g.until));
    // a new array each time, so a timer that fires a moment early sets the next one
    const t = setTimeout(() => setGone((g) => g.filter((x) => x.until > Date.now())), Math.max(0, until - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [gone]);
  return useMemo(() => gone.map((g) => g.item), [gone]);
}

/** Whether `until` is still ahead. One timer set for that moment renders
 *  the row again, so a quiet card runs no clock of its own. */
function useUntil(until: number | null): boolean {
  const [, again] = useState(0);
  useEffect(() => {
    if (until === null) return;
    const left = until - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => again((n) => n + 1), left + 20);
    return () => clearTimeout(t);
  }, [until]);
  return until !== null && Date.now() < until;
}

/**
 * Marks a row that has no room for its trace (`data-tight`, which hides
 * it), so the trace shows whole or not at all and never cuts the words
 * about what runs now, and says whether it did, so the row can put the
 * trace in its tooltip instead. Read before each paint and when the row's
 * width moves: the trace is drawn, and `traceFits` reads the branch line. A
 * row that is its trace alone has no line and is never tight.
 */
function useRoom(row: RefObject<HTMLDivElement | null>, watch: boolean): boolean {
  const [tight, setTight] = useState(false);
  // no deps: the marks, the words and the trace all move the room
  useLayoutEffect(() => {
    const el = row.current;
    if (!el || !watch || typeof ResizeObserver === "undefined") return;
    const mark = () => {
      el.removeAttribute("data-tight");
      const line = el.querySelector<HTMLElement>(":scope > .card-live-line");
      if (!line) return;
      const basis = Number.parseFloat(getComputedStyle(line).flexBasis);
      const none = Number.isFinite(basis) && !traceFits(line.getBoundingClientRect().width, basis);
      el.toggleAttribute("data-tight", none);
      // the same answer again renders nothing again
      setTight(none);
    };
    mark();
    const seen = new ResizeObserver(mark);
    seen.observe(el);
    return () => {
      seen.disconnect();
      el.removeAttribute("data-tight");
    };
  });
  return watch && tight;
}

/** what a click on a group does, for its tooltip */
const OPENS: Record<LiveGroup["kind"], string> = {
  agent: "Show the agents on this repo",
  task: "Show its tasks",
  shell: "Bring its shell up",
};

function Mark({ shown, now }: { shown: ShownMark; now: number }) {
  const m = shown.mark;
  const lasted = m.since !== null && now - m.since >= 60_000 ? `, for ${durationWord(now - m.since)}` : "";
  return (
    <span className={`card-live-mark k-${m.kind} is-${m.state}${shown.gone ? " gone" : ""}`} title={shown.gone ? undefined : `${m.title}${lasted}`}>
      {m.kind === "shell" ? <i className="card-live-cursor" /> : <span className="card-live-glyph">{liveGlyph(m)}</span>}
      {m.kind === "task" && <span className="card-live-name">{m.name}</span>}
      {m.kind === "task" && m.port !== null && <span className="card-live-port">:{m.port}</span>}
    </span>
  );
}

/** The trace: a dotted run of the branch line, then the last thing that
 *  left the row and how long ago. A click opens where it is listed. */
function Trace({ trace, name, now, selecting }: { trace: LiveTrace; name: string; now: number; selecting: boolean }) {
  const showAgents = useStore((s) => s.showAgents);
  const showTasks = useStore((s) => s.showTasks);
  const words = traceWords(trace, now);
  return (
    <>
      <span className="card-live-trail" aria-hidden="true" />
      {selecting ? (
        <span className="card-live-trace" title={trace.title}>
          {words}
        </span>
      ) : (
        <button
          type="button"
          className="card-live-trace"
          title={trace.title}
          aria-label={`${words}, on ${name}`}
          onClick={(e) => {
            stop(e);
            if (trace.kind === "agent") showAgents(trace.repoId);
            else showTasks(trace.repoId);
          }}
          onAuxClick={stop}
          onPointerDown={stop}
          onKeyDown={keepKeys}
        >
          {words}
        </button>
      )}
    </>
  );
}

function Row({ name, marks, gone, trace, selecting }: { name: string; marks: readonly LiveMark[]; gone: readonly LiveMark[]; trace: LiveTrace | null; selecting: boolean }) {
  const now = useNow();
  const showAgents = useStore((s) => s.showAgents);
  const showTasks = useStore((s) => s.showTasks);
  const bringTerm = useStore((s) => s.bringTerm);
  const groups = liveGroups(marks, gone);
  const head = liveHead(marks, now);
  // nothing runs and no mark is still falling: the trace is the whole row
  const live = groups.length > 0;
  const row = useRef<HTMLDivElement>(null);
  // a trace the row holds back is its tooltip, over the words and the line
  const held = useRoom(row, live && trace !== null);
  const tip = held && trace ? traceTip(trace, now) : undefined;
  const open = (m: LiveMark) => {
    switch (m.kind) {
      case "agent":
        showAgents(m.repoId);
        break;
      case "task":
        showTasks(m.repoId);
        break;
      case "shell":
        bringTerm(m.term);
        break;
      default: {
        const _exhaustive: never = m;
        return _exhaustive;
      }
    }
  };
  return (
    <div ref={row} className={`card-live${liveFlow(marks) ? " flow" : ""}`} role="group" aria-label={`${live ? "Running" : "Just ended"} on ${name}`} title={tip}>
      {groups.map((g) => {
        const first = g.first;
        const inner = (
          <>
            {g.marks.map((shown) => (
              <Mark key={shown.mark.id} shown={shown} now={now} />
            ))}
            {g.more > 0 && <span className="card-live-more">+{g.more}</span>}
          </>
        );
        // in select mode a click picks the card, and a group whose marks all
        // just ended has nothing left to open
        if (selecting || !first) {
          return (
            <span key={g.kind} className="card-live-group" role="img" aria-label={g.words}>
              {inner}
            </span>
          );
        }
        return (
          <button
            key={g.kind}
            type="button"
            className="card-live-group"
            title={OPENS[g.kind]}
            aria-label={`${g.words}, on ${name}`}
            onClick={(e) => {
              stop(e);
              open(first);
            }}
            onAuxClick={stop}
            onPointerDown={stop}
            onKeyDown={keepKeys}
          >
            {inner}
          </button>
        );
      })}
      {live && <span className="card-live-line" aria-hidden="true" />}
      {head && <span className={`card-live-head h-${head.tone}${head.tone === "work" ? " shimmer" : ""}`}>{head.text}</span>}
      {/* keyed by what it speaks of, so a new one comes in afresh */}
      {trace && <Trace key={trace.id} trace={trace} name={name} now={now} selecting={selecting} />}
    </div>
  );
}

/**
 * A card's live row: a mark for every agent, task and shell running on the
 * repo right now, on any of the card's checkouts, then the branch line out
 * to one line of words about the most pressing of them. The colour of a
 * mark is its state and so is its motion; sap runs along the line while an
 * agent works. A mark grows in when its thing starts and drops off when it
 * ends. After the words comes the trace (FR-059): the last thing that left
 * the row, an agent that ended or a task that finished, and how long ago,
 * kept for `TRACE_MS`, shown only where the row has room for all of it
 * (a row without the room says it in its tooltip), and alone on the row
 * once nothing else runs. Nothing at all on a repo
 * that has been quiet that long. Cozy density only: compact keeps the ✦
 * and ▶ chips, which the row replaces here.
 */
export function CardLive({ repo, checkouts, selecting }: { repo: Repo; checkouts: readonly string[]; selecting: boolean }) {
  const agents = useStore((s) => agentsOn(s, repo.id));
  const trail = useStore(
    useShallow((s) => {
      const out: Record<string, readonly TrailMark[] | undefined> = {};
      for (const c of agents) if (isLiveAgent(c)) out[c.id] = s.registryTrail[c.id];
      return out;
    }),
  );
  const tasks = useStore(useShallow((s) => s.taskAll.filter((t) => checkouts.includes(t.repoId))));
  const shells = useStore(useShallow((s) => s.shells.filter((t) => checkouts.includes(t.repoId))));
  const facts = useStore(statusFacts);
  const marks = useMemo(() => liveMarks({ lead: repo.id, agents, trail, tasks, shells, split, facts }), [repo.id, agents, trail, tasks, shells, facts]);
  const gone = useDeparted(marks);
  const last = useMemo(() => lastEnded({ lead: repo.id, agents, tasks, split }), [repo.id, agents, tasks]);
  const trace = useUntil(last ? traceUntil(last) : null) ? last : null;
  if (marks.length === 0 && gone.length === 0 && !trace) return null;
  return <Row name={repo.name} marks={marks} gone={gone} trace={trace} selecting={selecting} />;
}

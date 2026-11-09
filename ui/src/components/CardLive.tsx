import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { isLiveAgent, type Repo } from "../../../src/core/types";
import { durationWord, type TrailMark } from "../agentcards";
import { LINGER_MS, departed, liveFlow, liveGlyph, liveGroups, liveHead, liveMarks, type Gone, type LiveGroup, type LiveMark, type ShownMark } from "../cardlive";
import { backendOf, plainOf } from "../registry";
import { agentsOn, useStore } from "../store";
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

function Row({ name, marks, gone, selecting }: { name: string; marks: readonly LiveMark[]; gone: readonly LiveMark[]; selecting: boolean }) {
  const now = useNow();
  const showAgents = useStore((s) => s.showAgents);
  const showTasks = useStore((s) => s.showTasks);
  const bringTerm = useStore((s) => s.bringTerm);
  const groups = liveGroups(marks, gone);
  const head = liveHead(marks, now);
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
    <div className={`card-live${liveFlow(marks) ? " flow" : ""}`} role="group" aria-label={`Running on ${name}`}>
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
      <span className="card-live-line" aria-hidden="true" />
      {head && <span className={`card-live-head h-${head.tone}${head.tone === "work" ? " shimmer" : ""}`}>{head.text}</span>}
    </div>
  );
}

/**
 * A card's live row: a mark for every agent, task and shell running on the
 * repo right now, on any of the card's checkouts, then the branch line out
 * to one line of words about the most pressing of them. The colour of a
 * mark is its state and so is its motion; sap runs along the line while an
 * agent works. A mark grows in when its thing starts and drops off when it
 * ends. Nothing at all on a quiet repo. Cozy density only: compact keeps
 * the ✦ and ▶ chips, which the row replaces here.
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
  const marks = useMemo(() => liveMarks({ lead: repo.id, agents, trail, tasks, shells, split }), [repo.id, agents, trail, tasks, shells]);
  const gone = useDeparted(marks);
  if (marks.length === 0 && gone.length === 0) return null;
  return <Row name={repo.name} marks={marks} gone={gone} selecting={selecting} />;
}

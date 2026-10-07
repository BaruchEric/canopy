import { useEffect, useMemo, useState } from "react";
import { keepKeys } from "../surface";
import { useShallow } from "zustand/react/shallow";
import { HARNESS } from "../../../src/core/harness";
import { isLiveAgent, type ActivityEvent, type AgentActivity, type AgentCard, type Repo } from "../../../src/core/types";
import {
  ageWord,
  anyWaiting,
  cardName,
  clockWord,
  durationWord,
  groupCards,
  joinTarget,
  liveCount,
  readerOf,
  registrySummary,
  relPath,
  repoName,
  repoWord,
  splitRecent,
  stateSince,
  stateWord,
  timelineOf,
  transcriptTarget,
  whereWord,
  type CardGrouping,
  type RegistrySummary,
  type Timeline,
  type TrailMark,
} from "../agentcards";
import { api } from "../api";
import { handoffFrom, handoffRepo } from "../handoff";
import { backendOf, qual } from "../registry";
import { agentsOn, helperFor, useStore } from "../store";
import { repoChannel } from "../../../src/core/tailchan";
import { fmtTokens, usd } from "../util";
import { HandoffButton } from "./Handoff";
import { Seg } from "./Seg";
import { Section } from "./Surface";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** now, again every `ms`, for the ages a row shows */
function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const glyphOf = (c: AgentCard): string => (c.harness === "other" ? "·" : HARNESS[c.harness].glyph);
const harnessWord = (c: AgentCard): string => (c.harness === "other" ? "another harness" : HARNESS[c.harness].label);

/** the element id a card's row carries, so the timeline can bring it into view */
const rowId = (id: string): string => `agent-${id.replace(/[^\w-]/g, "_")}`;

const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * One agent: its harness, handle, repo and branch; its state (rust while it
 * waits, dim once lost) and how long it has held it, when this page saw it
 * change; model, run time, where; its caps and offers; and what can be done
 * from here: message it, join the canopy shell it runs in, open its
 * transcript when that file is on the home backend's machine. Its name opens
 * the drill-down below it (`AgentDetail`); the registry tab keeps one row
 * open at a time through `open`/`onToggle`, a panel's rows each their own.
 * `onGit` takes the page to the git view, where a panel shell shows.
 */
export function AgentRow({
  card,
  now,
  showRepo = true,
  onGit,
  open: openProp,
  onToggle,
}: {
  card: AgentCard;
  now: number;
  showRepo?: boolean;
  onGit?: () => void;
  open?: boolean;
  onToggle?: () => void;
}) {
  const home = useStore((s) => s.home);
  const shown = useStore(useShallow((s) => s.backendOrder));
  const chanReady = useStore((s) => s.chan?.ready === true);
  const target = joinTarget(card, shown, qual);
  const held = useStore((s) => (target ? s.shells.find((t) => t.id === target)?.place : undefined));
  const repos = useStore((s) => s.repos);
  const transcript = useMemo(() => transcriptTarget(card, home, repos.filter((r) => backendOf(r.id) === home)), [card, home, repos]);
  // the ask it waits on, a way into the inbox (an id, so the selector settles)
  const ask = useStore((s) => Object.values(s.asks).find((a) => a.state === "open" && a.agent === card.id)?.id ?? null);
  const since = useStore((s) => stateSince(card, s.registryTrail[card.id]));
  // a canopy shell or run on a backend here can hand its work to the other harness
  const from = handoffFrom(card, shown);
  const fromBackend = from?.backend ?? null;
  const handRepo = useMemo(() => (fromBackend ? handoffRepo(card, repos.filter((r) => backendOf(r.id) === fromBackend)) : undefined), [fromBackend, card, repos]);
  const [err, setErr] = useState<string | null>(null);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const toggle = onToggle ?? (() => setOwnOpen((o) => !o));

  const message = () => useStore.getState().openChan(`@${card.handle}`);
  const join = () => {
    if (!target) return;
    useStore.getState().bringTerm(target);
    if (held === "panel") onGit?.();
  };
  const openTranscript = () => {
    if (!transcript) return;
    setErr(null);
    api.openFile(transcript.repoId, transcript.file, 1, helperFor(useStore.getState(), home)).catch((e: unknown) => setErr(errText(e)));
  };
  const started = new Date(card.startedAt).toLocaleString();
  const classes = ["agents-row", "reg-row", isLiveAgent(card) ? "" : "reg-gone", open ? "open" : ""].filter(Boolean).join(" ");
  return (
    <li id={rowId(card.id)} className={classes}>
      <div className="agents-row-head">
        <span className={`harness-glyph h-${card.harness}`} title={harnessWord(card)}>
          {glyphOf(card)}
        </span>
        <button type="button" className="agents-name reg-open" aria-expanded={open} title={open ? "Fold its details" : `${card.id}: activity, run time and where it runs`} onClick={toggle}>
          {cardName(card)}
          <span className="reg-caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        </button>
        {/* in a repo's own section the repo goes without saying; its branch does not */}
        <span className="agents-line" title={card.cwd}>
          {showRepo ? repoWord(card) : (card.branch ?? "")}
        </span>
        <span className={`reg-state rs-${card.state}`} title={card.waiting ?? undefined}>
          {stateWord(card)}
        </span>
        {since !== null && (
          <span className="agents-fact" title={`${card.state} since ${new Date(since).toLocaleTimeString()}`}>
            for {durationWord(now - since)}
          </span>
        )}
        {card.model && <span className="agents-fact">{card.model}</span>}
        <span className="agents-fact reg-run" title={`started ${started}`}>
          {ageWord(card, now)}
        </span>
        <span className="agents-fact" title={card.cwd}>
          {whereWord(card)}
        </span>
        <span className="reg-actions">
          {ask && (
            <button
              type="button"
              className="run-chip reg-ask"
              title="It waits on you: answer it in the inbox"
              onClick={() => useStore.getState().openInbox(`ask:${ask}`)}
            >
              ? answer
            </button>
          )}
          {card.handle && chanReady && isLiveAgent(card) && (
            <button type="button" className="mini" title={`A DM to @${card.handle}`} onClick={message}>
              message
            </button>
          )}
          {held && isLiveAgent(card) && (
            <button type="button" className="mini" title="The canopy shell it runs in" onClick={join}>
              join
            </button>
          )}
          {transcript && (
            <button type="button" className="mini" title={card.transcript ?? undefined} onClick={openTranscript}>
              transcript
            </button>
          )}
          {from && handRepo && (
            <HandoffButton
              repoId={handRepo.id}
              backend={from.backend}
              from={from.harness}
              transcript={card.transcript}
              term={card.where.canopy?.term ? qual(from.backend, card.where.canopy.term) : null}
              onDone={onGit}
            />
          )}
        </span>
      </div>
      {(card.caps.length > 0 || card.offers.length > 0) && (
        <div className="reg-more">
          {card.caps.map((c) => (
            <span key={c} className="reg-cap">
              {c}
            </span>
          ))}
          {card.offers.map((o) => (
            <span key={o} className="reg-offer">
              {o}
            </span>
          ))}
        </div>
      )}
      {err && <p className="settings-hint error">{err}</p>}
      {open && <AgentDetail card={card} now={now} />}
    </li>
  );
}

/* ---------- the drill-down ---------- */

/** how often an open live agent's activity is read again */
const ACTIVITY_EVERY = 10_000;

interface ActivityRead {
  activity: AgentActivity | null;
  error: string | null;
  /** when the last reading came back */
  at: number | null;
  loading: boolean;
}

/** A card's activity off the backend that reads its transcript, again every
 *  `ACTIVITY_EVERY` while it runs and the page is in view; a failed reading
 *  keeps the last good one beside its error. */
function useActivity(card: AgentCard, reader: string | null): ActivityRead & { refresh: () => void } {
  const [read, setRead] = useState<ActivityRead>({ activity: null, error: null, at: null, loading: false });
  const [tick, setTick] = useState(0);
  const harness = card.harness === "other" ? null : card.harness;
  const { session, cwd } = card;
  const live = isLiveAgent(card);
  useEffect(() => {
    if (!reader || !harness || !session) return;
    let on = true;
    setRead((r) => ({ ...r, loading: true }));
    api
      .agentActivity(reader, harness, session, cwd)
      .then((activity) => on && setRead({ activity, error: null, at: Date.now(), loading: false }))
      .catch((e: unknown) => on && setRead((r) => ({ ...r, error: errText(e), at: Date.now(), loading: false })));
    return () => {
      on = false;
    };
  }, [reader, harness, session, cwd, tick]);
  useEffect(() => {
    if (!live || !reader) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, ACTIVITY_EVERY);
    return () => clearInterval(t);
  }, [live, reader]);
  return { ...read, refresh: () => setTick((n) => n + 1) };
}

/** why a card's activity cannot be read here, in a line */
function noReaderWord(card: AgentCard): string {
  if (card.origin === "scan" || !card.session) return "A process scan found it: with no hooks there is no session, so no transcript to read.";
  if (card.harness === "other") return "Its harness keeps no transcript canopy reads.";
  return `Its transcript is on ${card.node}, and no backend this page shows runs there.`;
}

/**
 * A card drilled into: what it is working on, the facts the broker keeps
 * (when it started, how long it has run, its last beat, where, the session),
 * what its transcript says it did (`ActivityView`), and the states this page
 * saw it take.
 */
function AgentDetail({ card, now }: { card: AgentCard; now: number }) {
  const reader = useStore((s) => readerOf(card, s.backendOrder, Object.values(s.registry)));
  const marks = useStore((s) => s.registryTrail[card.id]);
  const read = useActivity(card, reader);
  const a = read.activity;
  const live = isLiveAgent(card);
  const ago = (at: number) => `${durationWord(now - at)} ago`;
  const repo = repoName(card.repo);
  return (
    <div className="reg-detail">
      {(a?.title || a?.firstPrompt) && (
        <p className="reg-title" title={a.firstPrompt ?? undefined}>
          {a.title ?? a.firstPrompt}
        </p>
      )}
      <dl className="reg-facts">
        <dt>started</dt>
        <dd title={new Date(card.startedAt).toLocaleString()}>
          {clockWord(card.startedAt)} <span className="agents-fact">{ago(card.startedAt)}</span>
        </dd>
        <dt>{live ? "running" : "ran"}</dt>
        <dd>
          {ageWord(card, now)}
          {a && a.activeMs > 0 && (
            <span className="agents-fact" title="Time between transcript records less than five minutes apart: working, not waiting on you">
              {" "}
              · busy {durationWord(a.activeMs)}
            </span>
          )}
        </dd>
        {live && (
          <>
            <dt>last beat</dt>
            <dd>{ago(card.seenAt)}</dd>
          </>
        )}
        {card.state === "waiting" && card.waiting && (
          <>
            <dt>waits on</dt>
            <dd className="reg-waits">{card.waiting}</dd>
          </>
        )}
        <dt>harness</dt>
        <dd>
          {harnessWord(card)}
          {card.model ? ` · ${card.model}` : ""}
          {card.mode ? <span className="agents-fact"> · {card.mode} mode</span> : null}
        </dd>
        <dt>where</dt>
        <dd>
          {whereWord(card)}
          <span className="agents-fact">
            {" "}
            · {card.where.os}
            {card.where.pid !== null ? ` · pid ${card.where.pid}` : ""}
            {card.where.container ? " · in a container" : ""}
          </span>
        </dd>
        {repo && card.repo && (
          <>
            <dt>repo</dt>
            <dd>
              <a href={card.repo} target="_blank" rel="noreferrer">
                {repo}
              </a>
              {card.branch ? <span className="agents-fact"> · {card.branch}</span> : null}
            </dd>
          </>
        )}
        <dt>folder</dt>
        <dd className="reg-path">{card.cwd || "—"}</dd>
        {card.session && (
          <>
            <dt>session</dt>
            <dd className="reg-path">{card.session}</dd>
          </>
        )}
      </dl>
      {!reader ? (
        <p className="settings-hint">{noReaderWord(card)}</p>
      ) : (
        <div className="reg-activity-head">
          <h4 className="panel-label">activity</h4>
          <span className="agents-fact">
            {read.loading && !a ? "reading the transcript…" : read.at ? `read ${clockWord(read.at)} on ${reader}${live ? ", every 10s while it runs" : ""}` : ""}
          </span>
          <button type="button" className="mini" disabled={read.loading} onClick={read.refresh}>
            {read.loading ? "reading…" : "read again"}
          </button>
        </div>
      )}
      {read.error && <p className="settings-hint warn">{read.error}</p>}
      {a && <ActivityView a={a} cwd={card.cwd} />}
      <Trail card={card} marks={marks} />
    </div>
  );
}

/** a path as short as it reads: inside the agent's folder, relative to it */
function shortPath(file: string, cwd: string): string {
  if (!cwd || !file.startsWith("/")) return file;
  const rel = relPath(cwd, file);
  return rel.startsWith("../..") ? file : rel;
}

/** a file in a narrow column: its folder gives way before its name does */
function FileName({ file, cwd }: { file: string; cwd: string }) {
  const p = shortPath(file, cwd);
  const cut = p.lastIndexOf("/") + 1;
  return (
    <li title={file}>
      {cut > 0 && <span className="reg-file-dir">{p.slice(0, cut)}</span>}
      <span className="reg-file-name">{p.slice(cut)}</span>
    </li>
  );
}

const EVENT_WORD: Record<ActivityEvent["kind"], string> = { prompt: "you", reply: "said", tool: "", error: "" };

/** What a transcript says: the tallies, the tools it leaned on, the files it
 *  wrote, the last thing asked and said, and its latest events, newest
 *  first. */
function ActivityView({ a, cwd }: { a: AgentActivity; cwd: string }) {
  const [all, setAll] = useState(false);
  const top = a.tools[0]?.count ?? 0;
  const tokensIn = a.tokens.input + a.tokens.cacheRead + a.tokens.cacheWrite;
  const events = [...a.events].reverse();
  const shown = all ? events : events.slice(0, 12);
  const files = all ? a.files : a.files.slice(0, 8);
  return (
    <div className="reg-activity">
      <p className="reg-tally">
        <span>
          <b>{a.prompts}</b> prompt{a.prompts === 1 ? "" : "s"}
        </span>
        <span>
          <b>{a.toolCalls}</b> tool call{a.toolCalls === 1 ? "" : "s"}
          {a.toolErrors > 0 && <span className="reg-failed"> ({a.toolErrors} failed)</span>}
        </span>
        {a.filesTouched > 0 && (
          <span>
            <b>{a.filesTouched}</b> file{a.filesTouched === 1 ? "" : "s"} written
          </span>
        )}
        {(a.linesAdded !== null || a.linesRemoved !== null) && (
          <span title="Lines as the harness counted them">
            <b className="reg-added">+{a.linesAdded ?? 0}</b> <b className="reg-removed">−{a.linesRemoved ?? 0}</b>
          </span>
        )}
        {(tokensIn > 0 || a.tokens.output > 0) && (
          <span title={`${a.tokens.input} fresh in, ${a.tokens.cacheRead} read from cache, ${a.tokens.cacheWrite} written to cache, ${a.tokens.output} out`}>
            <b>{fmtTokens(tokensIn)}</b> in{a.tokens.cacheRead > 0 ? ` (${fmtTokens(a.tokens.cacheRead)} cached)` : ""} · <b>{fmtTokens(a.tokens.output)}</b> out
          </span>
        )}
        {a.costUsd !== null && (
          <span title="As the harness counted it: the list price of its tokens, not a bill">
            <b>{usd(a.costUsd)}</b> by its count
          </span>
        )}
        {a.subagents > 0 && (
          <span>
            <b>{a.subagents}</b> subagent{a.subagents === 1 ? "" : "s"}
          </span>
        )}
        {a.models.length > 0 && <span className="agents-fact">{a.models.join(", ")}</span>}
      </p>
      {(a.tools.length > 0 || a.files.length > 0) && (
        <div className="reg-cols">
          {a.tools.length > 0 && (
            <ul className="reg-tools-used" aria-label="Tools by use">
              {a.tools.map((t) => (
                <li key={t.name} title={`${t.name}: ${t.count} call${t.count === 1 ? "" : "s"}`}>
                  <span className="reg-tool-name">{t.name}</span>
                  <span className="reg-tool-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(4, (t.count / top) * 100)}%` }} />
                  </span>
                  <span className="reg-tool-n">{t.count}</span>
                </li>
              ))}
            </ul>
          )}
          {a.files.length > 0 && (
            <ul className="reg-files" aria-label="Files it wrote, the latest first">
              {files.map((f) => (
                <FileName key={f} file={f} cwd={cwd} />
              ))}
              {a.filesTouched > files.length && <li className="agents-fact">and {a.filesTouched - files.length} more</li>}
            </ul>
          )}
        </div>
      )}
      {a.lastPrompt && (
        <p className="reg-said reg-said-prompt">
          <span className="reg-said-who">last asked</span> {a.lastPrompt}
        </p>
      )}
      {a.lastReply && (
        <p className="reg-said">
          <span className="reg-said-who">last said</span> {a.lastReply}
        </p>
      )}
      {events.length > 0 && (
        <ol className="reg-events" aria-label="Latest activity, newest first">
          {shown.map((e, i) => (
            <li key={`${e.at ?? 0}-${i}`} className={`reg-ev ev-${e.kind}`}>
              <span className="reg-ev-at">{e.at !== null ? clockWord(e.at) : ""}</span>
              <span className="reg-ev-kind">{e.tool ? `${e.tool}${e.kind === "error" ? " failed" : ""}` : EVENT_WORD[e.kind]}</span>
              <span className="reg-ev-text">{e.text}</span>
            </li>
          ))}
        </ol>
      )}
      {(events.length > shown.length || a.files.length > files.length) && (
        <button type="button" className="mini" onClick={() => setAll(true)}>
          show all {events.length} events{a.files.length > files.length ? ` and ${a.files.length} files` : ""}
        </button>
      )}
      {all && events.length > 12 && (
        <button type="button" className="mini" onClick={() => setAll(false)}>
          fewer
        </button>
      )}
    </div>
  );
}

/** the states this page saw a card take, between its start and its end */
function Trail({ card, marks }: { card: AgentCard; marks: readonly TrailMark[] | undefined }) {
  if (!marks?.length) return null;
  return (
    <p className="reg-trail" title="The states this page saw it take while it was open">
      <span className="reg-said-who">seen here</span>
      {marks.map((m, i) => (
        <span key={`${m.at}-${i}`} className="reg-mark">
          {clockWord(m.at)} <span className={`rs-${m.state}`}>{m.waiting ? `waiting: ${m.waiting}` : m.state}</span>
        </span>
      ))}
      {card.endedAt !== null && card.state === "ended" && marks[marks.length - 1]?.state !== "ended" && (
        <span className="reg-mark">
          {clockWord(card.endedAt)} <span className="rs-ended">ended</span>
        </span>
      )}
    </p>
  );
}

/* ---------- the registry tab ---------- */

const GROUPINGS = [
  { value: "machine", label: "by machine", title: "One group per machine the agents run on" },
  { value: "repo", label: "by repo", title: "One group per repo the agents work in" },
] as const;

/** the day's ended and lost cards, folded under the running ones; `open`
 *  and `onOpen` hold the fold from outside, so the timeline can open it */
function PastCards({
  cards,
  now,
  showRepo,
  onGit,
  drilled,
  onDrill,
  open,
  onOpen,
}: {
  cards: AgentCard[];
  now: number;
  showRepo?: boolean;
  onGit?: () => void;
  drilled?: string | null;
  onDrill?: (id: string) => void;
  open?: boolean;
  onOpen?: (open: boolean) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <details className="reg-past" open={open} onToggle={(e) => onOpen?.(e.currentTarget.open)}>
      <summary>
        ended or lost today <span className="agents-fact">{cards.length}</span>
      </summary>
      <ul className="agents-list">
        {cards.map((c) => (
          <AgentRow
            key={c.id}
            card={c}
            now={now}
            showRepo={showRepo}
            onGit={onGit}
            {...(onDrill ? { open: drilled === c.id, onToggle: () => onDrill(c.id) } : {})}
          />
        ))}
      </ul>
    </details>
  );
}

/** The registry at a glance: the live agents by state, where they run,
 *  every agent's time since midnight, the longest running, the harnesses. */
function Summary({ s, now }: { s: RegistrySummary; now: number }) {
  const inbox = () => useStore.getState().openInbox();
  return (
    <dl className="reg-summary" aria-label="Summary">
      <div className="reg-stat">
        <dt>running</dt>
        <dd className="reg-stat-n">{s.live}</dd>
        <dd className="reg-stat-sub">
          <span className="rs-working">{s.working} working</span> ·{" "}
          {s.waiting > 0 ? (
            <button type="button" className="reg-stat-link rs-waiting" title="Open the inbox" onClick={inbox}>
              {s.waiting} waiting
            </button>
          ) : (
            <span>0 waiting</span>
          )}{" "}
          · <span className="rs-idle">{s.idle} idle</span>
        </dd>
      </div>
      <div className="reg-stat">
        <dt>machine{s.machines === 1 ? "" : "s"}</dt>
        <dd className="reg-stat-n">{s.machines}</dd>
        <dd className="reg-stat-sub">
          {s.repos} repo{s.repos === 1 ? "" : "s"}
          {s.harnesses.map((h) => (
            <span key={h.harness} className={`h-${h.harness}`} title={`${h.count} ${h.harness === "other" ? "other" : HARNESS[h.harness].label}`}>
              {" "}
              · {h.harness === "other" ? "other" : HARNESS[h.harness].glyph} {h.count}
            </span>
          ))}
        </dd>
      </div>
      <div className="reg-stat" title="Every agent's running time since midnight, added up: two at once for an hour is two hours">
        <dt>agent time today</dt>
        <dd className="reg-stat-n">{durationWord(s.todayMs)}</dd>
        <dd className="reg-stat-sub">
          {s.startedToday} started · {s.endedToday} ended{s.lostToday ? ` · ${s.lostToday} lost` : ""}
        </dd>
      </div>
      {s.longest && (
        <div className="reg-stat">
          <dt>longest running</dt>
          <dd className="reg-stat-n">{durationWord(now - s.longest.startedAt)}</dd>
          <dd className="reg-stat-sub" title={repoWord(s.longest)}>
            {cardName(s.longest)}
          </dd>
        </div>
      )}
    </dl>
  );
}

const LEGEND = ["working", "waiting", "idle", "ended", "lost"] as const;

/**
 * The day's runs on one time axis, a lane per agent, earliest start first:
 * a bar from its start to its end (to the right edge while it runs), in the
 * colour of its state now. A run from before midnight is cut flat at the
 * left. A lane is a button that opens the agent's row.
 */
function DayTimeline({ t, drilled, onPick }: { t: Timeline; drilled: string | null; onPick: (id: string) => void }) {
  if (t.lanes.length === 0) return null;
  const span = Math.max(1, t.to - t.from);
  const pct = (at: number) => ((at - t.from) / span) * 100;
  return (
    <section className="agents-section reg-timeline" aria-label="Today's runs">
      <h3 className="panel-label reg-group-head">
        today <span className="agents-fact">since {clockWord(t.from)}</span>
      </h3>
      <div className="tl">
        <div className="tl-axis" aria-hidden="true">
          <span />
          <span className="tl-ticks">
            {/* a label too near the right edge would run into "now" */}
            {t.ticks
              .filter((x) => pct(x.at) < 84)
              .map((x) => (
                <span key={x.at} className="tl-tick" style={{ left: `${pct(x.at)}%` }}>
                  {x.label}
                </span>
              ))}
            <span className="tl-tick tl-now">now</span>
          </span>
        </div>
        <div className="tl-lanes">
          <span className="tl-rules" aria-hidden="true">
            {t.ticks.map((x) => (
              <span key={x.at} style={{ left: `${pct(x.at)}%` }} />
            ))}
          </span>
          {t.lanes.map((l) => {
            const c = l.card;
            const label = `${cardName(c)}: ${stateWord(c)}, ${ageWord(c, t.to)}; started ${clockWord(c.startedAt)}`;
            return (
              <button key={c.id} type="button" className={drilled === c.id ? "tl-lane on" : "tl-lane"} aria-label={label} title={label} onClick={() => onPick(c.id)}>
                  <span className="tl-name">
                    <span className={`harness-glyph h-${c.harness}`}>{glyphOf(c)}</span> {cardName(c)}
                  </span>
                  <span className="tl-track">
                    <span
                      className={`tl-bar rs-${c.state}${l.clipped ? " clipped" : ""}`}
                      style={{ left: `${pct(l.start)}%`, width: `max(8px, ${pct(l.end) - pct(l.start)}%)` }}
                    />
                  </span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="tl-legend" aria-label="Colours">
        {LEGEND.map((k) => (
          <span key={k} className="tl-key">
            <span className={`tl-swatch rs-${k}`} aria-hidden="true" />
            {k}
          </span>
        ))}
      </p>
    </section>
  );
}

/**
 * The registry tab of the agents view: a summary, the day's runs on a
 * timeline, then every agent the broker knows, on any machine, grouped by
 * machine or repo with the busier groups first, running ones first in each;
 * then the day's ended and lost ones, folded. One row is drilled into at a
 * time; a lane of the timeline opens its row and brings it into view.
 */
export function RegistryTab({ onGit }: { onGit?: () => void }) {
  const all = useStore(useShallow((s) => Object.values(s.registry)));
  const [by, setBy] = useState<CardGrouping>("machine");
  const [drilled, setDrilled] = useState<string | null>(null);
  const [pastOpen, setPastOpen] = useState(false);
  const now = useNow();
  const { live, past } = useMemo(() => splitRecent(all, now), [all, now]);
  const groups = useMemo(() => groupCards(live, by), [live, by]);
  const summary = useMemo(() => registrySummary(all, now), [all, now]);
  const timeline = useMemo(() => timelineOf(all, now), [all, now]);
  const toggle = (id: string) => setDrilled((d) => (d === id ? null : id));
  const pick = (id: string) => {
    setDrilled(id);
    if (past.some((c) => c.id === id)) setPastOpen(true);
    requestAnimationFrame(() => document.getElementById(rowId(id))?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" }));
  };
  return (
    <>
      <Summary s={summary} now={now} />
      <DayTimeline t={timeline} drilled={drilled} onPick={pick} />
      <div className="agents-add reg-bar">
        <Seg label="Group agents" value={by} options={GROUPINGS} onChange={setBy} />
      </div>
      {live.length === 0 && <p className="settings-hint">No agent is running on any machine the broker hears from.</p>}
      {groups.map((g) => (
        <section key={g.key || "none"} className="agents-section" aria-label={g.label}>
          <h3 className="panel-label reg-group-head">
            {g.label} <span className="agents-fact">{g.cards.length}</span>
            {by === "repo" && <MessageAll url={g.cards.find((c) => c.repo)?.repo ?? null} />}
          </h3>
          <ul className="agents-list">
            {g.cards.map((c) => (
              <AgentRow key={c.id} card={c} now={now} showRepo={by === "machine"} onGit={onGit} open={drilled === c.id} onToggle={() => toggle(c.id)} />
            ))}
          </ul>
        </section>
      ))}
      <PastCards cards={past} now={now} onGit={onGit} drilled={drilled} onDrill={toggle} open={pastOpen} onOpen={setPastOpen} />
    </>
  );
}

/** "message all": the repo's own channel, `#repo.<owner>-<name>`, which
 *  every agent in the repo on any machine joins when it starts (the
 *  tailchan hook's rule). Nothing without a broker or a web url to name it. */
export function MessageAll({ url }: { url: string | null }) {
  const ready = useStore((s) => s.chan?.ready === true);
  const channel = repoChannel(url);
  if (!ready || !channel) return null;
  return (
    <button
      type="button"
      className="mini reg-message-all"
      title={`Post to #${channel}, which every agent working in this repo hears on its next turn`}
      onClick={() => useStore.getState().openChan(`#${channel}`)}
    >
      message all
    </button>
  );
}

/** The `✦ n` on a repo card: its live agents on any machine, rust while
 *  one waits, the list in its tooltip; a click opens the panel's agents
 *  section. Nothing when none runs. */
export function AgentChip({ repoId }: { repoId: string }) {
  const cards = useStore((s) => agentsOn(s, repoId));
  const showAgents = useStore((s) => s.showAgents);
  const live = cards.filter(isLiveAgent);
  if (live.length === 0) return null;
  const title = live.map((c) => `${cardName(c)}: ${stateWord(c)}, ${whereWord(c)}`).join("\n");
  return (
    <button
      type="button"
      className={`run-chip agent-chip${anyWaiting(live) ? " waiting" : ""}`}
      title={title}
      aria-label={`${live.length} agent${live.length === 1 ? "" : "s"} on ${repoId}`}
      onClick={(e) => {
        e.stopPropagation();
        showAgents(repoId);
      }}
      onAuxClick={(e) => e.stopPropagation()}
      onKeyDown={keepKeys}
    >
      ✦ {live.length}
    </button>
  );
}

/** A panel's agents section: the same rows as the registry tab, only the
 *  ones on this repo's card, anywhere; nothing without a registry. */
export function AgentsSection({ repo }: { repo: Repo }) {
  const ready = useStore((s) => s.registryReady);
  const cards = useStore((s) => agentsOn(s, repo.id));
  const now = useNow();
  const { live, past } = useMemo(() => splitRecent(cards, now), [cards, now]);
  if (!ready) return null;
  const count = liveCount(live);
  return (
    <Section
      repo={repo}
      k="agents"
      className="reg-section"
      label="Agents"
      head={count ? <span className={anyWaiting(live) ? "reg-head-waiting" : undefined}>{count}</span> : null}
      title="The agents working in this repo, on any machine"
    >
      <div className="reg-body">
        <div className="reg-tools">
          <MessageAll url={repo.link ?? null} />
        </div>
        {live.length === 0 && <p className="panel-clean">No agent is working in this repo.</p>}
        {live.length > 0 && (
          <ul className="agents-list">
            {live.map((c) => (
              <AgentRow key={c.id} card={c} now={now} showRepo={false} />
            ))}
          </ul>
        )}
        <PastCards cards={past} now={now} showRepo={false} />
      </div>
    </Section>
  );
}

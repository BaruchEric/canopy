import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { CRON_MAX, isCron, parseCron } from "../../../src/core/cron";
import { isSeedRepoId } from "../../../src/core/sprout";
import {
  atWords,
  axisTicks,
  clockJobs,
  clockRows,
  clockWindow,
  clockWords,
  comingFires,
  firesIn,
  fullTime,
  hhmm,
  kindWords,
  laneMarks,
  lineFires,
  lineOf,
  nextUp,
  nights,
  readWhen,
  titleOf,
  untilWords,
  whenWords,
  type AxisTick,
  type ClockRow,
  type ClockSpan,
  type Job,
  type LaneMarks,
} from "../clock";
import { openView } from "../clirun";
import { CRON_PRESETS, bumpField, cronLegend, cronWords, fieldAt, fieldSpan } from "../cronwords";
import { PHONE, useMedia } from "../media";
import { backendOf, plainOf, qual } from "../registry";
import { say } from "../said";
import { useStore } from "../store";
import { scheduleWord } from "../triggers";
import { ago } from "../util";
import { useNow } from "./Registry";
import { Seg } from "./Seg";

type WakeJob = Extract<Job, { kind: "wake" }>;
type RuleJob = Extract<Job, { kind: "rule" | "poll" }>;
type ReminderJob = Extract<Job, { kind: "reminder" }>;

type Call = { kind: "idle" } | { kind: "busy" } | { kind: "failed"; error: string };
const IDLE: Call = { kind: "idle" };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const pct = (x: number): string => `${(x * 100).toFixed(3)}%`;

const SPANS = [
  { value: "day", label: "24 hours", title: "The next day, hour by hour" },
  { value: "week", label: "7 days", title: "The next week, day by day" },
] as const;

/** One call at a time for a row's detail: busy while it is out, its refusal
 *  kept to show, and a word on the page's quiet line when it lands. */
function useCall(): { call: Call; busy: boolean; run: (work: () => Promise<unknown>, done?: string) => void } {
  const [call, setCall] = useState<Call>(IDLE);
  const run = (work: () => Promise<unknown>, done?: string) => {
    setCall({ kind: "busy" });
    work().then(
      () => {
        setCall(IDLE);
        if (done) say(done);
      },
      (e: unknown) => setCall({ kind: "failed", error: errText(e) }),
    );
  };
  return { call, busy: call.kind === "busy", run };
}

function CallError({ call }: { call: Call }) {
  if (call.kind !== "failed") return null;
  return (
    <p className="clock-err" role="alert">
      {call.error}
    </p>
  );
}

/** The repo's name as the tree shows it, else its id. */
function useRepoName(id: string, backend: string): string {
  return useStore((s) => s.repos.find((r) => r.id === qual(backend, id) || (backendOf(r.id) === backend && r.path === id))?.name ?? id);
}

/* ---------- the lane ---------- */

/** what every lane draws behind its marks: the nights and each midnight */
interface Shade {
  nights: { x0: number; x1: number }[];
  midnights: number[];
}

/** A lane's marks with what has fired and what is to come grouped apart,
 *  so a band never runs through now. */
function marksOf(fires: readonly number[], frame: Frame): LaneMarks {
  const past = laneMarks(fires.filter((t) => t < frame.now), frame.from, frame.to, frame.gap);
  const coming = laneMarks(fires.filter((t) => t >= frame.now), frame.from, frame.to, frame.gap);
  return { ticks: [...past.ticks, ...coming.ticks], bands: [...past.bands, ...coming.bands] };
}

/**
 * One job's stretch of the axis: a tick where it fires, a band where the
 * fires come too close to draw apart, and the line of now. The fire that
 * comes next stands taller than the rest, at the head of a band when that
 * is where it falls. Drawn for the eye alone, since the row says the same
 * in words.
 */
function Lane({ marks, shade, now, nowX, once, due, onClick }: { marks: LaneMarks; shade: Shade; now: number; nowX: number; once: boolean; due: boolean; onClick?: () => void }) {
  const tick = marks.ticks.find((t) => t.t >= now);
  const band = marks.bands.find((b) => b.from >= now);
  const head = band && (!tick || band.from < tick.t) ? band : null;
  const coming = head ? null : tick?.t;
  return (
    <div className="clock-lane" aria-hidden="true" onClick={onClick}>
      {shade.nights.map((n) => (
        <i key={`n${n.x0}`} className="clock-night" style={{ left: pct(n.x0), width: pct(n.x1 - n.x0) }} />
      ))}
      {shade.midnights.map((x) => (
        <i key={`m${x}`} className="clock-midnight" style={{ left: pct(x) }} />
      ))}
      {marks.bands.map((b) => (
        <i key={`b${b.from}`} className={b.to < now ? "clock-band past" : "clock-band"} title={`${b.count} fires, ${fullTime(b.from)} to ${fullTime(b.to)}`} style={{ left: pct(b.x0), width: pct(b.x1 - b.x0) }} />
      ))}
      {marks.ticks.map((t) => (
        <i key={t.t} className={`clock-tick${once ? " once" : ""}${t.t < now ? " past" : t.t === coming ? " coming" : ""}`} title={fullTime(t.t)} style={{ left: pct(t.x) }} />
      ))}
      {head && <i className="clock-tick coming" title={fullTime(head.from)} style={{ left: pct(head.x0) }} />}
      {due && <i className="clock-tick once due" title="Due, and waiting to be delivered" style={{ left: pct(nowX) }} />}
      <i className="clock-now" style={{ left: pct(nowX) }} />
    </div>
  );
}

/** The hours over the lanes, with the time of now hung on its line. Only
 *  what is to come is labelled, and a label gives way where it would run
 *  into the time of now or hang off the end. */
function Axis({ ticks, now, nowX, clear }: { ticks: AxisTick[]; now: number; nowX: number; clear: number }) {
  return (
    <div className="clock-axis" aria-hidden="true">
      {ticks
        .filter((t) => t.x - nowX >= clear && t.x <= 0.985)
        .map((t) => (
          <span key={t.x} className={t.day ? "clock-axis-tick day" : "clock-axis-tick"} style={{ left: pct(t.x) }}>
            {t.label}
          </span>
        ))}
      <span className="clock-axis-now" style={{ left: pct(nowX) }}>
        {hhmm(now)}
      </span>
    </div>
  );
}

/* ---------- the line editor ---------- */

/**
 * A cron line being typed: the five fields named under it with the one the
 * caret is in marked, the line as a sentence or why it does not read, and
 * when it fires next. Up and down step the number under the caret, so a
 * time can be nudged while its marks move in the lane above.
 */
function CronField({ value, onChange, backend, shift, now, disabled, labelledBy }: { value: string; onChange: (line: string) => void; backend: string; shift: number; now: number; disabled?: boolean; labelledBy: string }) {
  const says = useId();
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  // where the caret goes once a stepped line is on the screen
  const place = useRef<{ start: number; end: number } | null>(null);
  useLayoutEffect(() => {
    const at = place.current;
    if (!at || !input.current) return;
    place.current = null;
    input.current.setSelectionRange(at.start, at.end);
    setCaret(at.end);
  }, [value]);
  const sync = () => setCaret(input.current?.selectionStart ?? null);
  const line = value.trim();
  const read = line ? parseCron(line) : null;
  const error = line.length > CRON_MAX ? `A cron line is at most ${CRON_MAX} characters.` : read && "error" in read ? read.error : null;
  const words = cronWords(line);
  const field = caret === null ? null : fieldAt(value, caret);
  const minute = Math.floor(now / 60_000);
  const coming = useMemo(() => comingFires(line, minute * 60_000, shift, 3), [line, minute, shift]);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const got = bumpField(value, e.currentTarget.selectionStart ?? value.length, e.key === "ArrowUp" ? 1 : -1);
    if (!got) return;
    e.preventDefault();
    place.current = { start: got.caret, end: got.caret };
    onChange(got.line);
  };
  const select = (i: number) => {
    const span = fieldSpan(value, i);
    if (!span || !input.current) return;
    input.current.focus();
    input.current.setSelectionRange(span.start, span.end);
    setCaret(span.end);
  };
  return (
    <div className="clock-cron">
      <input
        ref={input}
        className="clock-line"
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder="0 9 * * *"
        aria-labelledby={labelledBy}
        aria-describedby={says}
        aria-invalid={error !== null}
        aria-keyshortcuts="ArrowUp ArrowDown"
        title="Five fields. The up and down arrows step the number the caret is on."
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onKeyUp={sync}
        onClick={sync}
        onSelect={sync}
        onBlur={() => setCaret(null)}
      />
      <div className="clock-legend">
        {cronLegend(value).map((f, i) => (
          // the press must not take the focus from the line: the field is selected in it
          <button key={f.name} type="button" tabIndex={-1} className={i === field ? "on" : undefined} disabled={disabled} title={`Select the ${f.name}`} onMouseDown={(e) => e.preventDefault()} onClick={() => select(i)}>
            <code>{f.token || " "}</code>
            <span>{f.name}</span>
          </button>
        ))}
      </div>
      <p id={says} className={error ? "clock-says bad" : "clock-says"} role={error ? "alert" : undefined}>
        {error ?? (words ? `${words}${shift !== 0 ? `, on ${backend}'s clock` : ""}` : "Minute, hour, day of the month, month, day of the week.")}
      </p>
      {coming.length > 0 && (
        <p className="clock-coming">
          {shift !== 0 ? "Next, on this device's clock: " : "Next: "}
          {coming.map((t) => clockWords(t, now)).join(", ")}
        </p>
      )}
      <div className="clock-presets">
        {CRON_PRESETS.map((p) => (
          <button key={p.line} type="button" className="mini" disabled={disabled} title={p.line} onClick={() => onChange(p.line)}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- a row's detail, by kind ---------- */

interface DetailProps<J extends Job = Job> {
  job: J;
  shift: number;
  now: number;
  /** the line being typed, which the row's lane draws in place of its own */
  draft: string | null;
  setDraft: (line: string | null) => void;
  close: () => void;
}

/** Why a job is not armed, on a rail in its state's color. */
function Standing({ job }: { job: Job }) {
  if (job.standing.state === "armed") return null;
  return <p className={`clock-why ${job.standing.state}`}>{job.standing.why}</p>;
}

/** A removal asked for twice: the first press arms the button for a few seconds. */
function RemoveButton({ busy, onRemove, title }: { busy: boolean; onRemove: () => void; title: string }) {
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const t = setTimeout(() => setSure(false), 4000);
    return () => clearTimeout(t);
  }, [sure]);
  return (
    <button type="button" className={sure ? "mini confirm" : "mini"} disabled={busy} title={sure ? "Press again to remove it for good" : title} onClick={() => (sure ? onRemove() : setSure(true))}>
      {sure ? "remove for good" : "remove"}
    </button>
  );
}

const SETTER = { eric: "You set it", ranger: "The ranger set it itself", run: "A run set it" } as const;

function WakeDetail({ job, shift, now, draft, setDraft, close }: DetailProps<WakeJob>) {
  const w = job.wake;
  const { addWake, removeWake } = useStore(useShallow((s) => ({ addWake: s.addRangerWake, removeWake: s.removeRangerWake })));
  const [prompt, setPrompt] = useState(w.prompt);
  const { call, busy, run } = useCall();
  const label = useId();
  const own = lineOf(job);
  const line = draft ?? own ?? "";
  const changed = own !== null && (prompt.trim() !== w.prompt || line.trim() !== own);
  const valid = prompt.trim() !== "" && isCron(line.trim());
  // the backend has no edit: the changed wake is added, then the old one removed
  const save = () =>
    run(async () => {
      await addWake(job.backend, { cron: line.trim(), prompt: prompt.trim() });
      await removeWake(job.backend, w.id);
      close();
    }, "Saved");
  return (
    <>
      <Standing job={job} />
      <div className={own !== null ? "clock-fields" : "clock-fields one"}>
        {own !== null ? (
          <label className="layout-field">
            what the ranger is told
            <textarea value={prompt} disabled={busy} rows={6} onChange={(e) => setPrompt(e.target.value)} />
          </label>
        ) : (
          <div className="layout-field">
            what the ranger is told
            <p className="clock-prompt">{w.prompt}</p>
          </div>
        )}
        {own !== null && (
          <div className="layout-field">
            <span id={label}>when, on {job.backend}'s clock</span>
            <CronField value={line} onChange={setDraft} backend={job.backend} shift={shift} now={now} disabled={busy} labelledBy={label} />
          </div>
        )}
      </div>
      <p className="clock-facts">
        {SETTER[w.by]} {ago(w.created / 1000)}
        {w.from ? `, from run ${w.from}` : ""}.{own !== null && w.by !== "eric" ? " Saving a change makes it yours." : ""}
        {job.when.kind === "once" ? ` It fires once, ${atWords(job.when.at, now)}, and is gone.` : ""}
        {job.when.kind === "run" ? " It fires when that run ends, and is gone." : ""}
      </p>
      <div className="clock-acts">
        {own !== null && (
          <button type="button" className="mini strong" disabled={busy || !changed || !valid} onClick={save}>
            save
          </button>
        )}
        <button
          type="button"
          className="mini"
          disabled={busy}
          title="Send this prompt to the ranger within a minute, and leave the wake as it is"
          onClick={() => run(() => addWake(job.backend, { when: "in 1m", prompt: w.prompt }), "The ranger hears it within a minute")}
        >
          wake now
        </button>
        <RemoveButton busy={busy} title="Take this wake off the ranger" onRemove={() => run(() => removeWake(job.backend, w.id).then(close), "Removed")} />
      </div>
      <CallError call={call} />
    </>
  );
}

function FreshDetail({ job }: DetailProps) {
  const daily = useStore((s) => s.rangers[job.backend]?.settings.fresh.daily ?? "");
  const setRanger = useStore((s) => s.setRanger);
  const [typed, setTyped] = useState<string | null>(null);
  const { call, busy, run } = useCall();
  const commit = () => {
    if (typed === null) return;
    const value = typed || null;
    setTyped(null);
    if (value !== (daily || null)) run(() => setRanger(job.backend, { fresh: { daily: value } }), value ? "Saved" : "The daily fresh start is off");
  };
  return (
    <>
      <p className="clock-facts">Each day at this time canopy moves the ranger on {job.backend} to a new conversation, once it has gone quiet, so its transcript stays short.</p>
      <div className="clock-fields">
        <label className="layout-field">
          fresh daily at, on {job.backend}'s clock
          <input
            className="settings-input clock-time"
            type="time"
            disabled={busy}
            value={typed ?? daily}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
          />
        </label>
      </div>
      <p className="clock-note">Clear the time to stop. Settings also starts one past a transcript size.</p>
      <CallError call={call} />
    </>
  );
}

function RuleDetail({ job, now }: DetailProps<RuleJob>) {
  const rule = job.rule;
  const repoName = useRepoName(rule.repo, job.backend);
  const allRepos = useStore((s) => s.repos);
  const { fireTrigger, pollTrigger } = useStore(useShallow((s) => ({ fireTrigger: s.fireTrigger, pollTrigger: s.pollTrigger })));
  const repos = useMemo(() => allRepos.filter((r) => backendOf(r.id) === job.backend && !r.host && !r.forge && !r.error && !isSeedRepoId(plainOf(r.id))), [allRepos, job.backend]);
  const [repo, setRepo] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const { call, busy, run } = useCall();
  const armed = job.standing.state === "armed";
  const fire = () =>
    run(async () => {
      const d = await fireTrigger(job.backend, rule.name, "", repo || undefined);
      setNote(d.kind === "skip" ? d.why : d.kind === "fired" ? `${d.events.length} started, ${d.skipped.length} skipped` : `${d.kind}: ${d.event.short ?? d.event.key}`);
    });
  return (
    <>
      <Standing job={job} />
      <p className="clock-facts">
        {job.kind === "rule"
          ? `Runs ${rule.workflow} on ${scheduleWord(rule, repoName)}, and ${rule.land === "queue" ? "lands what it commits through the queue" : "opens a pull request for what it commits"}.`
          : `Lists the issues of ${repoName} labelled ${rule.labels.join(", ")} and starts ${rule.workflow} for each new one.`}{" "}
        {job.last !== undefined ? `It last fired ${atWords(job.last, now)}.` : job.kind === "rule" ? "It has never fired." : ""}
      </p>
      {(rule.skips?.length ?? 0) > 0 && (
        <ul className="clock-skips">
          {rule.skips?.map((skip, i) => (
            <li key={`${skip.repo}-${skip.at}-${i}`}>
              Skipped {skip.repo} {ago(skip.at / 1000)}: {skip.why}
            </li>
          ))}
        </ul>
      )}
      <div className="clock-acts">
        {job.kind === "rule" ? (
          <>
            <select className="settings-input clock-repo" aria-label="Which repo to fire" value={repo} disabled={busy || !armed} onChange={(e) => setRepo(e.target.value)}>
              <option value="">every matching repo</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button type="button" className="mini strong" disabled={busy || !armed} title="Fire the rule now: one run per matching repo, skipped where the last run still goes" onClick={fire}>
              {busy ? "firing…" : "fire now"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="mini strong"
            disabled={busy || !armed}
            title="List the repo's labelled issues now, without waiting for the poll, and start a run for each new one"
            onClick={() => run(() => pollTrigger(job.backend, rule.name), "Polled")}
          >
            {busy ? "polling…" : "poll now"}
          </button>
        )}
        <button type="button" className="mini" title="The triggers view: every run this rule started, and what became of each" onClick={() => openView("triggers")}>
          what it started
        </button>
        {note && <span className="clock-note">{note}</span>}
      </div>
      <p className="clock-note">
        Its line, <code>{lineOf(job)}</code>, is the rule's <code>{job.kind === "rule" ? "cron" : "poll"}</code> in <code>triggers.json</code> on {job.backend}. canopy reads that file again before each use, so a change there
        shows here.
      </p>
      <CallError call={call} />
    </>
  );
}

function SweepDetail({ job, shift, now, draft, setDraft }: DetailProps) {
  const sweep = useStore((s) => s.sweep);
  const { setSweepSettings, openSweep } = useStore(useShallow((s) => ({ setSweepSettings: s.setSweepSettings, openSweep: s.openSweep })));
  const { call, busy, run } = useCall();
  const label = useId();
  if (!sweep) return null;
  const s = sweep.settings;
  const line = draft ?? s.cron;
  const last = sweep.lastRun;
  const closed = last?.outcomes.filter((o) => o.result === "closed").length ?? 0;
  return (
    <>
      <div className="clock-fields">
        <div className="layout-field">
          <label className="settings-line">
            <input type="checkbox" checked={s.on} disabled={busy} onChange={(e) => run(() => setSweepSettings({ on: e.target.checked }), e.target.checked ? "The sweep's schedule is on" : "The sweep's schedule is off")} />
            sweep on a schedule
          </label>
          <p className="clock-facts">
            On its line the sweep closes what went idle among the kinds set to close on their own, and asks in the inbox about the rest.
            {last ? ` It last ran ${atWords(last.at, now)}, ${last.by === "schedule" ? "on its schedule" : "by hand"}, and closed ${closed} of ${last.outcomes.length}.` : " It has not run yet."}
          </p>
          <p className="clock-note">How long each kind sits idle before the sweep takes it, and what it closes without asking, are in Settings.</p>
        </div>
        <div className="layout-field">
          <span id={label}>when, on {job.backend}'s clock</span>
          <CronField value={line} onChange={setDraft} backend={job.backend} shift={shift} now={now} disabled={busy} labelledBy={label} />
        </div>
      </div>
      <div className="clock-acts">
        <button type="button" className="mini strong" disabled={busy || line.trim() === s.cron || !isCron(line.trim())} onClick={() => run(() => setSweepSettings({ cron: line.trim() }).then(() => setDraft(null)), "Saved")}>
          save
        </button>
        <button type="button" className="mini" title="What is idle right now, to close by hand" onClick={openSweep}>
          open the sweep
        </button>
      </div>
      <CallError call={call} />
    </>
  );
}

function ReminderDetail({ job, now, close }: DetailProps<ReminderJob>) {
  const { done, openNotes } = useStore(useShallow((s) => ({ done: s.doneQuickNote, openNotes: s.openQuickNotes })));
  const { call, busy, run } = useCall();
  return (
    <>
      <p className="clock-prompt">{job.note.text}</p>
      <p className="clock-facts">It lands in the inbox {job.when.kind === "once" ? atWords(job.when.at, now) : "when it is due"}.</p>
      <div className="clock-acts">
        <button type="button" className="mini strong" disabled={busy} title="Mark the note done, so it never lands" onClick={() => run(() => done(job.note.id).then(close), "Done")}>
          done
        </button>
        <button type="button" className="mini" title="The notes pad, where its words and its time change" onClick={openNotes}>
          open notes
        </button>
      </div>
      <CallError call={call} />
    </>
  );
}

function Detail(props: DetailProps): ReactNode {
  const { job } = props;
  switch (job.kind) {
    case "wake":
      return <WakeDetail {...props} job={job} />;
    case "fresh":
      return <FreshDetail {...props} />;
    case "rule":
    case "poll":
      return <RuleDetail {...props} job={job} />;
    case "sweep":
      return <SweepDetail {...props} />;
    case "reminder":
      return <ReminderDetail {...props} job={job} />;
    default: {
      const _exhaustive: never = job;
      return _exhaustive;
    }
  }
}

/* ---------- the rows ---------- */

interface Frame {
  from: number;
  to: number;
  now: number;
  nowX: number;
  /** fires closer together than this are one band, ms */
  gap: number;
  shade: Shade;
}

const NO_NEXT: Record<Exclude<Job["standing"]["state"], "armed">, string> = { held: "held", off: "off", broken: "cannot fire" };

function Row({ row, frame, many, open, onToggle }: { row: ClockRow; frame: Frame; many: boolean; open: boolean; onToggle: () => void }) {
  const { job, next, shift } = row;
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) setDraft(null);
  }, [open]);
  const state = job.standing.state;
  // a line being typed stands in for the job's own until it is saved: the
  // lane, the words and the time are the typed line's, whatever the job's state
  const typed = draft !== null && draft.trim() !== lineOf(job) ? draft.trim() : null;
  const marks = useMemo(() => {
    if (typed !== null) return laneMarks(lineFires(typed, frame.now, frame.to, shift), frame.from, frame.to, frame.gap);
    // a job that will not fire has no marks, and only what was delivered is drawn behind now
    const all = state === "armed" || state === "held" ? firesIn(job, frame.from, frame.to, shift) : [];
    return marksOf(state === "armed" ? all : all.filter((t) => t >= frame.now), frame);
  }, [typed, job, state, shift, frame]);
  const typedNext = useMemo(() => (typed === null ? null : (comingFires(typed, frame.now, shift, 1)[0] ?? null)), [typed, frame.now, shift]);
  const words = typed !== null ? (cronWords(typed) ?? "A line that does not read yet") : whenWords(job);
  const close = () => {
    onToggle();
    button.current?.focus();
  };
  return (
    <li
      className={`clock-row ${state}${open ? " open" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button ref={button} type="button" className="clock-job" aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
        <span className="clock-title" title={job.title}>
          {job.title}
        </span>
        <span className="clock-sub">
          <span className="clock-when">{words}</span>
          <span className="clock-kind">
            {kindWords(job)}
            {many ? ` on ${job.backend}` : ""}
          </span>
        </span>
      </button>
      <Lane marks={marks} shade={frame.shade} now={frame.now} nowX={frame.nowX} once={job.when.kind === "once"} due={typed === null && next !== null && next <= frame.now} onClick={onToggle} />
      <div className="clock-next" title={typed !== null ? "The line as typed. Save it to keep it." : job.standing.state !== "armed" ? job.standing.why : next !== null ? fullTime(next) : undefined}>
        {typed !== null ? (
          <>
            <span className="clock-until">{typedNext !== null ? untilWords(typedNext - frame.now) : "no time"}</span>
            <span className="clock-at draft">not saved</span>
          </>
        ) : next !== null ? (
          <>
            <span className="clock-until">{untilWords(next - frame.now)}</span>
            <span className="clock-at">{state === "held" ? "held" : clockWords(next, frame.now)}</span>
          </>
        ) : (
          <span className="clock-until">{job.standing.state !== "armed" ? NO_NEXT[job.standing.state] : job.when.kind === "run" ? "on a run" : "never again"}</span>
        )}
      </div>
      {open && (
        <div className="clock-detail" id={id}>
          <Detail job={job} shift={shift} now={frame.now} draft={draft} setDraft={setDraft} close={close} />
        </div>
      )}
    </li>
  );
}

/**
 * A new wake for a ranger, as a row of its own at the head of the list: its
 * lane shows the line, or the one time, as it is typed.
 */
function NewWake({ backends, shifts, frame, close }: { backends: readonly string[]; shifts: Readonly<Record<string, number>>; frame: Frame; close: () => void }) {
  const addWake = useStore((s) => s.addRangerWake);
  const [backend, setBackend] = useState(backends[0] ?? "");
  const [mode, setMode] = useState<"cron" | "once">("cron");
  const [prompt, setPrompt] = useState("");
  const [line, setLine] = useState("0 9 * * *");
  const [when, setWhen] = useState("");
  const { call, busy, run } = useCall();
  const label = useId();
  const shift = shifts[backend] ?? 0;
  const once = when.trim() ? readWhen(when.trim(), frame.now, shift) : null;
  const onceAt = typeof once === "number" ? once : null;
  const marks = useMemo(() => {
    const fires = mode === "cron" ? lineFires(line.trim(), frame.now, frame.to, shift) : onceAt !== null && onceAt < frame.to ? [onceAt] : [];
    return laneMarks(fires, frame.from, frame.to, frame.gap);
  }, [mode, line, onceAt, shift, frame.from, frame.to, frame.now, frame.gap]);
  const valid = prompt.trim() !== "" && (mode === "cron" ? isCron(line.trim()) : onceAt !== null);
  const add = () =>
    run(async () => {
      await addWake(backend, mode === "cron" ? { cron: line.trim(), prompt: prompt.trim() } : { when: when.trim(), prompt: prompt.trim() });
      close();
    }, "Wake added");
  const words = mode === "cron" ? (cronWords(line.trim()) ?? "A line that does not read yet") : onceAt !== null ? `Once, ${clockWords(onceAt, frame.now)}` : "Once";
  return (
    <div
      className="clock-row armed open new"
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div className="clock-job">
        <span className="clock-title">{prompt.trim() ? titleOf(prompt) : "A new wake"}</span>
        <span className="clock-sub">
          <span className="clock-when">{words}</span>
          <span className="clock-kind">your wake{backends.length > 1 ? ` on ${backend}` : ""}</span>
        </span>
      </div>
      <Lane marks={marks} shade={frame.shade} now={frame.now} nowX={frame.nowX} once={mode === "once"} due={false} />
      <div className="clock-next">
        <span className="clock-until">not saved</span>
      </div>
      <form
        className="clock-detail"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) add();
        }}
      >
        <div className="clock-fields">
          <label className="layout-field">
            what the ranger is told
            {/* the form opens on a press of "new wake", so the focus belongs in its first field */}
            <textarea value={prompt} disabled={busy} rows={6} autoFocus placeholder="Look at the landing queue. If a branch has waited more than a day, tell me which and why." onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <div className="layout-field">
            <span className="clock-mode">
              <span id={label}>when, on {backend}'s clock</span>
              <Seg
                label="How often"
                value={mode}
                options={[
                  { value: "cron", label: "on a line", title: "Again and again, on a cron line" },
                  { value: "once", label: "once", title: "One time, then it is gone" },
                ]}
                onChange={setMode}
              />
            </span>
            {mode === "cron" ? (
              <CronField value={line} onChange={setLine} backend={backend} shift={shift} now={frame.now} disabled={busy} labelledBy={label} />
            ) : (
              <div className="clock-cron">
                <input className="clock-line" value={when} disabled={busy} spellCheck={false} autoCapitalize="off" placeholder="in 30m" aria-labelledby={label} aria-invalid={once !== null && onceAt === null} onChange={(e) => setWhen(e.target.value)} />
                <p className={once !== null && onceAt === null ? "clock-says bad" : "clock-says"} role={once !== null && onceAt === null ? "alert" : undefined}>
                  {once === null ? "in 30m, 14:00, or 2026-12-01 09:00" : typeof once === "number" ? `Once, ${clockWords(once, frame.now)}${shift !== 0 ? " on this device's clock" : ""}` : once.error}
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="clock-acts">
          <button type="submit" className="mini strong" disabled={busy || !valid}>
            add wake
          </button>
          <button type="button" className="mini" disabled={busy} onClick={close}>
            cancel
          </button>
          {backends.length > 1 && (
            <label className="clock-on">
              on
              <select className="settings-input" value={backend} disabled={busy} onChange={(e) => setBackend(e.target.value)}>
                {backends.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <CallError call={call} />
      </form>
    </div>
  );
}

const NEW = "new";

/**
 * The clock view: everything the shown backends do by the clock on one
 * axis. Each job is a row with its lane; a row opens in place to change its
 * line, fire it or remove it, and the lane redraws as the line is typed.
 */
export function ClockView() {
  const input = useStore(useShallow((s) => ({ rangers: s.rangers, triggers: s.triggers, sweep: s.sweep, notes: s.quickNotes, home: s.home, order: s.backendOrder })));
  const loadTriggers = useStore((s) => s.loadTriggers);
  const now = useNow(30_000);
  const phone = useMedia(PHONE);
  const [span, setSpan] = useState<ClockSpan>("day");
  const [open, setOpen] = useState<string | null>(null);
  const jobs = useMemo(() => clockJobs(input), [input]);
  const rows = useMemo(() => clockRows(jobs, now), [jobs, now]);
  const shifts = useMemo(() => Object.fromEntries(rows.map((r) => [r.job.backend, r.shift])), [rows]);
  const { from, to } = clockWindow(now, span);
  const frame = useMemo((): Frame => {
    const axis = axisTicks(from, to, span);
    return { from, to, now, nowX: (now - from) / (to - from), gap: (to - from) / (phone ? 70 : 160), shade: { nights: nights(from, to), midnights: axis.filter((t) => t.day).map((t) => t.x) } };
  }, [from, to, now, span, phone]);
  const ticks = useMemo(() => axisTicks(from, to, span, phone), [from, to, span, phone]);

  // a rule's next and last fire come only with a read of its backend, never
  // on the stream: read once on the way in, and again while a time the page
  // holds for a rule has passed
  const { order } = input;
  useEffect(() => {
    for (const b of order) void loadTriggers(b);
  }, [order, loadTriggers]);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const { job } of rows) {
      if ((job.kind !== "rule" && job.kind !== "poll") || job.next === undefined || job.next > now) continue;
      const mark = `${job.key}@${Math.floor(now / 120_000)}`;
      if (asked.current.has(mark)) continue;
      if (asked.current.size > 200) asked.current.clear();
      asked.current.add(mark);
      void loadTriggers(job.backend);
    }
  }, [rows, now, loadTriggers]);

  const lead = nextUp(rows);
  const many = order.length > 1;
  const rangers = order.filter((b) => input.rangers[b] !== undefined);
  const toggle = (key: string) => setOpen((was) => (was === key ? null : key));
  const held = rows.some((r) => r.job.standing.state === "held");
  const shifted = order.filter((b) => (shifts[b] ?? 0) !== 0);
  return (
    <main className="health-view clock-view">
      <header className="clock-head">
        <p className="clock-lead">
          {lead && lead.next !== null
            ? `${lead.job.title} is ${lead.next <= now ? "due now" : `next, ${untilWords(lead.next - now)}`}${many ? ` on ${lead.job.backend}` : ""}.`
            : rows.length === 0
              ? "Nothing is on the clock."
              : "Nothing here will fire as things stand."}
        </p>
        <div className="clock-tools">
          <Seg label="How far ahead the lanes show" value={span} options={SPANS} onChange={setSpan} />
          <button type="button" className="mini strong" disabled={rangers.length === 0} title={rangers.length === 0 ? "No backend here has a ranger to wake" : "Wake a ranger with a prompt, on a cron line or once"} onClick={() => toggle(NEW)}>
            new wake
          </button>
        </div>
      </header>
      {lead === null && open !== NEW && (
        <p className="clock-empty">
          A wake is a prompt a ranger is sent, on a cron line or once. Start with one for every morning. The wakes a ranger sets itself show here too, with the sweep's schedule, reminders, and the <code>schedule</code> rules
          and polled issue rules in <code>triggers.json</code>.
        </p>
      )}
      {(rows.length > 0 || open === NEW) && (
        <section className="clock-board" aria-label="Everything on the clock, soonest first">
          <Axis ticks={ticks} now={now} nowX={frame.nowX} clear={phone ? 0.17 : 0.03} />
          {open === NEW && rangers.length > 0 && <NewWake backends={rangers} shifts={shifts} frame={frame} close={() => setOpen(null)} />}
          <ol className="clock-rows">
            {rows.map((row) => (
              <Row key={row.job.key} row={row} frame={frame} many={many} open={open === row.job.key} onToggle={() => toggle(row.job.key)} />
            ))}
          </ol>
        </section>
      )}
      {rows.length > 0 && (
        <footer className="clock-foot">
          <ul className="clock-key" aria-label="What the marks mean">
            <li>
              <i className="clock-tick" /> fires
            </li>
            <li>
              <i className="clock-tick once" /> fires once
            </li>
            <li>
              <i className="clock-band" /> too often to draw apart
            </li>
            {held && (
              <li className="held">
                <i className="clock-tick" /> held until it can be delivered
              </li>
            )}
          </ul>
          <p className="clock-note">
            A line is read on its own backend's clock.
            {shifted.length > 0 ? ` ${shifted.join(" and ")} ${shifted.length === 1 ? "keeps" : "keep"} another time than this device, so the lanes and the times here are this device's.` : ""}
          </p>
        </footer>
      )}
    </main>
  );
}

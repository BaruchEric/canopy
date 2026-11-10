/**
 * The clock view's model: everything the backends do by the clock as one
 * list of jobs (the ranger's wakes and its daily fresh start, schedule
 * rules, a rule's poll, the sweep, reminders), when each fires inside a
 * window of time, and the marks a lane draws for them. Pure; Clock.tsx
 * draws it.
 *
 * A cron line is in its backend's local time and this page's clock may be
 * in another zone. The backend says when a line next fires, so `zoneShift`
 * works out how far apart the two clocks are from that, and every time
 * worked out here is moved by it.
 */

import { nextFire, parseCron, parseWhen } from "../../src/core/cron";
import type { QuickNote } from "../../src/core/notes";
import type { TriggerRuleInfo, TriggersInfo } from "../../src/core/trigger";
import type { RangerInfo, RangerWake, SweepInfo } from "../../src/core/types";
import type { Badge } from "./badges";
import { cronWords } from "./cronwords";
import { RANGER_WORD } from "./ranger";

/** When a job fires: on a cron line in its backend's local time, once at a
 *  time (unix ms), or when a run ends. */
export type JobWhen = { kind: "cron"; line: string } | { kind: "once"; at: number } | { kind: "run"; run: string };

/** `armed` fires when its time comes; `held` is kept until what delivers it
 *  is back; `off` was turned off; `broken` cannot fire as it is written.
 *  Anything but armed says why. */
export type JobStanding = { state: "armed" } | { state: "held" | "off" | "broken"; why: string };
export type JobState = JobStanding["state"];

/** What a job is, with the record it was read from. */
export type JobSource =
  | { kind: "wake"; wake: RangerWake }
  | { kind: "fresh" }
  | { kind: "rule" | "poll"; rule: TriggerRuleInfo }
  | { kind: "sweep" }
  | { kind: "reminder"; note: QuickNote };
export type JobKind = JobSource["kind"];

export type Job = JobSource & {
  /** backend, kind and id joined: what a row is keyed and opened by */
  key: string;
  backend: string;
  /** a wake's id, a rule's name, a note's id; the kind itself for the sweep and the fresh start */
  id: string;
  title: string;
  when: JobWhen;
  standing: JobStanding;
  /** when the backend said it next fires; not every backend or kind says */
  next?: number;
  /** when it last fired, where the backend keeps that */
  last?: number;
};

/** A job's cron line, or null for one that fires once or on a run's end. */
export const lineOf = (job: Pick<Job, "when">): string | null => (job.when.kind === "cron" ? job.when.line : null);

export interface ClockInput {
  rangers: Readonly<Record<string, RangerInfo>>;
  triggers: Readonly<Record<string, TriggersInfo>>;
  /** the home backend's sweep, the only one a page reads */
  sweep: SweepInfo | null;
  notes: Readonly<Record<string, readonly QuickNote[]>>;
  home: string;
  order: readonly string[];
}

const TITLE_MAX = 64;

/** A prompt's or a note's first words, for a row: up to its first full
 *  stop, colon or bracket, without the stop a one-sentence line ends on,
 *  and no longer than a row holds. */
export function titleOf(text: string): string {
  const line = (text.trim().split("\n")[0] ?? "").trim();
  const cut = line.search(/[.:;] | \(/);
  const head = (cut >= 12 ? line.slice(0, cut) : line).replace(/[.:;]+$/, "");
  if (!head) return "No words";
  return head.length > TITLE_MAX ? `${head.slice(0, TITLE_MAX - 1).trimEnd()}…` : head;
}

/** why a backend's wakes wait, or null while they are delivered */
function wakesHeld(backend: string, r: RangerInfo): string | null {
  if (!r.on) return `The ranger is off on ${backend}, so its wakes wait until it is turned on.`;
  if (r.state !== "running") return `The ranger on ${backend} is not running (${RANGER_WORD[r.state]}), so its wakes wait.`;
  if (!r.broker) return `${backend} knows no broker, which is what delivers a wake.`;
  return null;
}

/** `HH:MM` as the line that fires then every day */
const dailyLine = (hhmm: string): string => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return `${Number(m)} ${Number(h)} * * *`;
};

const ARMED: JobStanding = { state: "armed" };

function wakeWhen(w: RangerWake): JobWhen {
  if (w.cron !== undefined) return { kind: "cron", line: w.cron };
  if (w.run !== undefined) return { kind: "run", run: w.run };
  return { kind: "once", at: w.at ?? w.next ?? w.created };
}

/** Every job the shown backends have, in the page's backend order. */
export function clockJobs(input: ClockInput): Job[] {
  const jobs: Job[] = [];
  for (const backend of input.order) {
    const ranger = input.rangers[backend];
    if (ranger) {
      const held = wakesHeld(backend, ranger);
      for (const w of ranger.wakes) {
        jobs.push({
          key: `${backend}|wake|${w.id}`,
          backend,
          kind: "wake",
          id: w.id,
          title: titleOf(w.prompt),
          when: wakeWhen(w),
          standing: held ? { state: "held", why: held } : ARMED,
          ...(w.next !== undefined ? { next: w.next } : {}),
          wake: w,
        });
      }
      const daily = ranger.settings.fresh.daily;
      if (ranger.on && daily) {
        jobs.push({ key: `${backend}|fresh|fresh`, backend, kind: "fresh", id: "fresh", title: "A fresh conversation for the ranger", when: { kind: "cron", line: dailyLine(daily) }, standing: ARMED });
      }
    }
    const triggers = input.triggers[backend];
    for (const rule of triggers?.rules ?? []) {
      const scheduled = rule.source === "schedule";
      const line = scheduled ? rule.cron : rule.poll;
      if (!line) continue;
      const next = scheduled ? rule.next : rule.nextFire;
      const kind = scheduled ? "rule" : "poll";
      jobs.push({
        key: `${backend}|${kind}|${rule.name}`,
        backend,
        kind,
        id: rule.name,
        title: rule.name,
        when: { kind: "cron", line },
        standing: rule.problem
          ? { state: "broken", why: rule.problem }
          : triggers?.keeping === false
            ? { state: "held", why: `${backend} does not hold the flows lock, so its rules start nothing.` }
            : ARMED,
        ...(next !== undefined ? { next } : {}),
        ...(rule.lastFire !== undefined ? { last: rule.lastFire } : {}),
        rule,
      });
    }
    if (backend === input.home && input.sweep) {
      const s = input.sweep;
      jobs.push({
        key: `${backend}|sweep|sweep`,
        backend,
        kind: "sweep",
        id: "sweep",
        title: "Sweep what went idle",
        when: { kind: "cron", line: s.settings.cron },
        standing: s.settings.on ? ARMED : { state: "off", why: "The sweep's schedule is off. It still runs when asked." },
        ...(s.lastRun ? { last: s.lastRun.at } : {}),
      });
    }
    for (const note of input.notes[backend] ?? []) {
      if (note.due === undefined || note.doneAt !== undefined || note.remindedAt !== undefined) continue;
      jobs.push({ key: `${backend}|reminder|${note.id}`, backend, kind: "reminder", id: note.id, title: titleOf(note.text), when: { kind: "once", at: note.due }, standing: ARMED, note });
    }
  }
  return jobs;
}

const QUARTER = 15 * 60_000;
/** every whole quarter hour two clocks can be apart, nearest first */
const SHIFTS: readonly number[] = Array.from({ length: 209 }, (_, i) => (i === 0 ? 0 : Math.ceil(i / 2) * QUARTER * (i % 2 === 1 ? 1 : -1)));

/**
 * How far a backend's clock is ahead of this page's, in ms: the nearest
 * shift under which every line's next fire, worked out here, lands on the
 * time the backend gave for it. 0 when the clocks agree, when no line pins
 * it down (a time already passed says nothing), and when nothing fits.
 */
export function zoneShift(pins: readonly { cron: string; next: number }[], now: number): number {
  const read = pins.flatMap((p) => {
    const c = parseCron(p.cron);
    return "error" in c || p.next <= now ? [] : [{ c, next: p.next }];
  });
  if (read.length === 0) return 0;
  const fits = (d: number): boolean =>
    read.every((p) => {
      const t = nextFire(p.c, now + d);
      return t !== null && t - d === p.next;
    });
  return SHIFTS.find(fits) ?? 0;
}

/** Each backend's shift, from the lines its jobs carry a next fire for. */
export function zoneShifts(jobs: readonly Job[], now: number): Record<string, number> {
  const pins = new Map<string, { cron: string; next: number }[]>();
  for (const j of jobs) {
    const cron = lineOf(j);
    if (cron === null || j.next === undefined) continue;
    pins.set(j.backend, [...(pins.get(j.backend) ?? []), { cron, next: j.next }]);
  }
  return Object.fromEntries([...pins].map(([backend, list]) => [backend, zoneShift(list, now)]));
}

/** the first minute after `after` a line fires on a clock `shift` ahead of this one */
function nextOn(cron: string, after: number, shift: number): number | null {
  const c = parseCron(cron);
  if ("error" in c) return null;
  const t = nextFire(c, after + shift);
  return t === null ? null : t - shift;
}

/**
 * When a job next fires, or null when it will not: off, broken, waiting on
 * a run, or a line with no time left. A wake's own `next` stands even once
 * passed, since it is due and waits to be delivered; a rule's is as old as
 * the page's last read of its backend, so a passed one is worked out again.
 */
export function nextOf(job: Job, now: number, shift: number): number | null {
  if (job.standing.state === "off" || job.standing.state === "broken") return null;
  switch (job.when.kind) {
    case "run":
      return null;
    case "once":
      return job.when.at;
    case "cron":
      if (job.next !== undefined && (job.kind === "wake" || job.next > now)) return job.next;
      return nextOn(job.when.line, now, shift);
  }
}

/** the most fires one lane works out: a line that fires every minute has 10,080 in a week */
const FIRES_MAX = 12_000;

/** Every time a line fires from `from` up to `to`, on a clock `shift` ahead
 *  of this one; none for a line that does not read. */
export function lineFires(line: string, from: number, to: number, shift: number): number[] {
  const c = parseCron(line);
  if ("error" in c) return [];
  const out: number[] = [];
  for (let t = nextFire(c, from - 1 + shift); t !== null && t - shift < to && out.length < FIRES_MAX; t = nextFire(c, t)) out.push(t - shift);
  return out;
}

/** Every time a job fires from `from` up to `to`. A wake's line counts from
 *  when the wake was made, since before that it was not there to fire. */
export function firesIn(job: Job, from: number, to: number, shift: number): number[] {
  switch (job.when.kind) {
    case "run":
      return [];
    case "once":
      return job.when.at >= from && job.when.at < to ? [job.when.at] : [];
    case "cron":
      return lineFires(job.when.line, job.kind === "wake" ? Math.max(from, job.wake.created) : from, to, shift);
  }
}

/** The next `n` times a line fires after `now`, on a clock `shift` ahead of this one. */
export function comingFires(line: string, now: number, shift: number, n: number): number[] {
  const c = parseCron(line);
  if ("error" in c) return [];
  const out: number[] = [];
  for (let t = nextFire(c, now + shift); t !== null && out.length < n; t = nextFire(c, t)) out.push(t - shift);
  return out;
}

export interface LaneMarks {
  /** one fire: when, and how far along the lane (0 to 1) */
  ticks: { t: number; x: number }[];
  /** fires too close to draw apart, as the stretch they cover */
  bands: { from: number; to: number; x0: number; x1: number; count: number }[];
}

/** A lane's marks: a tick for each fire, and a band over three or more
 *  that come closer together than `gap` ms, since ticks that touch say
 *  nothing a band does not. */
export function laneMarks(fires: readonly number[], from: number, to: number, gap: number): LaneMarks {
  const x = (t: number): number => (t - from) / (to - from);
  const marks: LaneMarks = { ticks: [], bands: [] };
  for (let i = 0; i < fires.length; ) {
    let j = i;
    while (j + 1 < fires.length && (fires[j + 1] ?? 0) - (fires[j] ?? 0) <= gap) j++;
    const first = fires[i] ?? 0;
    const last = fires[j] ?? 0;
    if (j - i >= 2) marks.bands.push({ from: first, to: last, x0: x(first), x1: x(last), count: j - i + 1 });
    else for (const t of fires.slice(i, j + 1)) marks.ticks.push({ t, x: x(t) });
    i = j + 1;
  }
  return marks;
}

export type ClockSpan = "day" | "week";

const HOUR = 3_600_000;

/** How much of the past and of what is coming a span shows, ms. */
export const SPAN: Record<ClockSpan, { back: number; ahead: number }> = {
  day: { back: 2 * HOUR, ahead: 24 * HOUR },
  week: { back: 12 * HOUR, ahead: 7 * 24 * HOUR },
};

/** The window a span shows around `now`, on whole minutes so a lane's marks
 *  hold still between two looks. */
export function clockWindow(now: number, span: ClockSpan): { from: number; to: number } {
  const minute = Math.floor(now / 60_000) * 60_000;
  return { from: minute - SPAN[span].back, to: minute + SPAN[span].ahead };
}

const two = (n: number): string => String(n).padStart(2, "0");
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `14:05` on this page's clock */
export const hhmm = (t: number): string => {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};

const dayWord = (d: Date): string => `${WEEKDAY[d.getDay()] ?? ""} ${d.getDate()}`;

export interface AxisTick {
  x: number;
  label: string;
  /** midnight: the label is the day that starts there */
  day: boolean;
}

/** The axis's labels on this page's clock: every third hour over a day and
 *  each midnight over a week. `sparse`, for a narrow lane, names every
 *  sixth hour, and a week's days without their dates. */
export function axisTicks(from: number, to: number, span: ClockSpan, sparse = false): AxisTick[] {
  const out: AxisTick[] = [];
  const every = span === "week" ? 24 : sparse ? 6 : 3;
  const start = new Date(from);
  start.setMinutes(0, 0, 0);
  for (let t = start.getTime(); t < to; t += HOUR) {
    if (t < from) continue;
    const d = new Date(t);
    const h = d.getHours();
    if (d.getMinutes() !== 0 || h % every !== 0) continue;
    const day = span === "week" && sparse ? (WEEKDAY[d.getDay()] ?? "") : dayWord(d);
    out.push({ x: (t - from) / (to - from), label: h === 0 ? day : `${two(h)}:00`, day: h === 0 });
  }
  return out;
}

/** the hours drawn as night, on this page's clock */
export const NIGHT = { from: 22, to: 6 } as const;

/** The nights inside a window, each as the stretch of the lane it covers. */
export function nights(from: number, to: number): { x0: number; x1: number }[] {
  const out: { x0: number; x1: number }[] = [];
  const first = new Date(from);
  for (let day = new Date(first.getFullYear(), first.getMonth(), first.getDate() - 1); day.getTime() < to; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const dusk = new Date(day.getFullYear(), day.getMonth(), day.getDate(), NIGHT.from).getTime();
    const dawn = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, NIGHT.to).getTime();
    const a = Math.max(dusk, from);
    const b = Math.min(dawn, to);
    if (b > a) out.push({ x0: (a - from) / (to - from), x1: (b - from) / (to - from) });
  }
  return out;
}

/** How long until a time: "due now", "in 42 min", "in 2 h 14 min", "in 3 days". */
export function untilWords(ms: number): string {
  if (ms <= 0) return "due now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `in ${hours} h` : `in ${hours} h ${minutes % 60} min`;
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} days`;
}

/** The day a time falls on, against today: null for today, "tomorrow",
 *  "yesterday", "Mon" inside a week, else "17 Nov". The last two are named
 *  days, which a sentence leads with "on". */
function dayWords(t: number, now: number): { word: string; named: boolean } | null {
  const d = new Date(t);
  const today = new Date(now);
  const midnight = (add: number): number => new Date(today.getFullYear(), today.getMonth(), today.getDate() + add).getTime();
  if (t >= midnight(0) && t < midnight(1)) return null;
  if (t >= midnight(1) && t < midnight(2)) return { word: "tomorrow", named: false };
  if (t >= midnight(-1) && t < midnight(0)) return { word: "yesterday", named: false };
  if (t >= midnight(2) && t < midnight(7)) return { word: WEEKDAY[d.getDay()] ?? "", named: true };
  return { word: `${d.getDate()} ${MONTH[d.getMonth()] ?? ""}`, named: true };
}

/** A time as a row says it, against today: "14:32", "tomorrow 09:00",
 *  "yesterday 04:00", "Mon 09:00" inside a week, else "17 Nov 09:00". */
export function clockWords(t: number, now: number): string {
  const day = dayWords(t, now);
  return day ? `${day.word} ${hhmm(t)}` : hhmm(t);
}

/** The same time inside a sentence: "at 14:32", "tomorrow at 09:00",
 *  "on Mon at 05:00", "on 17 Nov at 09:00". */
export function atWords(t: number, now: number): string {
  const day = dayWords(t, now);
  if (!day) return `at ${hhmm(t)}`;
  return `${day.named ? "on " : ""}${day.word} at ${hhmm(t)}`;
}

/** A time in full, for a mark's tooltip: "Wed 11 Nov, 09:00". */
export const fullTime = (t: number): string => {
  const d = new Date(t);
  return `${WEEKDAY[d.getDay()] ?? ""} ${d.getDate()} ${MONTH[d.getMonth()] ?? ""}, ${hhmm(t)}`;
};

/** When a job fires, in words: its line as a sentence, or that it fires once. */
export function whenWords(job: Pick<Job, "when">): string {
  switch (job.when.kind) {
    case "run":
      return `When run ${job.when.run} ends`;
    case "cron":
      return cronWords(job.when.line) ?? job.when.line;
    case "once":
      return "Once";
  }
}

/** What kind of thing a job is and whose, for the end of its row. */
export function kindWords(job: Job): string {
  switch (job.kind) {
    case "wake":
      return job.wake.by === "eric" ? "your wake" : job.wake.by === "run" ? "a run's wake" : "the ranger's own wake";
    case "fresh":
      return "ranger";
    case "rule":
      return "schedule rule";
    case "poll":
      return "issue poll";
    case "sweep":
      return "sweep";
    case "reminder":
      return "reminder";
  }
}

export interface ClockRow {
  job: Job;
  /** when it next fires, or null when it will not */
  next: number | null;
  /** how far its backend's clock is ahead of this page's */
  shift: number;
}

/** The jobs as rows, soonest first; the ones with no time coming keep the
 *  order they came in, after the rest. */
export function clockRows(jobs: readonly Job[], now: number): ClockRow[] {
  const shifts = zoneShifts(jobs, now);
  const rows = jobs.map((job): ClockRow => {
    const shift = shifts[job.backend] ?? 0;
    return { job, next: nextOf(job, now, shift), shift };
  });
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (a.row.next ?? Infinity) - (b.row.next ?? Infinity) || a.i - b.i)
    .map(({ row }) => row);
}

/** The row the page leads with: the soonest that will be delivered. A poll
 *  only looks for issues, and one that runs every few minutes would always
 *  be next, so a poll leads only where nothing else is due. */
export function nextUp(rows: readonly ClockRow[]): ClockRow | null {
  const due = rows.filter((r) => r.next !== null && r.job.standing.state === "armed");
  return due.find((r) => r.job.kind !== "poll") ?? due[0] ?? null;
}

/** A one-time wake as typed ("in 30m", "14:00", an ISO time), read on the
 *  backend's clock: when it would fire, or why it cannot be read. */
export function readWhen(text: string, now: number, shift: number): number | { error: string } {
  const got = parseWhen(text, now + shift);
  return typeof got === "number" ? got - shift : got;
}

/** The view's count: the rules that cannot fire as they are written. */
export function clockBadge(triggers: Readonly<Record<string, Pick<TriggersInfo, "rules">>>): Badge | null {
  const broken = Object.values(triggers).flatMap((t) => t.rules.filter((r) => r.problem && (r.source === "schedule" || r.poll)));
  if (broken.length === 0) return null;
  return { text: String(broken.length), tone: "rust", title: broken.map((r) => `${r.name}: ${r.problem ?? ""}`).join("\n") };
}

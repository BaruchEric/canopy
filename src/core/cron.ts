/**
 * Cron lines and one-shot times for the ranger's wakes, in the backend's
 * local time. Browser-safe and pure. A cron line has the five usual fields
 * (minute, hour, day of month, month, day of week) with `*`, lists, ranges
 * and steps, plus `@hourly`, `@daily`, `@weekly` and `@monthly`. As in
 * Vixie cron, when both day fields are restricted (neither starts with `*`)
 * a day matching either one counts.
 */

export interface Cron {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 is Sunday; a 7 in the line is read as 0 */
  weekdays: ReadonlySet<number>;
  /** whether each day field was `*`, for the either-day rule */
  anyDay: boolean;
  anyWeekday: boolean;
}

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

const FIELDS = [
  { name: "minute", lo: 0, hi: 59 },
  { name: "hour", lo: 0, hi: 23 },
  { name: "day of month", lo: 1, hi: 31 },
  { name: "month", lo: 1, hi: 12 },
  { name: "day of week", lo: 0, hi: 7 },
] as const;

const NUM = /^\d{1,2}$/;

/** One field as the set of values it allows, or why it cannot be read. */
function field(text: string, lo: number, hi: number, name: string): Set<number> | string {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    let step = 1;
    if (stepText !== undefined) {
      if (!NUM.test(stepText) || Number(stepText) < 1) return `the ${name} step "${stepText}" is not a positive number`;
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = lo;
      to = hi;
    } else {
      const [a = "", b] = range.split("-");
      if (!NUM.test(a) || (b !== undefined && !NUM.test(b))) return `the ${name} "${part}" is not a number, a range or *`;
      from = Number(a);
      to = b === undefined ? (stepText === undefined ? from : hi) : Number(b);
    }
    if (from < lo || to > hi || from > to) return `the ${name} "${part}" is outside ${lo}-${hi}`;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** A cron line read into its sets, or why it cannot be read. */
export function parseCron(line: string): Cron | { error: string } {
  const text = MACROS[line.trim().toLowerCase()] ?? line.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) return { error: "a cron line has five fields: minute hour day-of-month month day-of-week" };
  const sets: Set<number>[] = [];
  for (const [i, f] of FIELDS.entries()) {
    const got = field(parts[i] ?? "", f.lo, f.hi, f.name);
    if (typeof got === "string") return { error: got };
    sets.push(got);
  }
  const [minutes, hours, days, months, rawWeekdays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  const weekdays = new Set([...rawWeekdays].map((d) => d % 7));
  // as Vixie cron: a day field starting with * (a step over the whole range
  // included) counts as unrestricted for the either-day rule
  return { minutes, hours, days, months, weekdays, anyDay: (parts[2] ?? "").startsWith("*"), anyWeekday: (parts[4] ?? "").startsWith("*") };
}

/** the longest cron line taken */
export const CRON_MAX = 100;

/** Whether a cron line reads. */
export const isCron = (line: unknown): line is string => typeof line === "string" && line.length <= CRON_MAX && !("error" in parseCron(line));

/** Vixie cron's rule: with either day field starred both must match (a
 *  plain * matches every day, so only the other field counts), and with
 *  both restricted either one does. */
function dayMatches(c: Cron, d: Date): boolean {
  const day = c.days.has(d.getDate());
  const weekday = c.weekdays.has(d.getDay());
  return c.anyDay || c.anyWeekday ? day && weekday : day || weekday;
}

/** how far ahead `nextFire` looks before saying never (Feb 29 on a Monday is rare) */
const HORIZON_YEARS = 8;

/**
 * The first minute strictly after `after` (unix ms) that the line allows,
 * in local time, or null when none comes within the horizon. Walks month,
 * day, hour and minute, skipping whole units that cannot match.
 */
export function nextFire(c: Cron, after: number): number | null {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = new Date(after);
  end.setFullYear(end.getFullYear() + HORIZON_YEARS);
  while (d.getTime() <= end.getTime()) {
    if (!c.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return null;
}

const IN = /^in\s+(\d{1,4})\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i;
const CLOCK = /^(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)$/i;

/**
 * A one-shot time as typed: `in 30m`, `in 2h`, `in 1d`, `14:00` or
 * `at 14:00` (the next time the clock shows it, today or tomorrow), or an
 * ISO date and time. Unix ms, or why it cannot be read. A time that is not
 * in the future is refused.
 */
export function parseWhen(text: string, now: number): number | { error: string } {
  const t = text.trim();
  const rel = IN.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const unit = (rel[2] ?? "m").toLowerCase()[0];
    const ms = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
    if (n < 1) return { error: "a wake is at least a minute away" };
    return now + n * ms;
  }
  const clock = CLOCK.exec(t);
  if (clock) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) {
    const at = new Date(t.replace(" ", "T")).getTime();
    if (!Number.isFinite(at)) return { error: `"${t}" is not a date and time` };
    if (at <= now) return { error: `${t} has already passed` };
    return at;
  }
  return { error: `"${t}" is not a time: try "in 30m", "14:00" or an ISO date and time` };
}

/** `HH:MM` on the 24-hour clock */
export const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The latest time at or before `now` that the clock read `hhmm` (local),
 * today's if it has passed, else yesterday's. What a daily fresh start
 * compares the conversation's start against.
 */
export function lastClock(hhmm: string, now: number): number | null {
  const m = CLOCK_RE.exec(hhmm);
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/**
 * A cron line in words, its five fields named, and a field stepped from the
 * keyboard: what the clock view's rows and its line editor say. Pure. The
 * line is read with core/cron.ts, so the words cannot disagree with when it
 * fires. Times are on the 24-hour clock, as the line's own are.
 */
import { expandCron, parseCron, type Cron } from "../../src/core/cron";

const two = (n: number): string => String(n).padStart(2, "0");
const clock = (h: number, m: number): string => `${two(h)}:${two(m)}`;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** "a", "a and b", "a, b and c" */
function list(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1] ?? ""}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

const sorted = (set: ReadonlySet<number>): number[] => [...set].sort((a, b) => a - b);
const full = (set: ReadonlySet<number>, lo: number, hi: number): boolean => set.size === hi - lo + 1;

/** the step when the set is lo, lo+n, lo+2n and so on to the field's end */
function stepOf(set: ReadonlySet<number>, lo: number, hi: number): number | null {
  const v = sorted(set);
  const second = v[1];
  if (v[0] !== lo || second === undefined) return null;
  const n = second - lo;
  if (n < 2) return null;
  for (const [i, value] of v.entries()) if (value !== lo + i * n) return null;
  return lo + v.length * n > hi ? n : null;
}

/** the ends when the set is one unbroken run of three or more */
function runOf(set: ReadonlySet<number>): [number, number] | null {
  const v = sorted(set);
  const a = v[0];
  const b = v[v.length - 1];
  if (a === undefined || b === undefined || v.length < 3 || b - a !== v.length - 1) return null;
  return [a, b];
}

/** a set as a cron field would write it: 0, 15-20, 40 */
function compact(set: ReadonlySet<number>): string {
  const v = sorted(set);
  const parts: string[] = [];
  for (let i = 0; i < v.length; ) {
    let j = i;
    while (v[j + 1] === (v[j] ?? 0) + 1) j++;
    parts.push(j - i >= 2 ? `${v[i] ?? ""}-${v[j] ?? ""}` : v.slice(i, j + 1).join(", "));
    i = j + 1;
  }
  return parts.join(", ");
}

/** the hours a rate keeps to, when it is not every hour */
function hoursSpan(hours: ReadonlySet<number>): string {
  const v = sorted(hours);
  const run = runOf(hours);
  const only = v.length === 1 ? v[0] : undefined;
  if (only !== undefined) return `from ${clock(only, 0)} to ${clock(only, 59)}`;
  if (run) return `from ${clock(run[0], 0)} to ${clock(run[1], 59)}`;
  return `in the hours ${compact(hours)}`;
}

/** `at` says the words are clock times, which a day leads ("Mondays at
 *  09:00"); otherwise they are a rate, which a day follows. */
function timeWords(c: Cron): { text: string; at: boolean } {
  const everyHour = full(c.hours, 0, 23);
  const minuteStep = stepOf(c.minutes, 0, 59);
  const rate = full(c.minutes, 0, 59) ? "every minute" : minuteStep !== null ? `every ${minuteStep} minutes` : null;
  if (rate) return { text: everyHour ? rate : `${rate} ${hoursSpan(c.hours)}`, at: false };
  const minutes = sorted(c.minutes);
  const hours = sorted(c.hours);
  if (everyHour && minutes.length <= 4) return { text: `every hour at ${list(minutes.map((m) => `:${two(m)}`))}`, at: false };
  const minute = minutes.length === 1 ? minutes[0] : undefined;
  const hourStep = stepOf(c.hours, 0, 23);
  if (minute !== undefined && hourStep !== null) return { text: minute === 0 ? `every ${hourStep} hours` : `every ${hourStep} hours at :${two(minute)}`, at: false };
  const times = hours.flatMap((h) => minutes.map((m) => clock(h, m)));
  if (times.length <= 3) return { text: list(times), at: true };
  const run = runOf(c.hours);
  if (minute !== undefined && run) return { text: `every hour from ${clock(run[0], minute)} to ${clock(run[1], minute)}`, at: false };
  if (times.length <= 6) return { text: list(times), at: true };
  return { text: `at minute ${compact(c.minutes)} ${everyHour ? "of every hour" : `of hour ${compact(c.hours)}`}`, at: false };
}

function domWords(days: ReadonlySet<number>): string {
  const step = stepOf(days, 1, 31);
  if (step !== null) return `every ${ordinal(step)} day`;
  const run = runOf(days);
  if (run) return `the ${ordinal(run[0])} to the ${ordinal(run[1])}`;
  const v = sorted(days);
  return v.length <= 4 ? `the ${list(v.map(ordinal))}` : `days ${compact(days)}`;
}

function dowWords(weekdays: ReadonlySet<number>): string {
  const v = sorted(weekdays);
  const key = v.join("");
  if (key === "12345") return "weekdays";
  if (key === "06") return "weekends";
  const run = runOf(weekdays);
  if (run) return `${DAYS[run[0]] ?? ""} to ${DAYS[run[1]] ?? ""}`;
  return list(v.map((d) => DAYS[d] ?? ""));
}

function monthWords(months: ReadonlySet<number>): string {
  const run = runOf(months);
  if (run) return `${MONTHS[run[0] - 1] ?? ""} to ${MONTHS[run[1] - 1] ?? ""}`;
  return list(sorted(months).map((m) => MONTHS[m - 1] ?? ""));
}

/** The days a line keeps to, to lead a sentence and to follow a rate; null
 *  for every day. As core/cron.ts reads them: with neither day field
 *  starred a day matching either one counts, so one of them covering every
 *  day leaves no day out. */
function dayWords(c: Cron): { lead: string; tail: string } | null {
  const either = !c.anyDay && !c.anyWeekday;
  const everyDate = full(c.days, 1, 31);
  const everyWeekday = c.weekdays.size === 7;
  const anyDay = either && (everyDate || everyWeekday);
  const dom = anyDay || everyDate ? null : domWords(c.days);
  const dow = anyDay || everyWeekday ? null : dowWords(c.weekdays);
  const mon = full(c.months, 1, 12) ? null : monthWords(c.months);
  const inMonth = mon ? ` in ${mon}` : "";
  if (!dom && !dow) return mon ? { lead: `Every day in ${mon}`, tail: `in ${mon}` } : null;
  if (!dom && dow) return { lead: `${cap(dow)}${inMonth}`, tail: `on ${dow}${inMonth}` };
  const ofMonth = `${dom ?? ""} of ${mon ?? "the month"}`;
  if (!dow) return { lead: cap(ofMonth), tail: `on ${ofMonth}` };
  const both = either ? `${ofMonth} and ${dow}` : `${dow} that fall on ${ofMonth}`;
  return { lead: cap(both), tail: `on ${both}` };
}

/** A cron line as a sentence: "Every day at 09:00", "Every 15 minutes on
 *  weekdays", "The 1st of the month at 03:00". Null for a line that does
 *  not read. */
export function cronWords(line: string): string | null {
  const c = parseCron(line);
  if ("error" in c) return null;
  const time = timeWords(c);
  const day = dayWords(c);
  if (time.at) return `${day ? day.lead : "Every day"} at ${time.text}`;
  return cap(day ? `${time.text} ${day.tail}` : time.text);
}

/** The five fields in the line's order, with the values each takes. */
export const CRON_FIELDS = [
  { name: "minute", lo: 0, hi: 59 },
  { name: "hour", lo: 0, hi: 23 },
  { name: "day", lo: 1, hi: 31 },
  { name: "month", lo: 1, hi: 12 },
  { name: "weekday", lo: 0, hi: 6 },
] as const;

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokens(line: string): Token[] {
  return [...line.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

/** What the line has in each of the five fields, an `@` word written out;
 *  an empty string for a field not typed yet. */
export function cronLegend(line: string): { name: string; token: string }[] {
  const t = tokens(expandCron(line));
  return CRON_FIELDS.map((f, i) => ({ name: f.name, token: t[i]?.text ?? "" }));
}

/** Which of the five fields the caret is in or just after, or null where
 *  there is none: an `@` word, a sixth word, an empty line. */
export function fieldAt(line: string, caret: number): number | null {
  if (line.trim().startsWith("@")) return null;
  const t = tokens(line);
  const at = t.findIndex((tok) => caret <= tok.end);
  const i = at === -1 ? t.length - 1 : at;
  return i >= 0 && i < CRON_FIELDS.length ? i : null;
}

/** Where a field sits in the line, for selecting it; null when the line has no such field. */
export function fieldSpan(line: string, field: number): { start: number; end: number } | null {
  if (line.trim().startsWith("@")) return null;
  const tok = tokens(line)[field];
  return tok ? { start: tok.start, end: tok.end } : null;
}

/**
 * The line with the number under the caret one higher or lower, wrapping
 * inside its field's values (a step after `/` starts at 1), and where the
 * caret goes so the next press steps the same number. A `*` becomes the
 * field's first value on the way up and its last on the way down. Null when
 * the caret is on nothing that steps.
 */
export function bumpField(line: string, caret: number, delta: 1 | -1): { line: string; caret: number } | null {
  const f = fieldAt(line, caret);
  if (f === null) return null;
  const tok = tokens(line)[f];
  const field = CRON_FIELDS[f];
  if (!tok || !field) return null;
  const put = (start: number, end: number, value: number) => ({ line: `${line.slice(0, start)}${value}${line.slice(end)}`, caret: start + String(value).length });
  if (tok.text === "*") return put(tok.start, tok.end, delta > 0 ? field.lo : field.hi);
  const numbers = [...tok.text.matchAll(/\d+/g)].map((m) => {
    const start = tok.start + (m.index ?? 0);
    return { start, end: start + m[0].length, value: Number(m[0]), step: tok.text[(m.index ?? 0) - 1] === "/" };
  });
  // a field of one number takes the press from anywhere in it
  const hit = numbers.find((n) => caret >= n.start && caret <= n.end) ?? (numbers.length === 1 ? numbers[0] : undefined);
  if (!hit) return null;
  const lo = hit.step ? 1 : field.lo;
  const size = field.hi - lo + 1;
  return put(hit.start, hit.end, lo + ((((hit.value - lo + delta) % size) + size) % size));
}

/** Lines worth one click, in the words the row would say for them. */
export const CRON_PRESETS: readonly { label: string; line: string }[] = [
  { label: "every 15 minutes", line: "*/15 * * * *" },
  { label: "every hour", line: "0 * * * *" },
  { label: "every day at 09:00", line: "0 9 * * *" },
  { label: "weekdays at 09:00", line: "0 9 * * 1-5" },
  { label: "Mondays at 09:00", line: "0 9 * * 1" },
  { label: "the 1st of the month", line: "0 9 1 * *" },
];

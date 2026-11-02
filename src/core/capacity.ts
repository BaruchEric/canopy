/**
 * Capacity readings for a backend's agent harness. Endpoint readings come
 * from the harness usage endpoint; observed readings estimate Claude's
 * five-hour spend from the cost ledger; unknown means there is no reading.
 * This module is pure and browser-safe. The response fixtures are synthetic;
 * the limit text follows the CLI's wording as the probes record observed it.
 */

import type { CostEntry } from "./costs";
import type { Harness, Priority } from "./types";

export const READ_EVERY = 5 * 60_000;
export const READ_IDLE = 30 * 60_000;
export const HIT_HOLD = 60 * 60_000;
export const HIT_GRACE = 2 * 60_000;
export const FIVE_HOURS = 5 * 60 * 60_000;
export const LOW_HOLD = 0.7;
export const NORMAL_HOLD = 0.9;
export const WEEKLY_LOW_HOLD = 0.85;

export interface Window {
  /** the share spent, 0 to 1; the observed estimate may pass 1 */
  used: number;
  /** when the window resets; null for the observed estimate, which rolls */
  resetsAt: number | null;
  readAt: number;
}

export type CapacityWindow = "fiveHour" | "weekly";
export type CapacitySource = "endpoint" | "observed" | "unknown";

export interface CapacityHit {
  window: CapacityWindow;
  at: number;
  /** the text's reset time in the backend's clock, else `at` + HIT_HOLD */
  resetsAt: number;
  text: string;
}

export interface Capacity {
  harness: Harness;
  fiveHour: Window | null;
  weekly: Window | null;
  /** endpoint: read from the usage endpoint; observed: inferred from a
   *  limit hit and the ledger; unknown: never read */
  source: CapacitySource;
  /** a limit hit the harness reported, until its reset passes */
  hit: CapacityHit | null;
}

export interface CapacitySettings {
  lowHold: number;
  normalHold: number;
  weeklyLowHold: number;
  /** what one 5-hour window is worth in Claude dollars, for the observed
   *  estimate; null leaves `used` unknown */
  observedFiveHourUsd: number | null;
}

export const DEFAULT_CAPACITY: CapacitySettings = {
  lowHold: LOW_HOLD,
  normalHold: NORMAL_HOLD,
  weeklyLowHold: WEEKLY_LOW_HOLD,
  observedFiveHourUsd: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const holdSetting = (value: unknown, fallback: number): number =>
  isFiniteNumber(value) && value > 0 && value <= 1 ? value : fallback;

/** Each hold must be above 0 and at most 1; the dollar figure must be
 *  finite and above 0. Invalid or missing values use the safe defaults. */
export function normalizeCapacity(value: unknown): CapacitySettings {
  if (!isRecord(value)) return { ...DEFAULT_CAPACITY };
  const observed = value["observedFiveHourUsd"];
  return {
    lowHold: holdSetting(value["lowHold"], LOW_HOLD),
    normalHold: holdSetting(value["normalHold"], NORMAL_HOLD),
    weeklyLowHold: holdSetting(value["weeklyLowHold"], WEEKLY_LOW_HOLD),
    observedFiveHourUsd: isFiniteNumber(observed) && observed > 0 ? observed : null,
  };
}

export const emptyCapacity = (harness: Harness): Capacity => ({
  harness,
  fiveHour: null,
  weekly: null,
  source: "unknown",
  hit: null,
});

const resetTimestamp = (value: unknown): number | null => {
  if (isFiniteNumber(value)) {
    const ms = value * 1000;
    return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : null;
  }
  if (typeof value !== "string") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|([+-])(\d{2}):?(\d{2}))?)?$/i.exec(value);
  if (!iso) return null;
  const year = Number(iso[1]);
  const month = Number(iso[2]);
  const day = Number(iso[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (iso[4] !== undefined && (Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6] ?? "0") > 59)) return null;
  if (iso[9] !== undefined && (Number(iso[9]) > 23 || Number(iso[10]) > 59)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const readWindow = (value: unknown, now: number): Window | null => {
  if (!isRecord(value)) return null;
  const utilization = value["utilization"];
  if (!isFiniteNumber(utilization) || utilization < 0) return null;
  const used = utilization > 1 ? utilization / 100 : utilization;
  return { used, resetsAt: resetTimestamp(value["resets_at"]), readAt: now };
};

/** Parse the harness usage endpoint's two-window response. */
export function readUsage(json: unknown, now: number): { fiveHour: Window | null; weekly: Window | null } {
  if (!isRecord(json)) return { fiveHour: null, weekly: null };
  return {
    fiveHour: readWindow(json["five_hour"], now),
    weekly: readWindow(json["seven_day"], now),
  };
}

/** Whether a harness's words are the plan's usage limit. One word, hyphens
 *  allowed, may name the window: "session", "5-hour", "weekly", "Opus". */
export function isLimitText(text: string): boolean {
  return /\bhit your (?:[\w-]+ )?limit\b/i.test(text) || /\busage limit\b/i.test(text);
}

const WEEKDAY: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MONTH: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** How far a named zone's wall clock is ahead of UTC at an instant, or null
 *  when the runtime does not know the zone. */
const zoneOffset = (zone: string, at: number): number | null => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(at));
    const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
    const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    return Number.isFinite(wall) ? wall - Math.floor(at / 1000) * 1000 : null;
  } catch {
    return null;
  }
};

/** The instant a wall-clock time names, in a zone or (null) the backend's
 *  own clock. Days past the month's end roll over, as Date does. */
const fromWall = (zone: string | null, year: number, month: number, day: number, hour: number, minute: number): number => {
  if (zone === null) return new Date(year, month, day, hour, minute).getTime();
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = zoneOffset(zone, guess) ?? 0;
  return guess - (zoneOffset(zone, guess - first) ?? first);
};

/** Today's date in a zone or (null) the backend's own clock. */
const wallDay = (zone: string | null, at: number): { year: number; month: number; day: number; weekday: number } => {
  const local = zone === null;
  const d = new Date(local ? at : at + (zoneOffset(zone, at) ?? 0));
  return local
    ? { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), weekday: d.getDay() }
    : { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), weekday: d.getUTCDay() };
};

/** Claude Code prints the reset as "1:40pm (UTC)" within a day and as
 *  "Oct 29, 3pm (UTC)" past one, adding the year when it differs; older text
 *  and the design used "Thu 3pm" and no zone. The zone in brackets is the
 *  CLI's own, so it is honored when the runtime knows it. */
const RESET_WORDS =
  /\bresets (?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w* |(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* (\d{1,2}),? (?:(\d{4}),? )?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([\w+\-/]+)\))?/i;

const resetFromWords = (text: string, now: number): number | null => {
  const match = RESET_WORDS.exec(text);
  if (!match) return null;
  const [, weekdayWord, monthWord, dateWord, yearWord, hourWord, minuteWord, meridiem, zoneWord] = match;
  const hour12 = Number(hourWord);
  const minute = Number(minuteWord ?? "0");
  if (hour12 < 1 || hour12 > 12 || minute > 59 || meridiem === undefined) return null;
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  const zone = zoneWord !== undefined && zoneOffset(zoneWord, now) !== null ? zoneWord : null;
  const today = wallDay(zone, now);
  if (monthWord !== undefined) {
    const month = MONTH[monthWord.slice(0, 3).toLowerCase()];
    const date = Number(dateWord);
    if (month === undefined || date < 1 || date > 31) return null;
    return fromWall(zone, yearWord === undefined ? today.year : Number(yearWord), month, date, hour, minute);
  }
  let dayDelta = 0;
  if (weekdayWord !== undefined) {
    const targetDay = WEEKDAY[weekdayWord.slice(0, 3).toLowerCase()];
    if (targetDay === undefined) return null;
    dayDelta = (targetDay - today.weekday + 7) % 7;
  }
  const at = fromWall(zone, today.year, today.month, today.day + dayDelta, hour, minute);
  if (at > now) return at;
  return fromWall(zone, today.year, today.month, today.day + dayDelta + (weekdayWord === undefined ? 1 : 7), hour, minute);
};

/** Parse a recognized limit message into the hit and its reset time. */
export function limitHit(text: string, now: number): CapacityHit | null {
  if (!isLimitText(text)) return null;
  const trimmed = text.trim();
  const legacy = /\|(\d+)$/.exec(trimmed);
  const legacyMs = legacy === null ? null : Number(legacy[1]) * 1000;
  const resetsAt = legacyMs !== null && Number.isFinite(legacyMs) && Number.isFinite(new Date(legacyMs).getTime())
    ? legacyMs
    : resetFromWords(trimmed, now) ?? now + HIT_HOLD;
  return {
    window: /\bweek(?:ly)?\b/i.test(trimmed) ? "weekly" : "fiveHour",
    at: now,
    resetsAt,
    text: trimmed,
  };
}

export const hitStands = (hit: CapacityHit | null, now: number): boolean =>
  hit !== null && now < hit.resetsAt + HIT_GRACE;

/** Estimate Claude's five-hour spend from ledger dollars when no endpoint
 *  reading is available. A missing dollar figure leaves the reading unknown. */
export function observe(
  capacity: Capacity,
  rows: readonly CostEntry[],
  settings: Pick<CapacitySettings, "observedFiveHourUsd">,
  now: number,
): Capacity {
  if (capacity.harness !== "claude" || capacity.source === "endpoint") return capacity;
  const figure = settings.observedFiveHourUsd;
  if (figure === null || !Number.isFinite(figure) || figure <= 0) {
    return {
      ...capacity,
      fiveHour: null,
      source: hitStands(capacity.hit, now) ? "observed" : "unknown",
    };
  }
  const spent = rows.reduce((sum, row) =>
    row.service === "claude" && row.at > now - FIVE_HOURS && row.at <= now
      ? sum + (row.usd ?? 0)
      : sum, 0);
  return {
    ...capacity,
    fiveHour: { used: spent / figure, resetsAt: null, readAt: now },
    source: "observed",
  };
}

/** Whether a window has passed the time at which it must be read again. */
export const stale = (window: Window | null, now: number): boolean =>
  window === null || now - window.readAt > READ_EVERY;

/** Format a reset as its local time today, or its weekday otherwise. */
export function resetWord(ms: number, now: number): string {
  const reset = new Date(ms);
  const current = new Date(now);
  if (
    reset.getFullYear() === current.getFullYear()
    && reset.getMonth() === current.getMonth()
    && reset.getDate() === current.getDate()
  ) {
    return reset.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return reset.toLocaleDateString("en-US", { weekday: "short" });
}

export type Decision = "go" | { hold: "window" | "hit"; until: number | null; why: string };

const windowHold = (windowName: "5-hour" | "weekly", window: Window, now: number): Decision => {
  const percent = Math.round(window.used * 100);
  const reset = window.resetsAt === null ? "" : ` (resets ${resetWord(window.resetsAt, now)})`;
  return {
    hold: "window",
    until: window.resetsAt,
    why: `the ${windowName} window is at ${percent}%${reset}`,
  };
};

/** Decide whether the priority can start from the current reading. */
export function decide(capacity: Capacity, priority: Priority, settings: CapacitySettings, now: number): Decision {
  if (priority === "interactive") return "go";
  if (capacity.source === "unknown") return "go";
  const hit = capacity.hit;
  if (hitStands(hit, now) && hit !== null) {
    const windowName = hit.window === "fiveHour" ? "5-hour" : "weekly";
    return {
      hold: "hit",
      until: hit.resetsAt + HIT_GRACE,
      why: `the ${windowName} window is spent (resets ${resetWord(hit.resetsAt, now)})`,
    };
  }
  const fiveHour = capacity.source === "endpoint" && stale(capacity.fiveHour, now) ? null : capacity.fiveHour;
  const weekly = capacity.source === "endpoint" && stale(capacity.weekly, now) ? null : capacity.weekly;
  if (priority === "normal") {
    return fiveHour !== null && fiveHour.used >= settings.normalHold
      ? windowHold("5-hour", fiveHour, now)
      : "go";
  }
  if (fiveHour !== null && fiveHour.used >= settings.lowHold) {
    return windowHold("5-hour", fiveHour, now);
  }
  if (weekly !== null && weekly.used >= settings.weeklyLowHold) {
    return windowHold("weekly", weekly, now);
  }
  return "go";
}

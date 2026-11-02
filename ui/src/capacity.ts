import {
  decide,
  hitStands,
  type Capacity,
  type CapacitySettings,
  type CapacityWindow,
  type Window,
} from "../../src/core/capacity";
import type { CapacityInfo, HeldStart } from "../../src/core/types";

export const CAPACITY_GLYPH = "◔";

/** Time left on the same local day, else the weekday. */
export function windowWord(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "";
  const remaining = resetsAt - now;
  if (remaining <= 0) return "now";
  const reset = new Date(resetsAt);
  const current = new Date(now);
  if (
    reset.getFullYear() === current.getFullYear()
    && reset.getMonth() === current.getMonth()
    && reset.getDate() === current.getDate()
  ) {
    const minutes = Math.ceil(remaining / 60_000);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
  }
  return reset.toLocaleDateString("en-US", { weekday: "short" });
}

/** A single usage window at a glance. */
export function capacityLine(window: Window | null, kind: CapacityWindow, now: number): string {
  const name = kind === "fiveHour" ? "5h" : "week";
  if (window === null) return `${name} no reading`;
  const share = `${name} ${Math.round(window.used * 100)}%`;
  const reset = windowWord(window.resetsAt, now);
  return reset ? `${share} · ${reset}` : share;
}

/** How long ago the reading arrived. */
export function ageWord(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / (60 * 60_000))}h ago`;
}

/** The most urgent state among the windows a priority would use. */
export function capacityTone(cap: Capacity, settings: CapacitySettings, now: number): "moss" | "lichen" | "rust" {
  if (hitStands(cap.hit, now) || decide(cap, "normal", settings, now) !== "go") return "rust";
  if (decide(cap, "low", settings, now) !== "go") return "lichen";
  return "moss";
}

export interface CapacityRow {
  backend: string;
  cap: Capacity;
  tone: "moss" | "lichen" | "rust";
  /** The two lines, or none for `unknown` with no hit. */
  lines: string[];
  /** "endpoint, read 3m ago", "observed from the ledger", or "no reading". */
  source: string;
}

/** Every backend that answered, in the given order, one row per harness. */
export function capacityRows(info: Readonly<Record<string, CapacityInfo>>, order: readonly string[], now: number): CapacityRow[] {
  const rows: CapacityRow[] = [];
  for (const backend of order) {
    const answer = info[backend];
    if (answer === undefined) continue;
    for (const original of answer.capacity) {
      const cap = hitStands(original.hit, now) || original.hit === null ? original : { ...original, hit: null };
      const tone = capacityTone(original, answer.settings, now);
      const lines = [
        ...(original.fiveHour === null ? [] : [capacityLine(original.fiveHour, "fiveHour", now)]),
        ...(original.weekly === null ? [] : [capacityLine(original.weekly, "weekly", now)]),
      ];
      const reads = [original.fiveHour, original.weekly].filter((window) => window !== null);
      const newestRead = reads.reduce<number | null>((newest, window) =>
        newest === null || (window !== null && window.readAt > newest) ? window.readAt : newest, null);
      const source = original.source === "endpoint"
        ? newestRead === null ? "endpoint, no reading" : `endpoint, read ${ageWord(now - newestRead)}`
        : original.source === "observed" ? "observed from the ledger" : "no reading";
      rows.push({ backend, cap, tone, lines, source });
    }
  }
  return rows;
}

/** The chip's word: a standing hit, else the highest 5-hour share. */
export function capacityWord(rows: readonly CapacityRow[]): string {
  if (rows.some((row) => row.cap.hit !== null)) return "limit";
  const highest = rows.reduce<number | null>((share, row) => {
    const used = row.cap.fiveHour?.used;
    return used === undefined ? share : share === null ? used : Math.max(share, used);
  }, null);
  return highest === null ? "no reading" : `5h ${Math.round(highest * 100)}%`;
}

/** The most urgent row's tone, or moss with no rows. */
export function rowsTone(rows: readonly CapacityRow[]): "moss" | "lichen" | "rust" {
  if (rows.some((row) => row.tone === "rust")) return "rust";
  if (rows.some((row) => row.tone === "lichen")) return "lichen";
  return "moss";
}

/** A start the governor holds, with the backend that holds it (FR-036). */
export interface HeldRow {
  backend: string;
  held: HeldStart;
}

/** Every held start of every backend that answered, in `order`, oldest first within each. */
export function heldRows(info: Readonly<Record<string, CapacityInfo>>, order: readonly string[]): HeldRow[] {
  return order.flatMap((backend) => [...(info[backend]?.held ?? [])].sort((a, b) => a.since - b.since).map((held) => ({ backend, held })));
}

/** A hold as the settings form shows it: a whole percentage. */
export const holdPercent = (share: number): string => String(Math.round(share * 100));

/** The settings form's words as a patch, or what is wrong with them: each
 *  hold a percentage above 0 and at most 100, the dollar figure above 0 or
 *  empty to clear it. */
export function settingsPatch(form: { low: string; normal: string; weekly: string; usd: string }): Partial<CapacitySettings> | string {
  const patch: Partial<CapacitySettings> = {};
  for (const [field, key, name] of [["low", "lowHold", "low work"], ["normal", "normalHold", "normal work"], ["weekly", "weeklyLowHold", "the week"]] as const) {
    const n = Number(form[field].trim().replace(/%$/, ""));
    if (!form[field].trim() || !Number.isFinite(n) || n <= 0 || n > 100) return `the hold for ${name} is a percentage above 0 and at most 100`;
    patch[key] = n / 100;
  }
  const usd = form.usd.trim().replace(/^\$/, "");
  if (usd === "") patch.observedFiveHourUsd = null;
  else {
    const n = Number(usd);
    if (!Number.isFinite(n) || n <= 0) return "the dollar figure is above 0, or empty for none";
    patch.observedFiveHourUsd = n;
  }
  return patch;
}

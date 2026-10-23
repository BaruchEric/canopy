/** `canopy sweep` (FR-018): the idle shells, chats, runs and PRs a backend
 *  offers for closing, and, with --yes, closing the ones its sheet starts
 *  ticked, or every one it may close of the kinds --kind names. */

import { mayClose } from "../core/sweep";
import { ago } from "../core/treelines";
import { SWEEP_KINDS, type SweepInfo, type SweepItem, type SweepKind, type SweepOutcome } from "../core/types";
import { ask, errText, has, take, type Target } from "./health";

export const SWEEP_USAGE = "usage: canopy sweep [--yes [--kind shell,chat,run,pr]] [--backend URL]";

/** The keys --yes closes. With no kinds, the ones the sheet starts ticked
 *  (`checked` and closable), which is never a PR. With kinds named, every
 *  item of those kinds the sweep may close (`mayClose`), ticked or not, so
 *  `--kind pr` closes the PRs; a draft or a shell running a program is
 *  only ever closed from a tick in the sheet. */
export function sweepKeys(items: readonly SweepItem[], kinds: readonly SweepKind[] | undefined): string[] {
  const pick = kinds ? (i: SweepItem) => kinds.includes(i.kind) && mayClose(i) : (i: SweepItem) => i.closable && i.checked && i.kind !== "pr";
  return items.filter(pick).map((i) => i.key);
}

function parseKinds(text: string): SweepKind[] | string {
  const out: SweepKind[] = [];
  for (const word of text.split(",").map((w) => w.trim()).filter(Boolean)) {
    const kind = SWEEP_KINDS.find((k) => k === word);
    if (!kind) return `--kind takes ${SWEEP_KINDS.join(", ")}, not ${word}`;
    out.push(kind);
  }
  return out.length > 0 ? out : "--kind needs at least one kind";
}

/** How long the closing POST may take: the server closes items one at a
 *  time and snapshots each shell first, so it scales with the keys. */
export const sweepTimeoutMs = (keys: number): number => Math.min(10 * 60_000, 30_000 + 15_000 * keys);

/** The plan, a kind at a time: `kind  where  idle  why`, with a mark for
 *  what --yes would close with `kinds`. */
export function planLines(items: readonly SweepItem[], now: number = Date.now(), kinds?: readonly SweepKind[]): string[] {
  const out: string[] = [];
  const closes = new Set(sweepKeys(items, kinds));
  for (const kind of SWEEP_KINDS) {
    for (const i of items.filter((x) => x.kind === kind)) {
      const mark = i.closable ? (closes.has(i.key) ? "x" : " ") : "-";
      out.push(`[${mark}] ${kind.padEnd(7)} ${i.where.padEnd(28)} ${ago(i.idleSince / 1000, now).padStart(4)}  ${i.why}`);
    }
  }
  return out;
}

export async function sweepCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const yes = has(args, "--yes");
  const kindText = take(args, "--kind");
  if (args.length > 0) return fail(SWEEP_USAGE);
  let kinds: SweepKind[] | undefined;
  if (kindText !== undefined) {
    const parsed = parseKinds(kindText);
    if (typeof parsed === "string") return fail(parsed);
    kinds = parsed;
  }
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(home)) return fail(`--backend must be an http(s) origin, got ${home}`);
  const target: Target = { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(errText(err));

  const info = await ask<SweepInfo>(target, "GET", "/api/sweep").catch(failed);
  if (!yes) {
    if (info.items.length === 0) return console.log("nothing is idle enough to close");
    for (const line of planLines(info.items, Date.now(), kinds)) console.log(line);
    const n = sweepKeys(info.items, kinds).length;
    console.log(`${n} would close with --yes${kinds ? ` --kind ${kinds.join(",")}` : ""}`);
    return;
  }
  const keys = sweepKeys(info.items, kinds);
  if (keys.length === 0) return console.log("nothing to close");
  const { outcomes } = await ask<{ outcomes: SweepOutcome[] }>(target, "POST", "/api/sweep", { keys }, sweepTimeoutMs(keys.length)).catch(failed);
  const byKey = new Map(info.items.map((i) => [i.key, i]));
  for (const o of outcomes) {
    const i = byKey.get(o.key);
    console.log(`${o.result.padEnd(10)} ${i ? `${i.kind} ${i.where}` : o.key}${o.why ? `  ${o.why}` : ""}`);
  }
  if (outcomes.some((o) => o.result === "failed")) process.exitCode = 1;
}

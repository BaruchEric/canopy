/** The cost ledger on disk: one JSON line per row under `costs/`, a file per
 *  local month, appended and never rewritten; and `prices.json` beside the
 *  config, read on every report so an edit shows without a restart.
 *  Bun/node only; the server is the one caller. */

import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { estimate, parseCostLine, parsePrices, runDelta, type CostEntry, type CostRow, type PriceList, type RunSeen } from "./costs";
import { configDir } from "./store";
import type { Run, RunTokens } from "./types";

export const costsDir = (): string => join(configDir(), "costs");
export const pricesFile = (): string => join(configDir(), "prices.json");

const MONTH = /^(\d{4})-(\d{2})\.jsonl$/;

/** the local month a time falls in, as its file's name */
export function monthFile(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}.jsonl`;
}

export async function appendCost(e: CostEntry, dir: string = costsDir()): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, monthFile(e.at)), `${JSON.stringify(e)}\n`);
}

/** Every row since `since`, oldest first; a line that does not parse is skipped. */
export async function readCosts(since: number, dir: string = costsDir()): Promise<CostEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const first = monthFile(since);
  const out: CostEntry[] = [];
  for (const name of names.filter((n) => MONTH.test(n) && n >= first).sort()) {
    const text = await readFile(join(dir, name), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      const e = line ? parseCostLine(line) : null;
      if (e && e.at >= since) out.push(e);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The price list, or null with no prices.json; one that does not parse
 *  counts as empty, so a typo shows as missing estimates, not an error. */
export async function loadPrices(file: string = pricesFile()): Promise<PriceList | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    return parsePrices(JSON.parse(text));
  } catch {
    return {};
  }
}

/** The rows as served: the repo as an id where this backend still has it,
 *  and the price list's estimate. */
export const servedRows = (rows: readonly CostEntry[], prices: PriceList | null, idOf: (path: string) => string | null): CostRow[] =>
  rows.map((e) => ({ ...e, repoId: e.repo ? idOf(e.repo) : null, estUsd: prices ? estimate(e, prices) : null }));

/** local midnight `days - 1` days before `now`'s: a window of `days` local days */
export function sinceDays(days: number, now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}

/** a speech server named by its host, the provider a ledger row shows */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || "speech";
  } catch {
    return "speech";
  }
}

/** runs remembered for their next reply's difference; the oldest go first */
const SEEN_CAP = 500;

/** What the ledger already holds for a session: its rows' dollars and
 *  tokens summed, the figure a resumed session's harness starts from. */
export function sessionSeen(rows: readonly CostEntry[], session: string): RunSeen | null {
  let usd = 0;
  let tokens: RunTokens | null = null;
  let any = false;
  for (const e of rows) {
    if (e.session !== session) continue;
    any = true;
    usd += e.usd ?? 0;
    if (e.tokens) {
      const t: RunTokens = tokens ?? { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 };
      tokens = { input: t.input + e.tokens.input, cachedInput: t.cachedInput + e.tokens.cachedInput, output: t.output + e.tokens.output, reasoning: t.reasoning + e.tokens.reasoning, total: t.total + e.tokens.total };
    }
  }
  return any ? { usd, tokens } : null;
}

/**
 * Writes a row each time a run's result moves: a job's one result, each
 * reply of a chat. Fed every run change; the run's repo is looked up as it
 * is written, since a run names it by id and the ledger keeps the path.
 *
 * Claude's `--resume` brings the session's spend so far back with it, so a
 * run is tracked by its session rather than its id, and a session first seen
 * here (a resume across a canopy restart) starts from what the ledger holds
 * for it (`prior`). Changes are taken one at a time, so that read finishes
 * before the next change is weighed.
 */
export class RunCosts {
  private seen = new Map<string, RunSeen>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly write: (e: CostEntry) => void,
    private readonly repoOf: (id: string) => { path: string; name: string } | null,
    private readonly prior: (session: string) => Promise<RunSeen | null> = async () => null,
  ) {}

  onRun(run: Run): void {
    if (!run.result) return;
    this.queue = this.queue.then(() => this.weigh(run)).catch((err: unknown) => console.error(`costs: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** resolves once every change handed in so far has been weighed */
  settled(): Promise<void> {
    return this.queue;
  }

  private async weigh(run: Run): Promise<void> {
    const key = run.session ?? run.id;
    if (!this.seen.has(key) && run.session) {
      const before = await this.prior(run.session);
      if (before) this.seen.set(key, before);
    }
    const delta = runDelta(run, this.seen.get(key));
    if (!delta) return;
    this.seen.delete(key);
    this.seen.set(key, delta.now);
    if (this.seen.size > SEEN_CAP) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    const repo = this.repoOf(run.repoId);
    this.write({
      at: Date.now(),
      service: run.harness,
      provider: run.result?.provider || run.agentSettings?.provider || (run.harness === "claude" ? "anthropic" : "openai"),
      model: run.result?.model || (run.agentSettings?.model && run.agentSettings.model !== "default" ? run.agentSettings.model : null),
      repo: repo?.path ?? null,
      repoName: repo?.name ?? null,
      run: run.id,
      label: run.verb,
      session: run.session ?? null,
      ...(run.agentSettings ? { agentSettings: { ...run.agentSettings } } : {}),
      ...(run.action ? { action: run.action } : {}),
      ...(run.flowStep ? { flowStep: { ...run.flowStep } } : {}),
      usd: delta.usd,
      tokens: delta.tokens,
      seconds: null,
    });
  }
}

/**
 * What canopy's paid services cost: one ledger row per run reply, voice call
 * and dictated clip, with the dollars the provider reported where it reports
 * them (Claude Code) and the raw token or time usage elsewhere. A
 * `prices.json` beside the config turns usage into an
 * estimate; canopy ships no prices of its own. Pure and browser-safe: the
 * server's ledger (costledger.ts) and the costs view both import it.
 */

import { AGENT_EFFORTS, type AgentSettings, type FlowStepName, type Run, type RunTokens } from "./types";

export const COST_SERVICES = ["claude", "codex", "voice", "speech"] as const;
export type CostService = (typeof COST_SERVICES)[number];

export const SERVICE_NAME: Record<CostService, string> = {
  claude: "Claude Code",
  codex: "Codex",
  voice: "Voice",
  speech: "Dictation",
};

/** One ledger line. */
export interface CostEntry {
  /** unix ms */
  at: number;
  service: CostService;
  /** who bills it: a built-in provider or the configured provider id */
  provider: string;
  model: string | null;
  /** the repo's absolute path on the backend that wrote the row */
  repo: string | null;
  repoName: string | null;
  /** the canopy run or chat the row belongs to */
  run: string | null;
  /** the run's verb, or what the row was ("voice call") */
  label: string | null;
  /** Claude's session or Codex's thread */
  session: string | null;
  /** the agent settings resolved when this run started, absent on old rows */
  agentSettings?: Pick<AgentSettings, "harness" | "model" | "effort" | "provider">;
  /** the built-in action or workflow name, absent on old rows */
  action?: string;
  /** workflow and step, when this row came from a workflow step */
  flowStep?: FlowStepName;
  /** what the provider said it cost; null where it says nothing */
  usd: number | null;
  tokens: RunTokens | null;
  seconds: number | null;
}

/** GET /api/costs: a row as served, with the repo as this backend's id
 *  (null once the repo is gone) and the estimate the price list gives */
export interface CostRow extends CostEntry {
  repoId: string | null;
  /** from prices.json, only where `usd` is null and the list has a price */
  estUsd: number | null;
}

export interface CostReport {
  /** unix ms: the oldest row asked for */
  since: number;
  rows: CostRow[];
  /** whether this backend has a prices.json */
  priced: boolean;
}

/** One price: per minute for voice and clips, per million tokens for agents. */
export interface Price {
  perMinute?: number;
  inputPerM?: number;
  cachedInputPerM?: number;
  outputPerM?: number;
}

/** prices.json: `<provider>/<model>` or `<provider>/*` to a price */
export type PriceList = Record<string, Price>;

const PRICE_KEYS = ["perMinute", "inputPerM", "cachedInputPerM", "outputPerM"] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The list's well-formed entries; anything else is dropped. */
export function parsePrices(v: unknown): PriceList {
  const out: PriceList = {};
  if (!isObject(v)) return out;
  for (const [key, raw] of Object.entries(v)) {
    if (!key.includes("/") || !isObject(raw)) continue;
    const p: Price = {};
    for (const k of PRICE_KEYS) {
      const n = raw[k];
      if (fin(n) && n >= 0) p[k] = n;
    }
    if (Object.keys(p).length > 0) out[key] = p;
  }
  return out;
}

export const priceOf = (list: PriceList, provider: string, model: string | null): Price | null =>
  (model !== null ? list[`${provider}/${model}`] : undefined) ?? list[`${provider}/*`] ?? null;

/** What the price list makes of a row's usage; null where the provider
 *  reported dollars itself, or where the list has nothing that fits. */
export function estimate(e: CostEntry, list: PriceList): number | null {
  if (e.usd !== null) return null;
  const p = priceOf(list, e.provider, e.model);
  if (!p) return null;
  let usd = 0;
  let priced = false;
  if (e.seconds !== null && p.perMinute !== undefined) {
    usd += (e.seconds / 60) * p.perMinute;
    priced = true;
  }
  const t = e.tokens;
  if (t && (p.inputPerM !== undefined || p.outputPerM !== undefined)) {
    const cached = Math.min(t.cachedInput, t.input);
    usd += ((t.input - cached) * (p.inputPerM ?? 0) + cached * (p.cachedInputPerM ?? p.inputPerM ?? 0) + t.output * (p.outputPerM ?? 0)) / 1e6;
    priced = true;
  }
  return priced ? usd : null;
}

/** What a run had been charged at its last ledger row. */
export interface RunSeen {
  usd: number;
  tokens: RunTokens | null;
}

const ZERO: RunTokens = { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 };

const minus = (a: RunTokens, b: RunTokens): RunTokens => ({
  input: a.input - b.input,
  cachedInput: a.cachedInput - b.cachedInput,
  output: a.output - b.output,
  reasoning: a.reasoning - b.reasoning,
  total: a.total - b.total,
});

/**
 * The part of a run's result not yet in the ledger, and what it now stands
 * at. Both harnesses report cumulative usage, not just the last reply's
 * (Claude's `total_cost_usd` and cumulative `modelUsage`, Codex's
 * `tokenUsage.total`), so a reply's row is the difference from the last one.
 * A figure that went down means the harness started counting again, and
 * counts whole. Null when nothing new was spent. Claude's dollars are the
 * CLI's own; Codex reports no dollars.
 */
export function runDelta(run: Run, seen: RunSeen | undefined): { usd: number | null; tokens: RunTokens | null; now: RunSeen } | null {
  const r = run.result;
  if (!r) return null;
  const t = r.tokens;
  const before = seen?.tokens ?? ZERO;
  const tokenDelta = t ? (t.total < before.total ? t : minus(t, before)) : null;
  const tokens = tokenDelta && tokenDelta.total > 0 ? tokenDelta : null;
  const hasReportedUsd = run.harness === "claude" && r.costUsd !== undefined;
  const usdNow = hasReportedUsd ? r.costUsd ?? 0 : seen?.usd ?? 0;
  const usdBefore = seen?.usd ?? 0;
  const usdDelta = hasReportedUsd ? (usdNow < usdBefore ? usdNow : usdNow - usdBefore) : 0;
  if (!(usdDelta > 0) && !tokens) return null;
  return {
    // Explicit Claude dollars, including zero, suppress estimates. Codex's
    // compatibility zero remains unreported and can use a price estimate.
    usd: usdDelta > 0 ? usdDelta : hasReportedUsd ? 0 : null,
    tokens,
    now: { usd: usdNow, tokens: t ?? seen?.tokens ?? null },
  };
}

const isService = (v: unknown): v is CostService => typeof v === "string" && (COST_SERVICES as readonly string[]).includes(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const numOrNull = (v: unknown): number | null => (fin(v) ? v : null);

function tokensOf(v: unknown): RunTokens | null {
  if (!isObject(v)) return null;
  const n = (k: string) => (fin(v[k]) ? v[k] : 0);
  return { input: n("input"), cachedInput: n("cachedInput"), output: n("output"), reasoning: n("reasoning"), total: n("total") };
}

function settingsOf(v: unknown): CostEntry["agentSettings"] {
  if (!isObject(v) || (v["harness"] !== "claude" && v["harness"] !== "codex")) return undefined;
  const effort = AGENT_EFFORTS.find((level) => level === v["effort"]);
  if (typeof v["model"] !== "string" || effort === undefined) return undefined;
  return {
    harness: v["harness"],
    model: v["model"],
    effort,
    ...(typeof v["provider"] === "string" ? { provider: v["provider"] } : {}),
  };
}

function flowStepOf(v: unknown): FlowStepName | undefined {
  if (!isObject(v) || typeof v["workflow"] !== "string" || typeof v["step"] !== "string") return undefined;
  const source = v["source"];
  if (source !== "bundled" && source !== "user" && source !== "repo") return undefined;
  return { workflow: v["workflow"], step: v["step"], source };
}

/** One ledger line as an entry; null for anything that is not one. */
export function parseCostLine(line: string): CostEntry | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(v) || !fin(v["at"]) || typeof v["provider"] !== "string") return null;
  const service = v["service"];
  if (!isService(service)) return null;
  const agentSettings = settingsOf(v["agentSettings"]);
  const flowStep = flowStepOf(v["flowStep"]);
  return {
    at: v["at"],
    service,
    provider: v["provider"],
    model: str(v["model"]),
    repo: str(v["repo"]),
    repoName: str(v["repoName"]),
    run: str(v["run"]),
    label: str(v["label"]),
    session: str(v["session"]),
    ...(agentSettings ? { agentSettings } : {}),
    ...(typeof v["action"] === "string" ? { action: v["action"] } : {}),
    ...(flowStep ? { flowStep } : {}),
    usd: numOrNull(v["usd"]),
    tokens: tokensOf(v["tokens"]),
    seconds: numOrNull(v["seconds"]),
  };
}

/** a call or clip longer than this is a clock gone wrong, not a cost */
export const MAX_COST_SECONDS = 6 * 60 * 60;

/** a client's seconds, or null when they are not a sane length */
export const saneSeconds = (v: unknown): number | null => (fin(v) && v > 0 && v <= MAX_COST_SECONDS ? Math.round(v * 10) / 10 : null);

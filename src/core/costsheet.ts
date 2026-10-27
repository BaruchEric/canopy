/**
 * The costs view's sums: every backend's ledger rows and the claude-history
 * archive as lines by service, by repo and by run or chat. Claude's dollars
 * come from the archive, which already holds the sessions canopy started, so
 * a ledger Claude row on a card the archive has a figure for is shown on its
 * run but not added again. A row the archive has nothing for (a repo it does
 * not map, a run newer than its hourly sync) counts. Pure and browser-safe;
 * the costs view, `canopy costs` and the harness share import it.
 */
import { SERVICE_NAME, type CostRow } from "./costs";
import type { HistoryOverview, HistorySession } from "./types";
import type { RepoCard } from "./cards";

export const COST_WINDOWS = [
  { value: "1", label: "today", title: "Since midnight" },
  { value: "7", label: "7d", title: "The last 7 days, today among them" },
  { value: "30", label: "30d", title: "The last 30 days, today among them" },
] as const;
export type CostWindow = (typeof COST_WINDOWS)[number]["value"];

/** API-equivalent dollars the way claude-history prints them: cents until
 *  the number is big enough that they stop meaning anything. */
export function usdWord(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

/** Token counts in a compact form for the costs view and other pages. */
export function tokensWord(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** a ledger row with the backend it came from and its repo as the page names it */
export interface ServedRow extends CostRow {
  backend: string;
  /** the backend-qualified repo id, null when the row has no repo here */
  qid: string | null;
}

export interface CostLine {
  key: string;
  label: string;
  detail: string;
  /** dollars a provider reported: claude-history's and the ledger's */
  usd: number;
  /** dollars the price list estimates for usage nobody priced */
  est: number;
  tokens: number;
  seconds: number;
  /** rows with usage and no dollars, reported or estimated */
  unpriced: number;
  /** the newest row's time, 0 for none */
  at: number;
}

export interface CostSheet {
  usd: number;
  est: number;
  unpriced: number;
  /** false when claude-history did not answer: Claude is then canopy's own runs */
  archive: boolean;
  services: CostLine[];
  repos: CostLine[];
  runs: CostLine[];
}

const line = (key: string, label: string, detail = ""): CostLine => ({ key, label, detail, usd: 0, est: 0, tokens: 0, seconds: 0, unpriced: 0, at: 0 });

function add(l: CostLine, r: ServedRow): void {
  if (r.usd !== null) l.usd += r.usd;
  else if (r.estUsd !== null) l.est += r.estUsd;
  else l.unpriced++;
  l.tokens += r.tokens?.total ?? 0;
  l.seconds += r.seconds ?? 0;
  l.at = Math.max(l.at, r.at);
}

const worth = (l: CostLine): number => l.usd + l.est;
const byWorth = (a: CostLine, b: CostLine): number => worth(b) - worth(a) || b.tokens + b.seconds - (a.tokens + a.seconds) || b.at - a.at;

/** The archive's Claude dollars per card over the last `days` local days.
 *  Each backend's archive maps a session to its own checkout, and one
 *  archive may hold every machine's sessions, so a card takes its largest
 *  checkout's figure rather than their sum. */
export function claudeByCard(history: HistoryOverview | null, days: number, cards: readonly RepoCard[]): Map<string, number> {
  return new Map(claudeLeads(history, days, cards).map((l) => [l.key, l.usd]));
}

/** A card the archive has Claude dollars for in the window, with the
 *  checkout whose archive holds them: the one to ask for its sessions. */
export interface ClaudeLead {
  key: string;
  name: string;
  /** the checkout's repo id, backend-qualified */
  id: string;
  usd: number;
}

/** Every card with Claude dollars in the window, the costliest first. */
export function claudeLeads(history: HistoryOverview | null, days: number, cards: readonly RepoCard[]): ClaudeLead[] {
  if (!history?.available) return [];
  const from = Math.max(0, history.days.length - days);
  const out: ClaudeLead[] = [];
  for (const card of cards) {
    let best: ClaudeLead | null = null;
    for (const r of card.checkouts) {
      const h = history.repos[r.id];
      if (!h) continue;
      const usd = h.days.slice(from).reduce((a, b) => a + b, 0);
      if (usd > (best?.usd ?? 0)) best = { key: card.key, name: card.name, id: r.id, usd };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.usd - a.usd);
}

/** A repo's sessions as claude-history lists them, for the session lines. */
export interface LeadSessions {
  lead: ClaudeLead;
  sessions: readonly HistorySession[];
}

/** The archive's Claude sessions that started in the window, as lines,
 *  the costliest first. A session's cost is its whole cost, subagents
 *  included; one that began before the window is left out, so a long
 *  session never counts in a window it barely touched. */
export function sessionLines(parts: readonly LeadSessions[], since: number): CostLine[] {
  const out: CostLine[] = [];
  for (const { lead, sessions } of parts) {
    for (const s of sessions) {
      const at = s.started_at ? Date.parse(s.started_at) : Number.NaN;
      if (!(at >= since) || !(s.cost > 0)) continue;
      const words = (s.title ?? s.first_prompt ?? "").replace(/\s+/g, " ").trim();
      const l = line(`session:${s.id}`, words.length > 80 ? `${words.slice(0, 79)}…` : words || s.id.slice(0, 8));
      l.detail = [lead.name, s.host, `${s.turns} ${s.turns === 1 ? "turn" : "turns"}`].join(" · ");
      l.usd = s.cost;
      l.tokens = s.tokens;
      l.at = Date.parse(s.ended_at ?? s.started_at ?? "") || at;
      out.push(l);
    }
  }
  return out.sort(byWorth);
}

const NO_REPO = "\u0000none";

export function costSheet(rows: readonly ServedRow[], history: HistoryOverview | null, days: number, cards: readonly RepoCard[]): CostSheet {
  const archive = history?.available === true;
  const cardOf = new Map(cards.flatMap((c) => c.checkouts.map((r) => [r.id, c] as const)));
  const claude = claudeByCard(history, days, cards);

  const services = new Map<string, CostLine>();
  const models = new Map<string, Set<string>>();
  const repos = new Map<string, CostLine>();
  const runs = new Map<string, CostLine>();
  const runServices = new Map<string, Set<string>>();
  const runDetails = new Map<string, Set<string>>();

  const claudeLine = line("claude:anthropic", SERVICE_NAME.claude, archive ? "claude-history's sessions across configured providers, synced hourly" : "anthropic · canopy's runs only: claude-history did not answer");
  for (const [key, usd] of claude) {
    claudeLine.usd += usd;
    const card = cards.find((c) => c.key === key);
    const l = line(key, card?.name ?? key);
    l.usd = usd;
    repos.set(key, l);
  }
  let canopyClaude = 0;
  let canopyClaudeUsd = 0;

  for (const r of rows) {
    const card = r.qid ? cardOf.get(r.qid) : undefined;
    // claude-history indexes every Claude Code transcript for a repo. Its
    // totals do not separate providers, so all matching Claude rows overlap.
    const archivedClaude = r.service === "claude" && card !== undefined && claude.has(card.key);
    const counted = !archivedClaude;
    if (r.service === "claude" && (r.provider === "anthropic" || archivedClaude)) {
      canopyClaude++;
      canopyClaudeUsd += r.usd ?? 0;
    }
    if (counted) {
      const sk = `${r.service}:${r.provider}`;
      const firstPartyClaude = r.service === "claude" && r.provider === "anthropic";
      const s = firstPartyClaude ? claudeLine : (services.get(sk) ?? line(sk, `${SERVICE_NAME[r.service]} · ${r.provider}`));
      if (!firstPartyClaude) services.set(sk, s);
      add(s, r);
      if (r.model) models.set(sk, (models.get(sk) ?? new Set()).add(r.model));

      const rk = card ? card.key : r.repoName ? `name:${r.repoName}` : NO_REPO;
      const rl = repos.get(rk) ?? line(rk, card?.name ?? r.repoName ?? "no repo", rk === NO_REPO ? "dictation and calls made outside a repo" : "");
      repos.set(rk, rl);
      add(rl, r);
    } else {
      // Archive dollars replace this duplicate Claude cost, while the
      // canopy row remains the source for token usage.
      claudeLine.tokens += r.tokens?.total ?? 0;
      claudeLine.at = Math.max(claudeLine.at, r.at);
    }

    if (r.run) {
      const k = `${r.backend}:${r.run}`;
      const l = runs.get(k) ?? line(k, r.label ?? "run");
      runs.set(k, l);
      add(l, r);
      const where = (r.qid ? cardOf.get(r.qid)?.name : undefined) ?? r.repoName;
      if (where && !l.detail) l.detail = where;
      const customAgentProvider =
        (r.service === "claude" && r.provider !== "anthropic") || (r.service === "codex" && r.provider !== "openai");
      const serviceName = customAgentProvider ? `${SERVICE_NAME[r.service]} · ${r.provider}` : SERVICE_NAME[r.service];
      runServices.set(k, (runServices.get(k) ?? new Set()).add(serviceName));
      const settings = r.agentSettings;
      const runDetail = runDetails.get(k) ?? new Set<string>();
      const model = r.model ?? (settings?.model !== "default" ? settings?.model : undefined);
      if (model) runDetail.add(model);
      if (settings?.effort && settings.effort !== "default") runDetail.add(`${settings.effort} effort`);
      if (r.flowStep) runDetail.add(`${r.flowStep.workflow} / ${r.flowStep.step}`);
      if (runDetail.size) runDetails.set(k, runDetail);
    }
  }

  for (const [k, s] of services) s.detail = [...(models.get(k) ?? [])].join(", ") || s.label.split(" · ")[1] || "";
  if (canopyClaude > 0) claudeLine.detail += ` (canopy's ${canopyClaude} ${canopyClaude === 1 ? "reply" : "replies"}: $${canopyClaudeUsd.toFixed(2)})`;
  for (const [k, l] of runs) {
    l.detail = [l.detail, [...(runServices.get(k) ?? [])].join(" + "), [...(runDetails.get(k) ?? [])].join(" · ")].filter(Boolean).join(" · ");
  }

  const serviceLines = [...(claudeLine.usd > 0 || claudeLine.at > 0 ? [claudeLine] : []), ...[...services.values()].sort(byWorth)];
  return {
    usd: serviceLines.reduce((a, l) => a + l.usd, 0),
    est: serviceLines.reduce((a, l) => a + l.est, 0),
    unpriced: serviceLines.reduce((a, l) => a + l.unpriced, 0),
    archive,
    services: serviceLines,
    repos: [...repos.values()].sort(byWorth),
    runs: [...runs.values()].sort((a, b) => b.at - a.at),
  };
}

/** local midnight `days - 1` days ago: where a window of `days` begins */
export function windowStart(days: number, now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
}

/** a line's usage in words: "12.3k tokens · 4.2 min" */
export function usageWords(l: Pick<CostLine, "tokens" | "seconds">, fmtTokens: (n: number) => string): string {
  const parts: string[] = [];
  if (l.tokens > 0) parts.push(`${fmtTokens(l.tokens)} tokens`);
  if (l.seconds > 0) parts.push(l.seconds < 60 ? `${Math.round(l.seconds)} s` : `${(l.seconds / 60).toFixed(1)} min`);
  return parts.join(" · ");
}

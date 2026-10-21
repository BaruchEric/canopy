import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { joinRepos } from "../checkouts";
import { COST_WINDOWS, claudeLeads, costSheet, sessionLines, usageWords, windowStart, type ClaudeLead, type CostLine, type CostWindow, type LeadSessions, type ServedRow } from "../costs";
import { backendOf, plainOf, qual } from "../registry";
import { isOnline, useStore } from "../store";
import { fmtTokens, usd } from "../util";
import { Seg } from "./Seg";

type Fetched = { kind: "loading" } | { kind: "done"; rows: ServedRow[]; priced: boolean; failed: string[] };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Every online backend's ledger over the window, each row tagged with its
 *  backend and its repo qualified as the page names it. */
function useLedger(days: number): Fetched {
  const online = useStore((s) => s.backendOrder.filter((b) => isOnline(s, b)).join("\n"));
  const [got, setGot] = useState<Fetched>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    const names = online ? online.split("\n") : [];
    setGot({ kind: "loading" });
    void Promise.all(
      names.map((b) =>
        api.costs(days, b).then(
          (r) => ({ b, r, err: null }),
          (e: unknown) => ({ b, r: null, err: errText(e) }),
        ),
      ),
    ).then((parts) => {
      if (!live) return;
      const rows: ServedRow[] = [];
      const failed: string[] = [];
      let priced = false;
      for (const { b, r, err } of parts) {
        if (!r) {
          failed.push(`${b}: ${err ?? "no answer"}`);
          continue;
        }
        priced ||= r.priced;
        for (const row of r.rows) rows.push({ ...row, backend: b, qid: row.repoId ? qual(b, row.repoId) : null });
      }
      setGot({ kind: "done", rows, priced, failed });
    });
    return () => {
      live = false;
    };
  }, [days, online]);
  return got;
}

/** repos whose sessions are listed: the costliest in the window */
const SESSION_REPOS = 8;

/** The archive's sessions in the costliest repos, as the history section
 *  reads them; a repo whose list fails is left out. */
function useSessions(leads: readonly ClaudeLead[], days: number): CostLine[] | null {
  const ids = leads
    .slice(0, SESSION_REPOS)
    .map((l) => l.id)
    .join("\n");
  const [got, setGot] = useState<CostLine[] | null>(null);
  useEffect(() => {
    let live = true;
    const picked = leads.slice(0, SESSION_REPOS);
    setGot(null);
    void Promise.all(
      picked.map((lead) =>
        api.sessions(lead.id, "30d").then(
          (sessions): LeadSessions => ({ lead, sessions }),
          (): LeadSessions => ({ lead, sessions: [] }),
        ),
      ),
    ).then((parts) => {
      if (live) setGot(sessionLines(parts, windowStart(days)));
    });
    return () => {
      live = false;
    };
    // the leads are a fresh array each render; their ids say when they changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, days]);
  return got;
}

function Amount({ l }: { l: CostLine }) {
  return (
    <span className="cost-amt">
      {l.usd > 0 && <b>{usd(l.usd)}</b>}
      {l.est > 0 && <span title="Estimated from prices.json">≈ {usd(l.est)}</span>}
      {l.usd === 0 && l.est === 0 && <span className="cost-none">{l.unpriced > 0 ? "unpriced" : usd(0)}</span>}
    </span>
  );
}

function Lines({ title, lines, empty, limit }: { title: string; lines: CostLine[]; empty: string; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = limit && !all ? lines.slice(0, limit) : lines;
  return (
    <section className="cost-group">
      <h3 className="panel-label">
        {title} <span className="trigger-count">{lines.length}</span>
      </h3>
      {lines.length === 0 ? (
        <p className="cost-note">{empty}</p>
      ) : (
        <ul>
          {shown.map((l) => (
            <li key={l.key} className="cost-row">
              <span className="cost-name">
                {l.label}
                {l.detail && <small>{l.detail}</small>}
              </span>
              <span className="cost-usage">{usageWords(l, fmtTokens)}</span>
              <Amount l={l} />
            </li>
          ))}
        </ul>
      )}
      {limit && lines.length > limit && (
        <button type="button" className="mini" onClick={() => setAll(!all)}>
          {all ? "fewer" : `all ${lines.length}`}
        </button>
      )}
    </section>
  );
}

const PRICES_EXAMPLE = `{
  "openai/gpt-live-1": { "perMinute": 0.1 },
  "elevenlabs/*": { "perMinute": 0.08 },
  "openai/*": { "inputPerM": 1.25, "cachedInputPerM": 0.125, "outputPerM": 10 }
}`;

/** What canopy's paid services cost: Claude from the claude-history
 *  archive, the rest from each backend's ledger, by service, repo and run. */
export function CostsView() {
  const [win, setWin] = useState<CostWindow>("7");
  const days = Number(win);
  const got = useLedger(days);
  const { repos, order, history } = useStore(useShallow((s) => ({ repos: s.repos, order: s.backendOrder, history: s.history })));
  const cards = useMemo(() => joinRepos(repos, order, (id) => [backendOf(id), plainOf(id)]), [repos, order]);
  const sheet = useMemo(() => (got.kind === "done" ? costSheet(got.rows, history, days, cards) : null), [got, history, days, cards]);
  const leads = useMemo(() => claudeLeads(history, days, cards), [history, days, cards]);
  const sessions = useSessions(leads, days);
  return (
    <main className="health-view costs-view">
      <header className="cost-head">
        <Seg label="Window" value={win} options={COST_WINDOWS} onChange={setWin} />
        {sheet && (
          <span className="cost-total">
            <b>{usd(sheet.usd)}</b>
            {sheet.est > 0 && <span title="Estimated from prices.json"> + ≈ {usd(sheet.est)}</span>}
            {sheet.unpriced > 0 && (
              <span className="cost-none" title="Rows with usage and no price: no dollars from the provider and nothing in prices.json">
                {" "}
                + {sheet.unpriced} unpriced
              </span>
            )}
          </span>
        )}
      </header>
      {got.kind === "loading" && <p className="cost-note">reading the ledgers…</p>}
      {got.kind === "done" && got.failed.length > 0 && (
        <p className="cost-note rust" role="alert">
          Not counted: {got.failed.join("; ")}
        </p>
      )}
      {sheet && (
        <>
          {!sheet.archive && <p className="cost-note">claude-history did not answer, so Claude here is only what canopy's own runs reported.</p>}
          <Lines title="By service" lines={sheet.services} empty="Nothing spent in this window." />
          <Lines title="By repo" lines={sheet.repos} empty="Nothing spent in a repo in this window." limit={15} />
          <Lines title="By run and chat" lines={sheet.runs} empty="No canopy run, chat or voice call in a chat spent anything in this window." limit={15} />
          {sheet.archive && (
            <Lines
              title="Claude sessions"
              lines={sessions ?? []}
              empty={sessions === null ? "reading claude-history…" : `No session that began in this window, in the ${Math.min(SESSION_REPOS, leads.length)} costliest repos.`}
              limit={15}
            />
          )}
          <p className="cost-note">
            Claude Code's dollars are its own API-equivalent count from claude-history, not a bill. canopy's own Claude runs are inside that figure once claude-history has their repo, and count on their own until it does; the run list shows them one by one. Codex reports tokens, voice and dictation report minutes, and canopy keeps no prices.
            {got.kind === "done" && !got.priced && (
              <>
                {" "}
                To estimate them, put a <code>prices.json</code> beside canopy's config on each backend, keyed by provider and model:
              </>
            )}
          </p>
          {got.kind === "done" && !got.priced && <pre className="cost-example">{PRICES_EXAMPLE}</pre>}
        </>
      )}
    </main>
  );
}

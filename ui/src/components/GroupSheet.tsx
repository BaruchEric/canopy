import { useEffect, useState } from "react";
import type { CostEntry } from "../../../src/core/costs";
import { api } from "../api";
import { canPickMember, costOfGroup, groupWord, memberActions, memberColumns } from "../groups";
import { landWord, runOverlaps } from "../landing";
import { backendOf } from "../registry";
import { idText, landingAll, prsAll, useStore } from "../store";
import { fmtTokens, usd } from "../util";
import { OverlapChip } from "./Landing";

export function GroupSheet({ groupId }: { groupId: string }) {
  const info = useStore(s => landingAll(s));
  const group = info.groups?.find(g => g.id === groupId);
  const runs = useStore(s => s.runs);
  const watches = useStore(s => prsAll(s));
  const close = useStore(s => s.closeSheet);
  const showRun = useStore(s => s.showRun);
  const pick = useStore(s => s.pickRunGroup);
  const review = useStore(s => s.reviewGroup);
  const drop = useStore(s => s.dropGroup);
  const land = useStore(s => s.landRun);
  const approve = useStore(s => s.showApprove);
  const fix = useStore(s => s.fixLanding);
  const dropMember = useStore(s => s.dropLanding);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ledger, setLedger] = useState<CostEntry[]>([]);
  const [costError, setCostError] = useState("");
  const [keep, setKeep] = useState<string[]>([]);
  const started = group?.startedAt;
  const state = group?.state;
  useEffect(() => {
    if (started === undefined) return;
    let current = true;
    setLedger([]);
    setCostError("");
    void api.costs(Math.max(1, Math.ceil((Date.now() - started) / 86_400_000) + 1), backendOf(groupId)).then(r => {
      if (current) setLedger(r.rows);
    }, (e: unknown) => { if (current) setCostError(e instanceof Error ? e.message : String(e)); });
    return () => { current = false; };
  }, [groupId, started, state]);
  if (!group) return <><p className="sheet-empty">That group is gone.</p><footer className="sheet-foot"><button className="mini" type="button" onClick={close}>close</button></footer></>;
  const act = (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    void fn().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  const reviewer = group.review ? runs[group.review.run] : undefined;
  const reviewCost = group.review ? ledger.some(r => r.group === group.id && r.run === group.review?.run) ? costOfGroup(ledger, group.id, group.review.run) : { usd: reviewer?.result?.costUsd ?? 0, tokens: reviewer?.result?.tokens?.total ?? 0 } : null;
  const columns = memberColumns(group, info, runs);
  return <>
    <header className="sheet-head"><div><div className="eyebrow">{idText(group.repoId)} · {groupWord(group)}</div><h2 className="sheet-title">best of {group.expectedMembers}: {group.note}</h2></div><button type="button" className="mini close" onClick={close} aria-label="Close">✕</button></header>
    <div className="sheet-body">
      {group.reason && <p className="note rust">{group.reason}</p>}
      <div className="group-columns">{columns.map(column => {
        const { member, record, score, run } = column;
        const actions = memberActions(group, column, info);
        const watch = watches.find(w => w.id === member.origin);
        const entry = info.entries.find(e => e.id === member.origin);
        const why = group.review && "why" in group.review ? group.review.why[score?.branch ?? record?.branch ?? ""] : undefined;
        const costs = costOfGroup(ledger, group.id, member.run);
        const extra = record && record.runId !== member.run ? costOfGroup(ledger, group.id, record.runId) : { usd: 0, tokens: 0 };
        const cost = ledger.some(r => r.group === group.id && (r.run === member.run || r.run === record?.runId)) ? { usd: costs.usd + extra.usd, tokens: costs.tokens + extra.tokens } : column.cost;
        return <section className="group-column" key={member.origin} aria-label={record?.branch ?? score?.branch ?? member.origin}>
          <h3 className="landing-branch">{score?.branch ?? record?.branch ?? idText(member.origin)}{group.winner === member.origin && <span className="moss"> · winner</span>}</h3>
          <p>{member.profile ?? "repo's job route"} · {record?.pr !== undefined ? `PR #${record.pr}` : entry ? landWord(entry, info.entries) : record?.state ?? run?.status ?? score?.state ?? "waiting"}</p>
          <p className={score?.gates?.ok === false ? "rust" : "note"}>gates: {score?.gates ? score.gates.ok ? "passed" : `failed: ${score.gates.red ?? "a command"}` : "not scored"}</p>
          {score?.gates?.tail && <details><summary>gate output</summary><pre className="ask-detail">{score.gates.tail}</pre></details>}
          <p>scenarios: {score?.scenarios ? `${score.scenarios.passed}/${score.scenarios.total} · ${score.scenarios.score.toFixed(2)} (minimum ${(group.minimum ?? 0).toFixed(2)})` : "none scored"}</p>
          <p>review: {record?.review?.verdict ?? score?.verdict ?? "sorting"}{record?.review?.why ? ` · ${record.review.why}` : ""}</p>
          {score?.diffstat && <p>{score.diffstat.files} files · +{score.diffstat.added} −{score.diffstat.removed}</p>}
          <p>{usd(cost.usd)} · {fmtTokens(cost.tokens)} tokens</p>
          {why && <p>{why}</p>}
          {group.keptUntil?.[member.origin] !== undefined && <p className="note">kept until {new Date(group.keptUntil[member.origin] ?? 0).toLocaleString()}</p>}
          {entry?.reason && <p className="rust">{entry.reason}</p>}
          {runOverlaps(info, record?.runId ?? member.run).map(c => <OverlapChip key={c.id} name={c.name} paths={c.paths} />)}
          {watch && <a href={watch.url} target="_blank" rel="noreferrer">PR #{watch.number}</a>}
          {run && <button type="button" className="mini" onClick={() => showRun(run.id)}>open member run</button>}
          <div className="landing-tools">
            {canPickMember(group, member.origin, info) && <button type="button" className="mini" disabled={busy} onClick={() => act(() => pick(group.id, member.origin))}>pick this one</button>}
            {actions.land && <button type="button" className="mini strong" disabled={busy} onClick={() => actions.approve ? approve(member.origin) : act(() => land(member.origin))}>{actions.approve ? "look and land" : "land the winner"}</button>}
            {actions.fix && <button type="button" className="mini" disabled={busy} onClick={() => act(() => fix(member.origin))}>fix it</button>}
            {actions.drop && <button type="button" className="mini" disabled={busy} onClick={() => act(() => dropMember(member.origin))}>drop</button>}
          </div>
          {group.winner !== member.origin && !["landed", "dropped"].includes(group.state) && <label className="plan-branch"><input type="checkbox" checked={keep.includes(member.origin)} onChange={e => setKeep(xs => e.target.checked ? [...xs, member.origin] : xs.filter(x => x !== member.origin))} /> keep this branch for 24 hours when dropping the group</label>}
        </section>;
      })}</div>
      {group.review && <section><h3>Reviewer</h3>{reviewer && <button type="button" className="mini" onClick={() => showRun(reviewer.id)}>open reviewer run</button>}<p>{reviewCost ? `${usd(reviewCost.usd)} · ${fmtTokens(reviewCost.tokens)} tokens` : ""}</p>{"error" in group.review && <p className="rust">{group.review.error}</p>}{reviewer?.result?.text && <pre className="ask-detail">{reviewer.result.text}</pre>}</section>}
      {costError && <p className="note">Cost ledger unavailable: {costError}</p>}
      {error && <p className="note err" role="alert">{error}</p>}
    </div>
    <footer className="sheet-foot">
      {["needs-you", "reviewing"].includes(group.state) && columns.some(c => canPickMember(group, c.member.origin, info)) && <button type="button" className="mini" disabled={busy || group.state === "reviewing"} onClick={() => act(() => review(group.id))}>run the review again</button>}
      <span className="spacer" />
      {!["landed", "dropped"].includes(group.state) && <button type="button" className="mini" disabled={busy} onClick={() => act(() => drop(group.id, keep))}>drop group</button>}
      <button type="button" className="mini" onClick={close}>close</button>
    </footer>
  </>;
}

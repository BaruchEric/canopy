import { useState } from "react";
import type { LandEntry, LandingRun, Repo } from "../../../src/core/types";
import { backLine, chipWords, landWord, repoLanding, repoOrphans, hasLanding } from "../landing";
import { backendOf } from "../registry";
import { landingAll, useStore } from "../store";
import { keepKeys } from "../surface";
import { ago } from "../util";
import { Section } from "./Surface";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** The card's word for a repo's landing queue: how many runs wait their
 *  turn and how many came back. Clicking it opens the landing section. */
export function LandingChip({ repoId }: { repoId: string }) {
  const info = useStore((s) => landingAll(s));
  const words = chipWords(info, repoId);
  const showLanding = useStore((s) => s.showLanding);
  if (!words) return null;
  return (
    <button
      type="button"
      className={`run-chip landing-card ${words.tone}`}
      title={words.title}
      onClick={(e) => {
        e.stopPropagation();
        showLanding(repoId);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={keepKeys}
    >
      {words.text}
    </button>
  );
}

/** A repo's branch runs and landing queue: what is queued in order, what
 *  came back and why, what is ready to land, what landed lately, and any
 *  run worktree no record names. Shows only when there is something. */
export function LandingSection({ repo }: { repo: Repo }) {
  const info = useStore((s) => landingAll(s));
  const landRun = useStore((s) => s.landRun);
  const fixLanding = useStore((s) => s.fixLanding);
  const dropLanding = useStore((s) => s.dropLanding);
  const orphanLanding = useStore((s) => s.orphanLanding);
  const showRun = useStore((s) => s.showRun);
  const runs = useStore((s) => s.runs);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const l = repoLanding(info, repo.id);
  const orphans = repo.host ? [] : repoOrphans(info, repo.path);
  if (!hasLanding(l) && orphans.length === 0) return null;
  const act = (key: string, fn: () => Promise<void>) => {
    setError("");
    setBusy(key);
    void fn().then(
      () => setBusy(null),
      (err: unknown) => {
        setBusy(null);
        setError(errText(err));
      },
    );
  };
  const words = chipWords(info, repo.id);
  const openRun = (runId: string) => {
    if (runs[runId]) showRun(runId);
  };
  const runLink = (r: Pick<LandingRun, "runId" | "branch">) =>
    runs[r.runId] ? (
      <button type="button" className="landing-branch landing-open" title="Show the run" onClick={() => openRun(r.runId)}>
        {r.branch}
      </button>
    ) : (
      <span className="landing-branch">{r.branch}</span>
    );
  const entryRun = (e: LandEntry): Pick<LandingRun, "runId" | "branch"> => ({ runId: info.runs.find((r) => r.id === e.id)?.runId ?? "", branch: e.branch });
  return (
    <Section
      repo={repo}
      k="landing"
      className="landing-section"
      label="Landing"
      head={words ? <span className={words.tone === "back" ? "rust" : "lichen"}>{words.text}</span> : ""}
      title="Branch runs and the queue that lands them on main: rebase, the repo's gates, then a fast-forward. Nothing is pushed."
      copy={() =>
        [
          ...l.queue.map((e) => `${e.branch}  ${landWord(e, info.entries)}`),
          ...l.back.map((e) => `${e.branch}  ${landWord(e, info.entries)}  ${backLine(e)}`),
          ...l.ready.map((r) => `${r.branch}  ready`),
        ].join("\n")
      }
    >
      <div className="landing-body">
        {l.queue.length > 0 && (
          <ol className="landing-list">
            {l.queue.map((e) => (
              <li key={e.id} className={`landing-row st-${e.state}`}>
                {runLink(entryRun(e))}
                <span className="landing-state">{landWord(e, info.entries)}</span>
                {e.reason && <span className="landing-why">{e.reason}</span>}
                {e.noGates && <span className="landing-why">no gates to run</span>}
                <span className="landing-note">{e.note}</span>
              </li>
            ))}
          </ol>
        )}
        {l.back.length > 0 && (
          <ul className="landing-list back">
            {l.back.map((e) => (
              <li key={e.id} className={`landing-row st-${e.state}`}>
                {runLink(entryRun(e))}
                <span className="landing-state rust">{landWord(e, info.entries)}</span>
                <span className="landing-tools">
                  {e.fixing ? (
                    <button type="button" className="mini" onClick={() => openRun(e.fixing!)}>
                      fix going
                    </button>
                  ) : (
                    <button type="button" className="mini strong" disabled={busy !== null} title="Continue the run on its branch with the reason as its next message" onClick={() => act(e.id, () => fixLanding(e.id))}>
                      {busy === e.id ? "starting…" : "fix it"}
                    </button>
                  )}
                  <button type="button" className="mini" disabled={busy !== null || e.fixing !== undefined} title="Give the branch up: its worktree and its commits go" onClick={() => act(`drop:${e.id}`, () => dropLanding(e.id))}>
                    drop
                  </button>
                </span>
                {e.state === "red" ? (
                  <details className="landing-out">
                    <summary>{backLine(e)}</summary>
                    <pre>{e.reason}</pre>
                  </details>
                ) : (
                  <span className="landing-why">{e.reason}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {l.ready.length > 0 && (
          <ul className="landing-list">
            {l.ready.map((r) => (
              <li key={r.id} className="landing-row st-ready">
                {runLink(r)}
                <span className="landing-state moss">ready</span>
                <span className="landing-tools">
                  <button type="button" className="mini strong" disabled={busy !== null} title={`Rebase onto ${r.target}, run the gates, fast-forward ${r.target}`} onClick={() => act(r.id, () => landRun(r.id))}>
                    {busy === r.id ? "queueing…" : "land"}
                  </button>
                </span>
                <span className="landing-note">{r.note}</span>
              </li>
            ))}
          </ul>
        )}
        {l.other.length > 0 && (
          <ul className="landing-list dim">
            {l.other.map((r) => (
              <li key={r.id} className={`landing-row st-${r.state}`}>
                {runLink(r)}
                <span className="landing-state">{r.state === "working" ? "working" : r.state === "uncommitted" ? "changes left uncommitted" : r.state === "stopped" ? "stopped by a restart" : "no commits"}</span>
                {r.state !== "working" && (
                  <span className="landing-tools">
                    <button type="button" className="mini" disabled={busy !== null} title="Remove the branch and its worktree" onClick={() => act(`drop:${r.id}`, () => dropLanding(r.id))}>
                      drop
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {l.landed.length > 0 && (
          <ul className="landing-list dim">
            {l.landed.map((e) => (
              <li key={e.id} className="landing-row st-landed">
                <span className="landing-branch">{e.branch}</span>
                <span className="landing-state moss">landed{e.head ? ` at ${e.head.slice(0, 7)}` : ""}</span>
                {e.landedAt && <span className="landing-note">{ago(Math.floor(e.landedAt / 1000))}</span>}
              </li>
            ))}
          </ul>
        )}
        {orphans.length > 0 && (
          <ul className="landing-list">
            {orphans.map((o) => (
              <li key={o.dir} className="landing-row st-orphan">
                <span className="landing-branch" title={o.dir}>
                  {o.branch ?? o.dir}
                </span>
                <span className="landing-state lichen">orphaned worktree</span>
                <span className="landing-tools">
                  {o.queueable && (
                    <button type="button" className="mini" disabled={busy !== null} title="Land it as a run of its own" onClick={() => act(o.dir, () => orphanLanding(backendOf(repo.id), o.dir, "queue"))}>
                      queue anyway
                    </button>
                  )}
                  <button type="button" className="mini" disabled={busy !== null} onClick={() => act(`rm:${o.dir}`, () => orphanLanding(backendOf(repo.id), o.dir, "remove"))}>
                    remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="landing-err">{error}</p>}
      </div>
    </Section>
  );
}

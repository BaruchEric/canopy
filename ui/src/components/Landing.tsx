import { useState } from "react";
import { withName } from "../../../src/core/touch";
import type { LandEntry, LandingRun, Repo } from "../../../src/core/types";
import { approveFiles, backLine, chipWords, landAllOf, landWord, needsApproval, noticeLine, openedRow, overlapChip, runOverlaps, repoLanding, repoOrphans, hasLanding, stoppedLandTitle, stoppedWhole, verdictTone, verdictWord } from "../landing";
import { backendOf } from "../registry";
import { idText, landingAll, prsAll, useStore } from "../store";
import { repoPrChip } from "../prs";
import { keepKeys } from "../surface";
import { ago } from "../util";
import { DiffView } from "./DiffView";
import { Section } from "./Surface";
import { PopGear } from "./PopGrip";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** A foldable overlap word: the paths stay available without taking space in the row. */
export function OverlapChip({ name, paths }: { name: string; paths: string[] }) {
  const chip = overlapChip(name, paths);
  return (
    <details className="landing-overlap">
      <summary className="landing-state lichen" title={chip.title}>{chip.text}</summary>
      <ul>{paths.map((path) => <li className="landing-branch" key={path}>{path}</li>)}</ul>
    </details>
  );
}

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

/** The card's word for a repo's open PRs and their checks (FR-011).
 *  Clicking it opens the run whose PR needs a look most. */
export function PrChip({ repoId }: { repoId: string }) {
  const prs = useStore((s) => prsAll(s));
  const showRun = useStore((s) => s.showRun);
  const chip = repoPrChip(prs, repoId);
  if (!chip) return null;
  return (
    <button
      type="button"
      className={`run-chip pr-card ${chip.tone}`}
      title="PRs that branch runs opened on GitHub; canopy watches their checks and reviews"
      onClick={(e) => {
        e.stopPropagation();
        showRun(chip.runId);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={keepKeys}
    >
      {chip.text}
    </button>
  );
}

/** A repo's branch runs and landing queue: what is queued in order, what
 *  came back and why, what is ready to land, what landed lately, and any
 *  run worktree no record names. A run a restart stopped lands from the
 *  rest once its work is whole, or says why not. Shows only when there is
 *  something. */
export function LandingSection({ repo }: { repo: Repo }) {
  const info = useStore((s) => landingAll(s));
  const landRun = useStore((s) => s.landRun);
  const landAll = useStore((s) => s.landAll);
  const showApprove = useStore((s) => s.showApprove);
  const fixLanding = useStore((s) => s.fixLanding);
  const dropLanding = useStore((s) => s.dropLanding);
  const orphanLanding = useStore((s) => s.orphanLanding);
  const showRun = useStore((s) => s.showRun);
  const runs = useStore((s) => s.runs);
  const watches = useStore((s) => prsAll(s));
  const [error, setError] = useState("");
  const [skipped, setSkipped] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const l = repoLanding(info, repo.id);
  const all = landAllOf(info, repo.id);
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
          ...l.other.filter(stoppedWhole).map((r) => `${r.branch}  stopped, can land`),
          ...l.opened.map((r) => `${r.branch}  ${openedRow(r, watches).word}`),
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
                {e.auto && <span className="landing-state moss" title="Its sort found only changes the repo's review rules let land unseen">joined on its own</span>}
                {e.approved && <span className="landing-state" title="You approved its sensitive files">approved</span>}
                {e.reason && <span className="landing-why">{e.reason}</span>}
                {e.noGates && <span className="landing-why">no gates to run</span>}
                {e.overlap && <OverlapChip name={e.overlap.with} paths={e.overlap.paths} />}
                {runOverlaps(info, entryRun(e).runId).map((collision) => <OverlapChip key={collision.id} name={withName(collision.with)} paths={collision.paths} />)}
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
        {l.ready.length >= 2 && all.take.length > 0 && (
          <div className="landing-row">
            <span className="landing-state">{l.ready.length} ready</span>
            <span className="landing-tools">
              <button
                type="button"
                className="mini strong"
                disabled={busy !== null}
                title={all.skip.length > 0 ? `Queue every ready run but ${all.skip.length} that need your approval` : "Queue every ready run, in the order they finished"}
                onClick={() =>
                  act("all", async () => {
                    setSkipped("");
                    const got = await landAll(repo.id);
                    if (got.skipped.length > 0) setSkipped(`Left for you: ${got.skipped.map((x) => `${x.branch} (${x.why})`).join(", ")}`);
                  })
                }
              >
                {busy === "all" ? "queueing…" : `land all ${all.take.length}`}
              </button>
            </span>
            {skipped && <span className="landing-why">{skipped}</span>}
          </div>
        )}
        {l.ready.length > 0 && (
          <ul className="landing-list">
            {l.ready.map((r) => (
              <li key={r.id} className="landing-row st-ready">
                {runLink(r)}
                <span className="landing-state moss">ready</span>
                <span className={`landing-state ${verdictTone(r)}`} title={r.review?.why ?? "What its sort says: the review rules in the repo's .canopy/review.json"}>
                  {verdictWord(r)}
                </span>
                <span className="landing-tools">
                  {needsApproval(r) ? (
                    <button type="button" className="mini strong" disabled={busy !== null} title="Open its sensitive files and their diffs, then approve and land" onClick={() => showApprove(r.id)}>
                      look and land
                    </button>
                  ) : (
                    <button type="button" className="mini strong" disabled={busy !== null} title={`Rebase onto ${r.target}, run the gates, fast-forward ${r.target}`} onClick={() => act(r.id, () => landRun(r.id))}>
                      {busy === r.id ? "queueing…" : "land"}
                    </button>
                  )}
                </span>
                <span className="landing-note">{r.note}</span>
              </li>
            ))}
          </ul>
        )}
        {l.opened.length > 0 && (
          <ul className="landing-list dim">
            {l.opened.map((r) => {
              const o = openedRow(r, watches);
              return (
                <li key={r.id} className="landing-row st-pr">
                  {runLink(r)}
                  {o.url ? (
                    <a className="landing-state" href={o.url} target="_blank" rel="noreferrer" title="The PR watch has it: open it on GitHub">
                      {o.word}
                    </a>
                  ) : (
                    <span className="landing-state" title="It opened a PR, so it never lands here, and no PR watch has it now">
                      {o.word}
                    </span>
                  )}
                  {o.canDrop && (
                    <span className="landing-tools">
                      <button type="button" className="mini" disabled={busy !== null} title="Remove the branch and its worktree here; the PR and its remote branch stay on GitHub" onClick={() => act(`drop:${r.id}`, () => dropLanding(r.id))}>
                        drop
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {l.other.length > 0 && (
          <ul className="landing-list dim">
            {l.other.map((r) => (
              <li key={r.id} className={`landing-row st-${r.state}`}>
                {runLink(r)}
                <span className="landing-state">{r.state === "working" ? "working" : r.state === "uncommitted" ? "changes left uncommitted" : r.state === "stopped" ? "stopped by a restart" : "no commits"}</span>
                {runOverlaps(info, r.runId).map((collision) => <OverlapChip key={collision.id} name={withName(collision.with)} paths={collision.paths} />)}
                {stoppedWhole(r) && (
                  <span className={`landing-state ${verdictTone(r)}`} title={r.review?.why ?? "What its sort says: the review rules in the repo's .canopy/review.json"}>
                    {verdictWord(r)}
                  </span>
                )}
                {r.state !== "working" && (
                  <span className="landing-tools">
                    {stoppedWhole(r) &&
                      (needsApproval(r) ? (
                        <button type="button" className="mini strong" disabled={busy !== null} title="Open its sensitive files and their diffs, then approve and land" onClick={() => showApprove(r.id)}>
                          look and land
                        </button>
                      ) : (
                        <button type="button" className="mini strong" disabled={busy !== null} title={stoppedLandTitle(r.target)} onClick={() => act(r.id, () => landRun(r.id))}>
                          {busy === r.id ? "queueing…" : "land"}
                        </button>
                      ))}
                    <button type="button" className="mini" disabled={busy !== null} title="Remove the branch and its worktree" onClick={() => act(`drop:${r.id}`, () => dropLanding(r.id))}>
                      drop
                    </button>
                  </span>
                )}
                {r.state === "stopped" && r.whole && !r.whole.ok && <span className="landing-why">{r.whole.why}</span>}
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

/** A branch run's sensitive files, each unfolding to its diff, and
 *  "approve and land", which sends the patch id this sheet opened with. A
 *  branch that changed since answers 409, and the sheet says to look again
 *  rather than approving what was never shown. */
export function ApproveSheet({ id }: { id: string }) {
  const info = useStore((s) => landingAll(s));
  const close = useStore((s) => s.closeSheet);
  const landRun = useStore((s) => s.landRun);
  const landingDiff = useStore((s) => s.landingDiff);
  const loadLanding = useStore((s) => s.loadLanding);
  const rec = info.runs.find((r) => r.id === id);
  const [shown, setShown] = useState(rec?.review?.sensitiveId);
  /** each unfolded file's diff; null while it is read */
  const [diffs, setDiffs] = useState<Record<string, string | null>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!rec?.review) {
    return (
      <>
        <p className="sheet-empty">{rec ? "Its sort is not in yet." : "That branch run is gone: it landed, or was dropped."}</p>
        <footer className="sheet-foot">
          <span className="spacer" />
          <button type="button" className="mini" onClick={close}>
            close
          </button>
        </footer>
      </>
    );
  }
  const review = rec.review;
  const { look, rest } = approveFiles(rec);
  const moved = review.sensitiveId !== shown;
  const read = (path: string) => {
    if (diffs[path] !== undefined) return;
    setDiffs((d) => ({ ...d, [path]: null }));
    landingDiff(rec.id, path).then(
      (diff) => setDiffs((d) => ({ ...d, [path]: diff })),
      (err: unknown) => setDiffs((d) => ({ ...d, [path]: `could not read the diff: ${errText(err)}` })),
    );
  };
  const again = () => {
    setShown(review.sensitiveId);
    setDiffs({});
    setError("");
  };
  const approve = async () => {
    setBusy(true);
    setError("");
    try {
      await landRun(rec.id, shown);
      close();
    } catch (err) {
      setBusy(false);
      setError(errText(err));
      void loadLanding(backendOf(rec.repoId));
    }
  };
  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">needs your approval · {idText(rec.repoId)}</div>
          <h2 className="sheet-title">{rec.branch}</h2>
        </div>
        <PopGear />
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="sheet-body approve">
        <p className="blurb">{rec.note}</p>
        {review.why && <p className="note err">{review.why}</p>}
        <ul className="approve-files">
          {look.map((f) => (
            <li key={f.path}>
              <details onToggle={(e) => e.currentTarget.open && read(f.path)}>
                <summary>
                  <span className="landing-branch">{f.from ? `${f.from} → ${f.path}` : f.path}</span>
                  <span className="approve-why">{f.sensitive ?? f.why ?? f.cls}</span>
                </summary>
                {typeof diffs[f.path] === "string" ? <DiffView diff={diffs[f.path]!} /> : <p className="sheet-hint">reading the diff…</p>}
              </details>
            </li>
          ))}
        </ul>
        {rest.length > 0 && (
          <p className="sheet-hint">
            Also on the branch: {rest.map((f) => `${f.path} (${f.cls})`).join(", ")}
          </p>
        )}
        {moved && (
          <p className="note err">
            The branch changed since this sheet opened.{" "}
            <button type="button" className="mini" onClick={again}>
              look again
            </button>
          </p>
        )}
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">Approving names these files as they are now; a later change to them needs a new look.</span>
        <span className="spacer" />
        <button type="button" className="mini" onClick={close}>
          cancel
        </button>
        <button type="button" className="mini strong" disabled={busy || moved || !shown} onClick={() => void approve()}>
          {busy ? "queueing…" : "approve and land"}
        </button>
      </footer>
    </>
  );
}

/** The queue's quiet lines at the inbox's foot: runs that landed on their
 *  own and runs held back from it. Outside the inbox's count; "seen"
 *  clears them. */
export function LandingNotices() {
  const info = useStore((s) => landingAll(s));
  const seenLanding = useStore((s) => s.seenLanding);
  const [error, setError] = useState("");
  const notices = info.notices ?? [];
  if (notices.length === 0) return null;
  return (
    <section className="settings-row">
      <h3 className="panel-label">from the landing queue</h3>
      <ul className="inbox-recent">
        {notices.slice(0, 12).map((n) => (
          <li key={n.id} title={n.note}>
            <span className={n.kind === "held" || n.kind === "collision" ? "landing-held" : undefined}>{noticeLine(n)}</span>
            <span className="inbox-left dim">{ago(Math.floor(n.at / 1000))}</span>
          </li>
        ))}
      </ul>
      <button type="button" className="mini" onClick={() => void seenLanding(notices.map((n) => n.id)).catch((err: unknown) => setError(errText(err)))}>
        seen
      </button>
      {error && <p className="settings-hint error">{error}</p>}
    </section>
  );
}

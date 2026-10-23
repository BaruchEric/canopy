import { useEffect, useState } from "react";
import type { KeptShell, SweepItem, SweepOutcome, SweptChat } from "../../../src/core/types";
import { durationWord } from "../agentcards";
import { useStore } from "../store";
import { defaultPicks, groupItems, KIND_HEAD, outcomesOf, sheetRows, sweepSummary } from "../sweep";
import { useNow } from "./Registry";

const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);

/** a broom, in the ink of the button it sits in */
function Broom() {
  return (
    <svg className="broom" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2 8.6 7.4" />
      <path d="M7.3 6.3 9.7 8.7 8.6 10.2C7.2 12 5 13.5 2.2 14 2.6 11.2 4.2 9 6 7.6Z" />
      <path d="M4.6 11.4 3.6 12.4M6.6 11.8 5.8 12.8" />
    </svg>
  );
}

/**
 * The broom on the sessions view's status line and the agents board's bar:
 * opens the sweep sheet, with how many idle things it may close once the
 * sweep has been read.
 */
export function SweepButton({ className = "mini" }: { className?: string }) {
  const openSweep = useStore((s) => s.openSweep);
  const n = useStore((s) => s.sweep?.items.filter((i) => i.closable).length ?? 0);
  return (
    <button type="button" className={`${className} sweep-btn`} title="Sweep: close the shells, chats and runs that went idle" onClick={openSweep}>
      <Broom />
      sweep{n > 0 && <span className="sweep-count">{n}</span>}
    </button>
  );
}

/** the word an outcome shows in place of its row's box, and its tone */
const OUT_TONE: Record<SweepOutcome["result"], string> = {
  closed: "moss",
  "in use now": "lichen",
  gone: "dim",
  failed: "rust",
};

const outWord = (o: SweepOutcome, kind: SweepItem["kind"]): string => {
  const word = o.result === "closed" && kind === "run" ? "dismissed" : o.result;
  return o.why ? `${word}: ${o.why}` : word;
};

/**
 * The sweep sheet (FR-018): what went idle on the home backend, a kind at
 * a time, each row with its box, where it is, how long it has been idle
 * and why it counts. It starts ticked as the plan says (every kind but
 * PRs); agents canopy did not start are listed with no box. "Close N"
 * closes the ticked ones, each looked at again first, and every row it
 * took stays in place with how it went. The "swept" fold brings back what
 * an earlier close took: a shell restores with its history and its agent's
 * own conversation, a chat resumes its session.
 */
export function SweepSheet() {
  const sweep = useStore((s) => s.sweep);
  const close = useStore((s) => s.closeSheet);
  const loadSweep = useStore((s) => s.loadSweep);
  const closeSweep = useStore((s) => s.closeSweep);
  const [picks, setPicks] = useState<Set<string> | null>(null);
  const [done, setDone] = useState<{ items: SweepItem[]; outcomes: SweepOutcome[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unread, setUnread] = useState(false);
  const now = useNow(30_000);

  // read afresh on open: the plan the page holds may be a close or a
  // minute old, and a page that never read it has nothing
  useEffect(() => {
    let on = true;
    void loadSweep().then(() => {
      if (on && !useStore.getState().sweep) setUnread(true);
    });
    return () => {
      on = false;
    };
  }, [loadSweep]);

  const head = (
    <header className="sheet-head">
      <div>
        <div className="eyebrow">sweep</div>
        <h2 className="sheet-title">What went idle</h2>
      </div>
      <button type="button" className="mini close" onClick={close} aria-label="Close">
        ✕
      </button>
    </header>
  );

  if (!sweep) {
    return (
      <>
        {head}
        <p className="sheet-empty">{unread ? "The sweep could not be read: this backend is older than the sweep, or this page lacks the right to it." : "Reading the sweep…"}</p>
        <footer className="sheet-foot">
          <span className="spacer" />
          <button type="button" className="mini" onClick={close}>
            close
          </button>
        </footer>
      </>
    );
  }

  const items = sweep.items;
  const live = new Map(items.map((i) => [i.key, i]));
  const chosen = picks ?? defaultPicks(items);
  const ticked = items.filter((i) => i.closable && chosen.has(i.key)).map((i) => i.key);
  const rows = sheetRows(items, done);
  const outcomes = new Map(rows.flatMap((r) => (r.outcome ? [[r.item.key, r.outcome] as const] : [])));
  const groups = groupItems(rows.map((r) => r.item));

  const setTicks = (keys: string[], on: boolean) =>
    setPicks((p) => {
      const next = new Set(p ?? defaultPicks(items));
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const go = async () => {
    if (ticked.length === 0) return;
    const sent = items.filter((i) => ticked.includes(i.key));
    setBusy(true);
    setError("");
    try {
      setDone({ items: sent, outcomes: await closeSweep(ticked) });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const last = sweep.lastRun;
  return (
    <>
      {head}
      <div className="sheet-body sweep-body no-autofocus">
        {done ? (
          <p className="sweep-summary">{sweepSummary(done.outcomes)}</p>
        ) : (
          last && (
            <p className="sheet-hint sweep-last">
              Last close {durationWord(now - last.at)} ago{last.by === "schedule" ? ", on its schedule" : ""}: {sweepSummary(outcomesOf(last))}
            </p>
          )
        )}
        {groups.length === 0 && <p className="sweep-none">Nothing has been idle long enough to offer.</p>}
        {groups.map((g) => {
          const can = g.items.filter((i) => live.get(i.key)?.closable);
          const all = can.length > 0 && can.every((i) => chosen.has(i.key));
          return (
            <section key={g.kind} className={`sweep-group k-${g.kind}`}>
              <h3 className="sweep-head">
                {can.length > 0 ? (
                  <label>
                    <input type="checkbox" checked={all} disabled={busy} onChange={(e) => setTicks(can.map((i) => i.key), e.currentTarget.checked)} />
                    {KIND_HEAD[g.kind]}
                  </label>
                ) : (
                  <span>{KIND_HEAD[g.kind]}</span>
                )}
                <span className="sweep-n">{g.items.length}</span>
                {g.kind === "outside" && <span className="sweep-note">listed only: canopy did not start them and never stops them</span>}
              </h3>
              <ul className="sweep-list">
                {g.items.map((i) => (
                  <SweepRowView
                    key={i.key}
                    item={i}
                    outcome={outcomes.get(i.key)}
                    box={live.get(i.key)?.closable === true}
                    ticked={chosen.has(i.key)}
                    disabled={busy}
                    now={now}
                    onTick={(on) => setTicks([i.key], on)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
        <Swept shells={sweep.swept.shells} chats={sweep.swept.chats} now={now} />
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">A closed shell keeps its history and comes back from the swept list; a closed chat resumes its conversation.</span>
        <span className="spacer" />
        <button type="button" className="mini" onClick={close}>
          {done ? "done" : "cancel"}
        </button>
        <button type="button" className="mini strong no-autofocus" disabled={busy || ticked.length === 0} onClick={() => void go()}>
          {busy ? `closing ${ticked.length}…` : `Close ${ticked.length}`}
        </button>
      </footer>
    </>
  );
}

function SweepRowView({
  item,
  outcome,
  box,
  ticked,
  disabled,
  now,
  onTick,
}: {
  item: SweepItem;
  outcome: SweepOutcome | undefined;
  box: boolean;
  ticked: boolean;
  disabled: boolean;
  now: number;
  onTick: (on: boolean) => void;
}) {
  const idle = durationWord(now - item.idleSince);
  const text = (
    <>
      <span className="sweep-where" title={item.title !== item.where ? item.title : undefined}>
        {item.where}
      </span>
      {item.title && item.title !== item.where && <span className="sweep-title">{item.title}</span>}
      <span className="sweep-idle" title="idle for">
        {idle}
      </span>
      <span className="sweep-why">{item.why}</span>
    </>
  );
  const out = outcome && <span className={`sweep-out t-${OUT_TONE[outcome.result]}`}>{outWord(outcome, item.kind)}</span>;
  return (
    <li className={`sweep-row${outcome ? ` o-${outcome.result.replace(/\s+/g, "-")}` : ""}`}>
      {box ? (
        <label className="sweep-pick">
          <input type="checkbox" checked={ticked} disabled={disabled} onChange={(e) => onTick(e.currentTarget.checked)} />
          {text}
          {out}
        </label>
      ) : (
        <div className="sweep-pick">
          <span className="sweep-nobox" aria-hidden="true" />
          {text}
          {out}
        </div>
      )}
    </li>
  );
}

/** What earlier closes took that can come back: a shell restores with its
 *  history (and its agent's own conversation, when one ran in it), a chat
 *  resumes its session and opens waiting for a message. */
function Swept({ shells, chats, now }: { shells: KeptShell[]; chats: SweptChat[]; now: number }) {
  const repos = useStore((s) => s.repos);
  const kept = useStore((s) => s.kept);
  const restoreShell = useStore((s) => s.restoreShell);
  const resumeSwept = useStore((s) => s.resumeSwept);
  const loadSweep = useStore((s) => s.loadSweep);
  const close = useStore((s) => s.closeSheet);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  if (shells.length === 0 && chats.length === 0) return null;
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  const act = async (id: string, what: () => Promise<void>) => {
    setBusy(id);
    setError("");
    try {
      await what();
    } catch (err) {
      setError(errText(err));
      setBusy("");
    }
  };
  const restore = (k: KeptShell) =>
    act(k.id, async () => {
      if (!kept.some((x) => x.id === k.id)) throw new Error("that shell is not on offer any more");
      // with its agent's own conversation when one ran in it
      await restoreShell(k.id, k.agent !== null);
      // a restore goes through the shells' routes, which the hub does not hear
      void loadSweep();
      close();
    });
  const resume = (c: SweptChat) => act(c.runId, () => resumeSwept(c.runId));
  const counts = [shells.length ? `${shells.length} shell${shells.length === 1 ? "" : "s"}` : "", chats.length ? `${chats.length} chat${chats.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  return (
    <details className="sweep-swept">
      <summary>swept · {counts}</summary>
      <ul className="sweep-list">
        {shells.map((k) => (
          <li key={k.id} className="sweep-row">
            <div className="sweep-pick">
              <span className="sweep-nobox" aria-hidden="true" />
              <span className="sweep-where">{k.label ?? repoName(k.repoId)}</span>
              {k.label && <span className="sweep-title">{repoName(k.repoId)}</span>}
              <span className="sweep-why">
                shell{k.agent ? ` with ${k.agent}` : ""}, {k.lines} lines kept · swept {durationWord(now - k.savedAt)} ago
              </span>
              <button type="button" className="mini sweep-act" disabled={busy !== ""} title={k.agent ? `Open it again with its history, and ${k.agent} back on its own conversation` : "Open it again with its history"} onClick={() => void restore(k)}>
                {busy === k.id ? "restoring…" : "restore"}
              </button>
            </div>
          </li>
        ))}
        {chats.map((c) => (
          <li key={c.runId} className="sweep-row">
            <div className="sweep-pick">
              <span className="sweep-nobox" aria-hidden="true" />
              <span className="sweep-where">{repoName(c.repoId)}</span>
              {c.title && <span className="sweep-title">{c.title}</span>}
              <span className="sweep-why">
                {c.harness} chat · swept {durationWord(now - c.sweptAt)} ago
              </span>
              <button type="button" className="mini sweep-act" disabled={busy !== ""} title="Start the chat again on its conversation; it waits for your message" onClick={() => void resume(c)}>
                {busy === c.runId ? "resuming…" : "resume"}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="note err">{error}</p>}
    </details>
  );
}

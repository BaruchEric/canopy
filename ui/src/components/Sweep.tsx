import { useEffect, useRef, useState } from "react";
import { SWEEP_KINDS, type KeptShell, type SweepItem, type SweepKind, type SweepOutcome, type SweptChat } from "../../../src/core/types";
import { durationWord } from "../agentcards";
import { useStore } from "../store";
import { defaultPicks, dropPicks, groupItems, headKeys, KIND_HEAD, nextAuto, outcomesOf, prPlace, prsDownNote, prUrl, sheetRows, spanMs, spanParts, sweepSummary, switchUnit, type SpanUnit } from "../sweep";
import { useNow } from "./Registry";
import { PopGear } from "./PopGrip";

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
    <button type="button" className={`${className} sweep-btn`} title="Sweep: close the shells, chats, runs and PRs that went idle" onClick={openSweep}>
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
 * and why it counts. It starts ticked as the plan says, and never on a PR
 * (`defaultPicks`), a draft's row saying it is one; a PR's title links to
 * it on GitHub. Agents canopy did not start are listed with no box. "Close N"
 * closes the ticked ones, each looked at again first, and every row it
 * took stays in place with how it went. The "swept" fold brings back what
 * an earlier close took: a shell restores with its history and its agent's
 * own conversation, a chat resumes its session. Opened by the ask's "pick"
 * in the inbox, it starts with only the ask's ticked items ticked (a shell
 * running a program stays unticked until Eric ticks it); a close from here
 * leaves the ask, which loses what closed on the next event.
 */
export function SweepSheet({ picks: start }: { picks?: readonly string[] | undefined } = {}) {
  const sweep = useStore((s) => s.sweep);
  const close = useStore((s) => s.closeSheet);
  const loadSweep = useStore((s) => s.loadSweep);
  const closeSweep = useStore((s) => s.closeSweep);
  // the inbox's "pick" starts it on the ask's items alone, rather than the plan's defaults
  const [picks, setPicks] = useState<Set<string> | null>(() => (start ? new Set(start) : null));
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
      <PopGear />
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
  // GitHub did not list the PRs: said where their group would be
  const prsDown = groups.some((g) => g.kind === "pr") ? null : prsDownNote(sweep);
  const downAt = prPlace(groups);
  const downNote = prsDown && (
    <section key="pr-down" className="sweep-group k-pr">
      <h3 className="sweep-head">
        <span>{KIND_HEAD.pr}</span>
        <span className="sweep-note">{prsDown}</span>
      </h3>
    </section>
  );

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
      // what went is not picked any more, so a second close counts only the rest
      setPicks((p) => dropPicks(p, items, ticked));
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
        {groups.flatMap((g, at) => {
          // a draft or a busy shell is left to its own box
          const can = headKeys(g.items, live);
          const all = can.length > 0 && can.every((k) => chosen.has(k));
          return [
            at === downAt ? downNote : null,
            <section key={g.kind} className={`sweep-group k-${g.kind}`}>
              <h3 className="sweep-head">
                {can.length > 0 ? (
                  <label>
                    <input type="checkbox" checked={all} disabled={busy} onChange={(e) => setTicks(can, e.currentTarget.checked)} />
                    {KIND_HEAD[g.kind]}
                  </label>
                ) : (
                  <span>{KIND_HEAD[g.kind]}</span>
                )}
                <span className="sweep-n">{g.items.length}</span>
                {g.kind === "outside" && <span className="sweep-note">listed only: canopy did not start them and never stops them</span>}
                {g.kind === "pr" && <span className="sweep-note">unticked to start: a close is public, with a comment saying the sweep closed it; the branch stays</span>}
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
            </section>,
          ];
        })}
        {downAt === groups.length && downNote}
        <Swept shells={sweep.swept.shells} chats={sweep.swept.chats} now={now} />
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">A closed shell keeps its history and comes back from the swept list; a closed chat resumes its conversation; a closed PR keeps its branch and can be reopened on GitHub.</span>
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
  const url = prUrl(item);
  const text = (
    <>
      <span className="sweep-where" title={item.title !== item.where ? item.title : undefined}>
        {item.where}
      </span>
      {item.title &&
        item.title !== item.where &&
        (url ? (
          <a className="sweep-title" href={url} target="_blank" rel="noreferrer" title="Open it on GitHub">
            {item.title}
          </a>
        ) : (
          <span className="sweep-title">{item.title}</span>
        ))}
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
  const restoreShell = useStore((s) => s.restoreShell);
  const resumeSwept = useStore((s) => s.resumeSwept);
  const loadSweep = useStore((s) => s.loadSweep);
  const close = useStore((s) => s.closeSheet);
  const [busy, setBusy] = useState("");
  // the row whose restore or resume failed, and why; shown in that row
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  if (shells.length === 0 && chats.length === 0) return null;
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  const act = async (id: string, what: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await what();
    } catch (err) {
      setError({ id, text: errText(err) });
      setBusy("");
    }
  };
  // the store says why when the shell is not on offer or its repo has left
  const restore = (k: KeptShell) =>
    act(k.id, async () => {
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
            {error?.id === k.id && <p className="note err">{error.text}</p>}
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
            {error?.id === c.runId && <p className="note err">{error.text}</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** the kinds the schedule may close on its own; agents canopy did not
 *  start are never closed, so they are not offered */
const AUTO_KINDS = ["shell", "chat", "run", "pr"] as const satisfies readonly SweepKind[];

/** each span's label in the settings row */
const SPAN_LABEL: Record<SweepKind, string> = {
  shell: "shells idle after",
  chat: "chats idle after",
  run: "finished runs after",
  pr: "PRs idle after",
  outside: "outside agents after",
};

/** what the row says when PRs are among the kinds closed on their own */
export const PR_AUTO_WARNING = "Closes public PRs on GitHub with no one looking.";

/** what the row says under "sweep PRs from this backend" */
export const PRS_HINT =
  "Your open PRs on every repo, as gh's login sees them. Turn this on for one backend only: the list is the same from every backend. With PRs also ticked to close on their own below, the schedule closes public PRs with no one looking.";

/**
 * The sweep's row in Settings, beside the ranger's: the schedule's switch
 * and cron, how long each kind sits idle before it is offered (in hours or
 * days), and the kinds the schedule closes without asking. The home
 * backend's alone, as every sweep route is. A refusal (a cron that does
 * not parse) shows in the row, and the cron as typed stays to be fixed.
 */
export function SweepRow() {
  const sweep = useStore((s) => s.sweep);
  const home = useStore((s) => s.home);
  const setSweepSettings = useStore((s) => s.setSweepSettings);
  // typed and not yet saved: saved on blur or Enter, not on each keystroke
  const [cron, setCron] = useState<string | null>(null);
  const [typed, setTyped] = useState<Partial<Record<SweepKind, string>>>({});
  const [units, setUnits] = useState<Partial<Record<SweepKind, SpanUnit>>>({});
  const [err, setErr] = useState<string | null>(null);
  // Saves go one at a time, in order, and the row is disabled while any is
  // out. `outstanding` counts them for the handlers, so the blur that
  // follows an Enter, before the disable lands, posts nothing twice.
  const [busy, setBusy] = useState(false);
  const outstanding = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // the auto kinds as the toggles not yet saved leave them, so a second
  // toggle in the same moment builds on the first rather than on this render
  const pendingAuto = useRef<SweepKind[] | null>(null);
  const [shownAuto, setShownAuto] = useState<SweepKind[] | null>(null);
  if (!sweep) return null;
  const s = sweep.settings;
  const save = (patch: Record<string, unknown>): Promise<boolean> => {
    outstanding.current += 1;
    setBusy(true);
    const run = async (): Promise<boolean> => {
      setErr(null);
      try {
        await setSweepSettings(patch);
        return true;
      } catch (e) {
        setErr(errText(e));
        return false;
      } finally {
        outstanding.current -= 1;
        if (outstanding.current === 0) setBusy(false);
      }
    };
    const done = queue.current.then(run);
    queue.current = done;
    return done;
  };
  const commitCron = () => {
    if (cron === null || outstanding.current > 0) return;
    const v = cron.trim();
    if (!v || v === s.cron) {
      setCron(null);
      return;
    }
    void save({ cron: v }).then((ok) => {
      if (ok) setCron(null);
    });
  };
  const commitSpan = (kind: SweepKind, unit: SpanUnit, text: string | undefined) => {
    if (text === undefined || outstanding.current > 0) return;
    const ms = spanMs(text, unit);
    if (ms === null) {
      setErr(`the ${kind} span is a number above zero`);
      return;
    }
    const drop = () => setTyped(({ [kind]: _gone, ...rest }) => rest);
    if (ms === s.spans[kind]) {
      drop();
      return;
    }
    void save({ spans: { [kind]: ms } }).then((ok) => {
      if (ok) drop();
    });
  };
  const toggleAuto = (kind: SweepKind, on: boolean) => {
    // over the toggles still on their way, else the newest settings the
    // store holds, never this render's: one must not undo another
    const next = nextAuto(pendingAuto.current ?? useStore.getState().sweep?.settings.auto ?? s.auto, kind, on);
    pendingAuto.current = next;
    setShownAuto(next);
    void save({ auto: next }).then(() => {
      if (pendingAuto.current !== next) return;
      pendingAuto.current = null;
      setShownAuto(null);
    });
  };
  return (
    <section className="settings-row">
      <h3 className="panel-label">sweep</h3>
      <label className="settings-line">
        <input type="checkbox" checked={s.on} disabled={busy} onChange={(e) => void save({ on: e.target.checked })} />
        sweep on a schedule
      </label>
      <label className="settings-line">
        <input type="checkbox" checked={s.prs} disabled={busy} onChange={(e) => void save({ prs: e.target.checked })} />
        sweep PRs from this backend
      </label>
      <p className="settings-hint">{PRS_HINT}</p>
      {s.prs && prsDownNote(sweep) && <p className="settings-hint error">{prsDownNote(sweep)}</p>}
      <div className="ranger-fields">
        <label className="layout-field">
          when (cron)
          <input
            className="settings-input sweep-cron"
            disabled={busy}
            value={cron ?? s.cron}
            spellCheck={false}
            placeholder="0 4 * * *"
            onChange={(e) => setCron(e.target.value)}
            onBlur={commitCron}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitCron();
            }}
          />
        </label>
      </div>
      <div className="ranger-fields sweep-spans">
        {SWEEP_KINDS.map((kind) => {
          const shown = spanParts(s.spans[kind], units[kind]);
          const text = typed[kind];
          return (
            <label key={kind} className="layout-field">
              {SPAN_LABEL[kind]}
              <span className="sweep-span">
                <input
                  className="settings-input"
                  type="number"
                  step="any"
                  disabled={busy}
                  aria-label={`${SPAN_LABEL[kind]}, in ${shown.unit}`}
                  value={text ?? shown.value}
                  onChange={(e) => setTyped((t) => ({ ...t, [kind]: e.target.value }))}
                  onBlur={() => commitSpan(kind, shown.unit, text)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitSpan(kind, shown.unit, text);
                  }}
                />
                <select
                  className="settings-input"
                  disabled={busy}
                  aria-label={`${SPAN_LABEL[kind]}: hours or days`}
                  value={shown.unit}
                  onChange={(e) => {
                    // the span stays and shows in the new unit; nothing is saved
                    const next = switchUnit(text, shown.unit, e.target.value === "days" ? "days" : "hours");
                    setUnits((u) => ({ ...u, [kind]: next.unit }));
                    setTyped(({ [kind]: _was, ...rest }) => (next.typed === undefined ? rest : { ...rest, [kind]: next.typed }));
                  }}
                >
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </span>
            </label>
          );
        })}
      </div>
      <div className="layout-field">
        closes on its own
        <div className="sweep-auto">
          {AUTO_KINDS.map((kind) => (
            <label key={kind} className="settings-line" title={kind === "pr" ? PR_AUTO_WARNING : undefined}>
              <input type="checkbox" checked={(shownAuto ?? s.auto).includes(kind)} disabled={busy} onChange={(e) => toggleAuto(kind, e.target.checked)} />
              {KIND_HEAD[kind]}
            </label>
          ))}
        </div>
      </div>
      {(shownAuto ?? s.auto).includes("pr") && <p className="settings-hint error">{PR_AUTO_WARNING}</p>}
      {err && <p className="settings-hint error">{err}</p>}
      <p className="settings-hint">
        A setting of {home}, the home backend. On its cron ({home}'s local time) the sweep closes what went idle past these spans among the
        kinds ticked to close on their own, and puts the rest it could close in the inbox as one ask: close all, pick, or dismiss. A shell
        running a program is never closed on its own, and agents canopy did not start are only ever listed.
      </p>
    </section>
  );
}

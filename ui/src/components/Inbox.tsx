import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Ask } from "../../../src/core/types";
import { joinTarget } from "../agentcards";
import { api } from "../api";
import { askWord, detailText, endingWord, inboxTick, inboxTitle, leftWord, recentAsks, type InboxAnswer, type InboxItem } from "../inbox";
import { useFitPop } from "../pop";
import { qual } from "../registry";
import { canAnswer as canAnswerHere, inboxItems, useStore } from "../store";
import { PermissionForm, Questions } from "./Prompts";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** "now", "4m", "3h" since a unix ms time */
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** now, again every `ms` while `on` */
function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

const KIND_GLYPH: Record<InboxItem["kind"], string> = { permission: "⚿", question: "?", guard: "⛨", gate: "⏸", clarify: "✎" };
const SOURCE_WORD: Record<InboxItem["source"], string> = { ask: "agent", run: "run", flow: "workflow", sprout: "incubator" };

/** One thing waiting: who, where and the countdown, then the form that
 *  answers it, folded until picked. An ask that cannot be answered here (no
 *  answer key on this device) shows what it asks and says so. */
function InboxRow({
  item,
  now,
  open,
  onToggle,
  canAnswer,
  onGit,
}: {
  item: InboxItem;
  now: number;
  open: boolean;
  onToggle: () => void;
  canAnswer: boolean;
  onGit?: () => void;
}) {
  const answerInbox = useStore((s) => s.answerInbox);
  const shown = useStore(useShallow((s) => s.backendOrder));
  const card = useStore((s) => (item.source === "ask" ? s.registry[s.asks[item.id]?.agent ?? ""] : undefined));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const left = item.until !== null ? item.until - now : null;
  const readOnly = item.source === "ask" && !canAnswer;

  const answer = (a: InboxAnswer) => {
    setBusy(true);
    setErr(null);
    answerInbox(item, a)
      .catch((e: unknown) => setErr(errText(e)))
      .finally(() => setBusy(false));
  };
  const target = card ? joinTarget(card, shown, qual) : null;
  const held = useStore((s) => (target ? s.shells.find((t) => t.id === target)?.place : undefined));
  const openSheet = () => {
    const st = useStore.getState();
    st.closeInbox();
    if (item.source === "run") st.showRun(item.id);
    else if (item.source === "flow") st.showFlow(item.id);
    else if (item.source === "sprout") st.showSprout(item.id);
  };
  const join = () => {
    if (!target) return;
    const st = useStore.getState();
    st.closeInbox();
    st.bringTerm(target);
    // a panel shell shows in the git view
    if (held === "panel") onGit?.();
  };

  const heading = item.source === "ask" ? `${item.who} ${item.kind === "guard" ? "hit a guard; it waits for you" : "wants to run"}` : `${item.who} wants to run`;
  const detail = item.source === "ask" ? detailText(item.detail) : item.detail;

  return (
    <li className={`inbox-item${open ? " open" : ""}${left !== null && left <= 0 ? " late" : ""}`} data-key={item.key}>
      <button type="button" className="inbox-head" aria-expanded={open} onClick={onToggle}>
        <span className={`inbox-glyph k-${item.kind}`} aria-hidden="true">
          {KIND_GLYPH[item.kind]}
        </span>
        <span className="inbox-who">{item.who}</span>
        {item.repo && <span className="inbox-repo">{item.repo}</span>}
        <span className="inbox-where" title={`${SOURCE_WORD[item.source]} · ${item.where}`}>
          {item.where}
        </span>
        {left !== null ? (
          <span className="inbox-left" title="Then it goes back to the agent's terminal">
            {leftWord(left, item.kind)}
          </span>
        ) : (
          <span className="inbox-left dim">{ago(item.at, now)}</span>
        )}
        <span className="inbox-title">{item.title}</span>
      </button>
      {open && (
        <div className="inbox-body">
          {readOnly ? (
            <div className="ask">
              <div className="eyebrow">{item.questions?.length ? `${item.who} asks` : heading}</div>
              {item.questions?.length ? (
                <ul className="inbox-qs">
                  {item.questions.map((q) => (
                    <li key={q.question}>
                      {q.question} <span className="dim">({q.options.map((o) => o.label).join(" / ")})</span>
                    </li>
                  ))}
                </ul>
              ) : (
                detail && <pre className="ask-detail">{detail}</pre>
              )}
              <p className="settings-hint">This device has no answer key, so this ask waits for its terminal: add yours in Settings to answer it here.</p>
            </div>
          ) : item.kind === "gate" ? (
            <div className="ask">
              <div className="eyebrow">{item.who} {item.title}</div>
              {detail && <pre className="ask-detail">{detail}</pre>}
              <div className="ask-row">
                <button
                  type="button"
                  className="mini strong"
                  disabled={busy}
                  title={item.budget ? "The budget is spent; this lets one more step run, then it parks again" : undefined}
                  onClick={() => answer({ choice: "continue" })}
                >
                  {item.budget ? "allow one more step" : "continue"}
                </button>
                {!item.budget && (
                  <button type="button" className="mini" disabled={busy} onClick={() => answer({ choice: "retry" })}>
                    retry the step
                  </button>
                )}
                <span className="spacer" />
                <button type="button" className="mini" disabled={busy} onClick={() => answer({ choice: "stop" })}>
                  stop
                </button>
              </div>
            </div>
          ) : item.questions?.length ? (
            <Questions
              questions={item.questions}
              who={item.who}
              busy={busy}
              onAnswer={(answers) => answer({ answers })}
              {...(item.source === "ask"
                ? { onDecline: () => answer({ behavior: "deny" }) }
                : item.source === "sprout"
                  ? {
                      onDecline: () => answer({ skip: true }),
                      declineLabel: "go on assumptions",
                      declineTitle: "Research goes on with what clarify assumed, and intent.md says you chose that",
                    }
                  : {})}
            />
          ) : (
            <PermissionForm
              heading={heading}
              detail={detail}
              busy={busy}
              onAllow={() => answer({ behavior: "allow" })}
              {...(item.source === "run"
                ? { always: { label: "allow all for this run", title: "Every later request in this run passes without asking", onClick: () => answer({ behavior: "allow", always: true }) } }
                : item.kind === "permission"
                  ? {
                      always: {
                        label: "allow always",
                        title: "Allow it, and the same again for the rest of that session (Claude Code; Codex asks each time)",
                        onClick: () => answer({ behavior: "allow", always: true }),
                      },
                    }
                  : {})}
              onDeny={(message) => answer({ behavior: "deny", ...(message ? { message } : {}) })}
              denyMessage={item.source === "ask"}
            />
          )}
          <div className="kept-acts">
            {item.source !== "ask" && (
              <button type="button" className="mini" onClick={openSheet}>
                open the {item.source === "run" ? "run" : item.source === "sprout" ? "project" : "workflow"}
              </button>
            )}
            {held && (
              <button type="button" className="mini" title="The canopy shell the agent runs in" onClick={join}>
                join its shell
              </button>
            )}
          </div>
          {err && <p className="settings-hint error">{err}</p>}
        </div>
      )}
    </li>
  );
}

/** An ask a link named that is no longer waiting: how it went, read from
 *  what the page holds or asked of the broker. */
function GoneAsk({ id }: { id: string }) {
  const held = useStore((s) => s.asks[id]);
  const [read, setRead] = useState<Ask | null | "missing">(null);
  useEffect(() => {
    if (held) return;
    let live = true;
    api
      .ask(id)
      .then((a) => live && setRead(a))
      .catch(() => live && setRead("missing"));
    return () => {
      live = false;
    };
  }, [id, held]);
  const a = held ?? (read && read !== "missing" ? read : null);
  if (!a && read !== "missing") return <p className="settings-hint">Looking up that ask…</p>;
  if (!a) return <p className="settings-hint">That ask is not known any more (asks are kept a week).</p>;
  if (a.state === "open") return null;
  return (
    <p className="settings-hint">
      The ask you followed a link to, {a.handle} {askWord(a)} ({a.title}), is closed: {endingWord(a)}.
    </p>
  );
}

/**
 * The inbox in the top bar (and the agents view's bar): `? n` counts what
 * waits on you, rust while anything does. Open, it lists every open ask,
 * every run on a prompt and every flow at a gate, oldest first, each with
 * the form that answers it; then how the last asks ended, and the away
 * switch. Nothing shows when there is no broker and nothing waits. `onGit`
 * takes the agents view to the git view, where a joined panel shell shows.
 */
export function InboxChip({ onGit }: { onGit?: () => void } = {}) {
  const items = useStore(inboxItems);
  const open = useStore((s) => s.inboxOpen);
  const focus = useStore((s) => s.inboxFocus);
  const ready = useStore((s) => s.asksReady);
  const canAnswer = useStore(canAnswerHere);
  const presence = useStore((s) => s.presence);
  const home = useStore((s) => s.home);
  const asks = useStore((s) => s.asks);
  const { openInbox, closeInbox, setAway } = useStore.getState();
  const [picked, setPicked] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // the clocks move whenever the inbox is open: a countdown by the second,
  // a waiting run's or gate's age more slowly
  const now = useNow(open, inboxTick(items));
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeInbox();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeInbox();
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, closeInbox]);

  // the item a link or a row named, in view once the list is drawn
  useEffect(() => {
    if (!open || !focus) return;
    const el = ref.current?.querySelector(`[data-key="${CSS.escape(focus)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, focus, items]);

  if (!ready && items.length === 0) return null;
  const expanded = picked ?? (focus && items.some((i) => i.key === focus) ? focus : (items[0]?.key ?? null));
  const recent = recentAsks(Object.values(asks)).slice(0, 8);
  const goneFocus = focus?.startsWith("ask:") && !items.some((i) => i.key === focus) ? focus.slice(4) : null;

  const toggleAway = (away: boolean) => {
    setErr(null);
    setAway(away).catch((e: unknown) => setErr(errText(e)));
  };

  return (
    <div className="settings inbox" ref={ref}>
      <button
        type="button"
        className={open ? "mini on" : items.length ? "mini inbox-waiting" : "mini"}
        aria-label={`${items.length} waiting on you`}
        aria-expanded={open}
        title={inboxTitle(items)}
        onClick={() => (open ? closeInbox() : openInbox())}
      >
        <span aria-hidden="true">?</span> {items.length || ""}
      </button>
      {open && (
        <div className="settings-pop inbox-pop" role="dialog" aria-label="Waiting on you">
          <section className="settings-row">
            <h3 className="panel-label">waiting on you</h3>
            {goneFocus && <GoneAsk id={goneFocus} />}
            {items.length === 0 ? (
              <p className="settings-hint">Nothing is waiting on you: no agent asks, no run is on a prompt, no workflow is at a gate.</p>
            ) : (
              <ul className="inbox-list">
                {items.map((i) => (
                  <InboxRow
                    key={i.key}
                    item={i}
                    now={now}
                    open={expanded === i.key}
                    canAnswer={canAnswer}
                    onGit={onGit}
                    onToggle={() => setPicked(expanded === i.key ? "" : i.key)}
                  />
                ))}
              </ul>
            )}
          </section>
          {recent.length > 0 && (
            <section className="settings-row">
              <h3 className="panel-label">lately</h3>
              <ul className="inbox-recent">
                {recent.map((a) => (
                  <li key={a.id} title={a.title}>
                    <span className="inbox-who">{a.handle || a.agent}</span> {askWord(a)}: {endingWord(a)}
                    <span className="inbox-left dim">{ago(a.answeredAt ?? a.createdAt, Date.now())}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {ready && (
            <section className="settings-row">
              <h3 className="panel-label">presence</h3>
              {canAnswer ? (
                <>
                  <label className="settings-line">
                    <input type="checkbox" checked={presence?.state === "away" && presence.pinned} onChange={(e) => toggleAway(e.target.checked)} />
                    I am away: an agent's ask waits half an hour here (and DMs you) before it goes back to its terminal
                  </label>
                  <p className="settings-hint">
                    {presence?.state === "here"
                      ? "Here now: an ask waits a minute here. Typing in canopy keeps you here; a quarter hour without makes you away."
                      : presence?.pinned
                        ? "Away until you clear it."
                        : "Away: nothing was typed in canopy for a quarter hour."}
                  </p>
                </>
              ) : (
                <p className="settings-hint">
                  This device cannot answer asks or set presence: add your answer key in Settings (this device's secret from the broker's
                  ANSWER_TOKENS, see docs/deploy.md); {home} passes it on and keeps nothing. Runs and workflows still take their answers.
                </p>
              )}
              {err && <p className="settings-hint error">{err}</p>}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

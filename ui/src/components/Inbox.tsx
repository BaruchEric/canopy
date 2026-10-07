import { useEffect, useRef, useState } from "react";
import { escapeCloses } from "../surface";
import { useShallow } from "zustand/react/shallow";
import type { AdviceOffer, Ask } from "../../../src/core/types";
import { joinTarget } from "../agentcards";
import { api } from "../api";
import { rememberOffer } from "../../../src/core/offer";
import { ruleWords, scopeWords } from "../../../src/core/shellwords";
import { askWord, detailText, endingWord, inboxTick, inboxTitle, leftWord, recentAsks, scopeOffers, type InboxAnswer, type InboxItem } from "../inbox";
import { useFitPop } from "../pop";
import { qual } from "../registry";
import { INBOX_TEXT } from "../settings";
import { canAnswer as canAnswerHere, inboxItems, useStore } from "../store";
import { Gear, type GearEntry, type GearGroup } from "./Gear";
import { PermissionForm, plainWords, Questions, useCommandView, type RememberChoice } from "./Prompts";
import { useZoom, zoomStyle } from "./Surface";

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

const KIND_GLYPH: Record<InboxItem["kind"], string> = { permission: "⚿", question: "?", proposal: "≡", guard: "⛨", gate: "⏸", clarify: "✎", park: "⏸", advice: "↺", "hand-off": "⇪" };
const SOURCE_WORD: Record<InboxItem["source"], string> = { ask: "agent", run: "run", flow: "workflow", sprout: "incubator", advice: "incubator" };

/** The retro lessons on offer, each with its own accept and dismiss.
 *  Accepting never edits anything itself: it opens a chat on canopy's own
 *  checkout with the lesson in its message box, unsent, or opens the user's
 *  own workflow file. Dismissing takes it off offer until it comes up three
 *  more times. */
function AdviceOffers({ offers, busy, onAnswer }: { offers: readonly AdviceOffer[]; busy: boolean; onAnswer: (key: string, accept: boolean) => void }) {
  return (
    <ul className="advice-list">
      {offers.map((o) => (
        <li key={o.key} className="advice-offer">
          <div className="eyebrow">
            {o.key}
            {o.file ? <span className="dim"> · {o.file}</span> : null}
          </div>
          <p className="advice-lesson">{o.lesson}</p>
          <p className="settings-hint">
            {o.count === 1 ? "1 project" : `${o.count} projects`}: {o.titles.join(", ")}
          </p>
          {o.edit && (
            <details className="advice-edit">
              <summary>the edit it proposes</summary>
              <pre className="ask-detail">{o.edit}</pre>
            </details>
          )}
          <div className="ask-row">
            <button
              type="button"
              className="mini strong"
              disabled={busy}
              title="Opens a chat on canopy's own checkout with this lesson and its edit in the message box. Nothing runs until you read it and send it, and the chat then runs with yolo off under your usual permission rules. Advice on a workflow of your own opens that file instead"
              onClick={() => onAnswer(o.key, true)}
            >
              accept
            </button>
            <span className="spacer" />
            <button type="button" className="mini" disabled={busy} title="Off offer until three more projects give it" onClick={() => onAnswer(o.key, false)}>
              dismiss
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Where an accepted lesson on the user's own workflow went: opened on this
 *  backend's desktop, or the path to open by hand, with the edit to make. */
function AdviceFile() {
  const file = useStore((s) => s.adviceFile);
  if (!file) return null;
  return (
    <div className="ask advice-file">
      <div className="eyebrow">{file.opened ? "opened" : "open this file"}</div>
      <pre className="ask-detail">{file.path}</pre>
      {file.edit && <pre className="ask-detail">{file.edit}</pre>}
      <div className="ask-row">
        <span className="spacer" />
        <button type="button" className="mini" onClick={() => useStore.setState({ adviceFile: null })}>
          done
        </button>
      </div>
    </div>
  );
}

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

  const heading =
    item.kind === "proposal"
      ? "the proposed plan"
      : item.source === "ask"
        ? `${item.who} ${item.kind === "guard" ? "hit a guard; it waits for you" : "wants to run"}`
        : `${item.who} wants to run`;
  const detail = item.source === "ask" ? detailText(item.detail) : item.detail;
  const view = useCommandView();
  const permission = item.permission;
  const root = item.repoPath ?? card?.cwd ?? undefined;
  const explain = permission ? plainWords(permission, root) : undefined;
  // a remember answers a run's permission only (an ask's hook has its own
  // "allow always"), and only the one the server would take: never outside
  // the project, never a codex escalation or a stage run (noRule)
  const offer = item.source === "run" && permission ? rememberOffer(permission, root) : null;
  const remember: RememberChoice | undefined = offer
    ? { offer, scopes: scopeOffers(item), onRemember: (r) => answer({ behavior: "allow", remember: r }) }
    : undefined;

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
          ) : item.kind === "advice" ? (
            <AdviceOffers offers={item.advice ?? []} busy={busy} onAnswer={(key, accept) => answer({ advice: key, accept })} />
          ) : item.kind === "hand-off" ? (
            <div className="ask">
              <div className="eyebrow">
                {item.repo} {item.title}
              </div>
              {detail && <pre className="ask-detail">{detail}</pre>}
              <div className="ask-row">
                <button
                  type="button"
                  className="mini strong"
                  disabled={busy}
                  title="canopy pushes this commit to the branch on GitHub; the repo's CI and preview builds run on it"
                  onClick={() => answer({ handOff: true })}
                >
                  push the branch
                </button>
                <span className="spacer" />
                <button type="button" className="mini" disabled={busy} title="Nothing is pushed; the project parks until you resume it" onClick={() => answer({ handOff: false })}>
                  decline
                </button>
              </div>
            </div>
          ) : item.kind === "gate" || item.kind === "park" ? (
            <div className="ask">
              <div className="eyebrow">{item.who} {item.title}</div>
              {detail && <pre className="ask-detail">{detail}</pre>}
              <div className="ask-row">
                <button
                  type="button"
                  className="mini strong"
                  disabled={busy}
                  title={
                    item.budget
                      ? "The budget is spent; this lets one more step run, then it parks again"
                      : item.stage
                        ? `The stage runner was not answering; this runs the ${item.stageCheck ? "check" : "step"} again, and it parks again if the runner is still away`
                        : undefined
                  }
                  onClick={() => answer({ choice: "continue" })}
                >
                  {item.budget ? "allow one more step" : item.stage ? (item.stageCheck ? "run the check again" : "run the step again") : "continue"}
                </button>
                {!item.budget && !item.stage && (
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
          ) : item.kind === "proposal" ? (
            // answered in the run sheet only, where the whole plan shows
            <div className="ask">
              <div className="eyebrow">{heading}</div>
              {detail && <pre className="ask-detail">{detail}</pre>}
              <p className="settings-hint">Open the run to read the whole plan, then approve it or send it back.</p>
            </div>
          ) : item.questions?.length ? (
            <Questions
              key={item.promptId ?? item.key}
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
              key={item.promptId ?? item.key}
              heading={heading}
              detail={item.source === "ask" && permission?.command ? permission.command : detail}
              busy={busy}
              view={view}
              {...(explain ? { explain } : {})}
              {...(remember ? { remember } : {})}
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
            {item.source !== "ask" && item.source !== "advice" && (
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
  const { zoom, entry: zoomEntry } = useZoom("inbox");
  const gear = useInboxGear(zoomEntry);
  useFitPop(ref, open, zoom);

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    // the rules a remember kept, read fresh: another device may have added some
    void useStore.getState().loadRemembered();
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      // the gear's menu sits in a portal outside the inbox; a click in it stays in
      if (!(t instanceof Node) || (t instanceof Element && t.closest(".gear-pop"))) return;
      if (!ref.current?.contains(t)) closeInbox();
    };
    const onKey = (e: KeyboardEvent) => {
      escapeCloses(e, () => closeInbox());
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
        <div className="settings-pop inbox-pop" role="dialog" aria-label="Waiting on you" style={zoom === 1 ? undefined : { width: Math.round(460 * zoom) }}>
          <div className="inbox-top">
            <h3 className="panel-label">waiting on you</h3>
            <Gear
              label="the inbox"
              hint="Zoom, the command's text, and the rules you remembered"
              groups={gear}
              keptElse="the rules are the backend's, for every screen"
            />
          </div>
          <div className="inbox-zoom" style={zoomStyle(zoom)}>
          <section className="settings-row">
            {goneFocus && <GoneAsk id={goneFocus} />}
            <AdviceFile />
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
        </div>
      )}
    </div>
  );
}

/** The inbox's gear: its zoom; the raw command's text size, wrap and fold;
 *  and every shown backend's remembered rules, each with a forget. */
function useInboxGear(zoom: GearEntry): GearGroup[] {
  const { text, wrap, fold } = useCommandView();
  const setSetting = useStore((s) => s.setSetting);
  const remembered = useStore((s) => s.remembered);
  const order = useStore(useShallow((s) => s.backendOrder));
  const forgetRemembered = useStore((s) => s.forgetRemembered);
  const several = order.filter((b) => (remembered[b]?.length ?? 0) > 0).length > 1;
  const rules = order.flatMap((b) =>
    (remembered[b] ?? []).map(
      (r): GearEntry => ({
        type: "forget",
        label: ruleWords(r.rule),
        sub: `${scopeWords(r.scope)}${several ? ` · ${b}` : ""}`,
        title: [r.rule, r.from ? `first for: ${r.from}` : "", r.by ? `by ${r.by}` : ""].filter(Boolean).join("\n"),
        forget: () => forgetRemembered(b, r.id).then(() => `Forgot ${r.rule}: it asks again`),
      }),
    ),
  );
  return [
    { label: "inbox", entries: [zoom] },
    {
      label: "the command",
      entries: [
        {
          type: "zoom",
          label: "text",
          what: "command text",
          value: `${text}px`,
          less: text > INBOX_TEXT.min ? () => setSetting("inboxText", text - 1) : null,
          more: text < INBOX_TEXT.max ? () => setSetting("inboxText", text + 1) : null,
          reset: text !== INBOX_TEXT.size ? () => setSetting("inboxText", INBOX_TEXT.size) : null,
          home: `${INBOX_TEXT.size}px`,
        },
        { type: "item", label: "wrap long lines", on: wrap, stay: true, run: () => setSetting("inboxWrap", true) },
        { type: "item", label: "one line, scroll sideways", on: !wrap, stay: true, run: () => setSetting("inboxWrap", false) },
        { type: "item", label: "folded at first", on: fold, stay: true, title: "Under the plain words, the raw command starts folded", run: () => setSetting("inboxFold", true) },
        { type: "item", label: "always shown", on: !fold, stay: true, run: () => setSetting("inboxFold", false) },
      ],
    },
    {
      label: "remembered rules",
      entries: rules.length ? rules : [{ type: "note", label: "Nothing remembered yet. Allow and remember, on a run's request, keeps a rule here." }],
    },
  ];
}

import { useEffect, useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { explainPrompt, FLAG_WORDS, type Explained } from "../../../src/core/explain";
import { rememberOffer } from "../../../src/core/offer";
import { ruleWords, type RuleOffer } from "../../../src/core/shellwords";
import type { Harness, PermissionAsk, RememberAsk, RunAnswer, RunPrompt, RunQuestion } from "../../../src/core/types";
import type { ScopeOffer } from "../inbox";
import { agentWord } from "../runs";
import { INBOX_TEXT } from "../settings";
import { useStore } from "../store";

/* ---------- prompts: permission and questions, a run's and the inbox's ---------- */

/** A permission in plain words: the agent's own, when it gave some, and
 *  canopy's reading of the command with its flags. */
export interface PlainWords extends Explained {
  description?: string;
}

/** How a raw command shows, off the inbox's gear. */
export interface CommandView {
  /** text size, px */
  text: number;
  wrap: boolean;
  /** folded under the plain words at first */
  fold: boolean;
}

const DEFAULT_VIEW: CommandView = { text: INBOX_TEXT.size, wrap: true, fold: true };

/** the command view the settings hold */
export function useCommandView(): CommandView {
  return useStore(useShallow((s) => ({ text: s.settings.inboxText, wrap: s.settings.inboxWrap, fold: s.settings.inboxFold })));
}

/** What a remember offers: the rules (narrowest last), the scopes (the
 *  default first), and what saving one does. */
export interface RememberChoice {
  offer: RuleOffer;
  scopes: ScopeOffer[];
  onRemember: (r: RememberAsk) => void;
}

/** A permission's plain words, with the agent's own when it gave some. */
export function plainWords(p: PermissionAsk, root?: string): PlainWords {
  const read = explainPrompt(p, root);
  return p.description ? { ...read, description: p.description } : read;
}

const sentence = (s: string): string => (s ? `${s[0]?.toUpperCase()}${s.slice(1)}` : s);

/** The plain words over a raw command: the agent's line, canopy's reading,
 *  and what deserves a second look. */
function Explanation({ explain }: { explain: PlainWords }) {
  return (
    <div className="ask-explain">
      {explain.description ? (
        <>
          <p className="ask-says">{explain.description}</p>
          <p className="ask-reads">
            <span className="ask-by">canopy's reading:</span> {explain.says}
          </p>
        </>
      ) : (
        <p className="ask-says">{sentence(explain.says)}</p>
      )}
      {explain.flags.length > 0 && (
        <ul className="ask-flags" aria-label="Worth a second look">
          {explain.flags.map((f) => (
            <li key={f} className={`ask-flag f-${f}`}>
              {FLAG_WORDS[f]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The raw command or input, always there; under plain words it can fold. */
function RawCommand({ detail, view, foldable }: { detail: string; view: CommandView; foldable: boolean }) {
  const [open, setOpen] = useState(!(foldable && view.fold));
  // the gear's fold setting applies to what is already showing, too
  useEffect(() => setOpen(!(foldable && view.fold)), [foldable, view.fold]);
  const pre = (
    <pre className={`ask-detail${view.wrap ? "" : " nowrap"}`} style={view.text === INBOX_TEXT.size ? undefined : { fontSize: view.text }}>
      {detail}
    </pre>
  );
  if (!foldable) return pre;
  const lines = detail.split("\n").length;
  return (
    <div className="ask-raw">
      <button type="button" className="ask-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> {open ? "hide the command" : "show the command"}
        <span className="ask-size">{lines > 1 ? `${lines} lines` : `${detail.length} characters`}</span>
      </button>
      {open && pre}
    </div>
  );
}

/** Allow and keep a rule: the exact rule, narrowed if the user likes, and
 *  where it applies, both shown before anything is saved. */
function RememberPanel({ remember, busy, onCancel }: { remember: RememberChoice; busy: boolean; onCancel: () => void }) {
  const { offer, scopes, onRemember } = remember;
  const name = useId();
  const [rule, setRule] = useState(offer.rules[offer.pick] ?? offer.rules[0] ?? "");
  const [scope, setScope] = useState<RememberAsk["scope"]>(scopes[0]?.kind ?? "repo");
  const where = scopes.find((s) => s.kind === scope)?.label ?? "";
  return (
    <div className="ask-remember" role="group" aria-label="Allow and remember">
      <div className="eyebrow">allow and remember</div>
      {offer.chain && (
        <p className="ask-warn">
          This chains several commands. A rule for one command never matches a chain, so only "any shell command" would stop this asking. That rule lets
          through every command in this scope, chains included, unless canopy sees it leave the project (a cd away, a path outside).
        </p>
      )}
      <fieldset className="ask-choice">
        <legend>{offer.rules.length > 1 ? "the rule, broadest first: narrow it here" : "the rule"}</legend>
        {offer.rules.map((r) => (
          <label key={r} className={`ask-opt${r === rule ? " on" : ""}`}>
            <input type="radio" name={`${name}-rule`} checked={r === rule} onChange={() => setRule(r)} />
            <span className="ask-opt-text">
              <code>{r}</code>
              <span className="ask-opt-words">{ruleWords(r)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="ask-choice">
        <legend>where it applies</legend>
        {scopes.map((s) => (
          <label key={s.kind} className={`ask-opt${s.kind === scope ? " on" : ""}`}>
            <input type="radio" name={`${name}-scope`} checked={s.kind === scope} onChange={() => setScope(s.kind)} />
            <span>{s.label}</span>
          </label>
        ))}
      </fieldset>
      <p className="settings-hint">
        From now on canopy allows {ruleWords(rule)} without asking, for {where}. The inbox's ⚙ lists the rules and forgets them.
      </p>
      <div className="ask-row">
        <button type="button" className="mini strong" disabled={busy || !rule} onClick={() => onRemember({ rule, scope })}>
          allow and remember
        </button>
        <span className="spacer" />
        <button type="button" className="mini" disabled={busy} onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  );
}

/**
 * A permission waiting on the human: what the agent wants to run, then
 * allow, the "always" choice when there is one, and deny. With
 * `denyMessage`, deny takes an optional line the agent is told (an ask
 * carries it to the hook; a run's deny has none).
 */
export function PermissionForm({
  heading,
  detail,
  onAllow,
  always,
  onDeny,
  denyMessage = false,
  busy = false,
  explain,
  view = DEFAULT_VIEW,
  remember,
}: {
  heading: string;
  detail: string;
  onAllow: () => void;
  /** the second allow: "allow all for this run", "allow always" */
  always?: { label: string; title: string; onClick: () => void };
  onDeny: (message?: string) => void;
  denyMessage?: boolean;
  /** an answer on its way: every button waits */
  busy?: boolean;
  /** the request in plain words, over the raw command */
  explain?: PlainWords;
  /** how the raw command shows: text size, wrap, folded at first */
  view?: CommandView;
  /** a run's permission: allow and keep a rule, so the same asks no more */
  remember?: RememberChoice;
}) {
  const [message, setMessage] = useState("");
  const [why, setWhy] = useState(false);
  const [keeping, setKeeping] = useState(false);
  return (
    <div className="ask">
      <div className="eyebrow">{heading}</div>
      {explain && <Explanation explain={explain} />}
      {/* folds only under a reading of canopy's own; "runs frobnicate" says too little */}
      {detail && <RawCommand detail={detail} view={view} foldable={explain !== undefined && !explain.vague} />}
      {remember && keeping && <RememberPanel remember={remember} busy={busy} onCancel={() => setKeeping(false)} />}
      {denyMessage && why && (
        <input
          type="text"
          className="other"
          placeholder="why not, for the agent (optional)"
          value={message}
          autoFocus
          aria-label="Why the request is denied"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onDeny(message.trim() || undefined);
          }}
        />
      )}
      <div className="ask-row">
        <button type="button" className="mini strong" disabled={busy} onClick={onAllow}>
          allow
        </button>
        {remember && !keeping && (
          <button type="button" className="mini" disabled={busy} title="Allow it, and keep a rule so the same kind of request stops asking" onClick={() => setKeeping(true)}>
            allow and remember…
          </button>
        )}
        {always && (
          <button type="button" className="mini" disabled={busy} title={always.title} onClick={always.onClick}>
            {always.label}
          </button>
        )}
        <span className="spacer" />
        {denyMessage && !why && (
          <button type="button" className="mini" disabled={busy} title="Deny with a line the agent is told" onClick={() => setWhy(true)}>
            deny with a reason…
          </button>
        )}
        <button type="button" className="mini" disabled={busy} onClick={() => onDeny(denyMessage ? message.trim() || undefined : undefined)}>
          deny
        </button>
      </div>
    </div>
  );
}

/** A run's own prompt, as its console shows it: allow, allow all for the
 *  rest of the run, deny; or the agent's questions. Every answer names the
 *  prompt it was given on, and the form starts over when another prompt
 *  takes its place, so a remember half done on one is never saved on the
 *  next (the server refuses a prompt id that is not the one waiting). */
export function RunPromptForm({
  prompt,
  harness,
  onAnswer,
  root,
  scopes,
}: {
  prompt: RunPrompt;
  /** whose prompt it is, for its heading */
  harness: Harness;
  onAnswer: (a: RunAnswer, promptId: string) => void;
  /** the run's project folder, for "outside the project" */
  root?: string;
  /** the scopes a remember offers; none, no remember */
  scopes?: ScopeOffer[];
}) {
  const view = useCommandView();
  const id = prompt.id;
  if (prompt.kind === "permission") {
    const offer = rememberOffer(prompt, root);
    return (
      <PermissionForm
        key={id}
        heading={`${agentWord(harness)} wants to run`}
        detail={prompt.detail}
        explain={plainWords(prompt, root)}
        view={view}
        {...(offer && scopes?.length ? { remember: { offer, scopes, onRemember: (remember: RememberAsk) => onAnswer({ kind: "allow", remember }, id) } } : {})}
        onAllow={() => onAnswer({ kind: "allow" }, id)}
        always={{ label: "allow all for this run", title: "Every later request in this run passes without asking", onClick: () => onAnswer({ kind: "allow-all" }, id) }}
        onDeny={() => onAnswer({ kind: "deny" }, id)}
      />
    );
  }
  // the proposal form lands with the plan UI; until then the plan reads as text
  if (prompt.kind === "proposal") return <pre key={id}>{prompt.plan}</pre>;
  return <Questions key={id} questions={prompt.questions} who={agentWord(harness)} onAnswer={(answers) => onAnswer({ kind: "answers", answers }, id)} />;
}

/**
 * An agent's questions: each one's options (one or several), a box for
 * something else, and answer once every question has one. `onDecline`,
 * when given, is the way out without answering (an ask's hook then tells
 * the agent the user declined).
 */
export function Questions({
  questions,
  who,
  onAnswer,
  onDecline,
  declineLabel,
  declineTitle,
  busy = false,
}: {
  questions: RunQuestion[];
  /** the agent's word, for the heading */
  who: string;
  onAnswer: (answers: Record<string, string>) => void;
  onDecline?: () => void;
  /** the decline button's word and tooltip; "decline" by default */
  declineLabel?: string;
  declineTitle?: string;
  busy?: boolean;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const answerFor = (q: RunQuestion): string => {
    const free = other[q.question]?.trim();
    const chosen = picked[q.question] ?? [];
    return [...chosen, ...(free ? [free] : [])].join(", ");
  };
  const complete = questions.every((q) => answerFor(q).length > 0);

  const toggle = (q: RunQuestion, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : cur.includes(label)
          ? []
          : [label];
      return { ...p, [q.question]: next };
    });

  const submit = () => {
    if (!complete || busy) return;
    onAnswer(Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])));
  };

  return (
    <div className="ask">
      <div className="eyebrow">{who} asks</div>
      {questions.map((q) => (
        <div key={q.question} className="question">
          <p className="q-text">
            {q.header && <span className="branch">{q.header}</span>}
            {q.question}
          </p>
          <div className="options" role={q.multiSelect ? "group" : "radiogroup"}>
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  role={q.multiSelect ? "checkbox" : "radio"}
                  aria-checked={on}
                  className={on ? "option on" : "option"}
                  onClick={() => toggle(q, o.label)}
                >
                  <span className="opt-label">{o.label}</span>
                  {o.description && <span className="opt-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            className="other"
            placeholder="something else…"
            value={other[q.question] ?? ""}
            onChange={(e) => setOther((p) => ({ ...p, [q.question]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            aria-label={`Another answer to: ${q.question}`}
          />
        </div>
      ))}
      <div className="ask-row">
        <button type="button" className="mini strong" disabled={!complete || busy} onClick={submit}>
          answer
        </button>
        {onDecline && (
          <>
            <span className="spacer" />
            <button type="button" className="mini" disabled={busy} title={declineTitle ?? "Leave it unanswered: the agent is told you declined"} onClick={onDecline}>
              {declineLabel ?? "decline"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

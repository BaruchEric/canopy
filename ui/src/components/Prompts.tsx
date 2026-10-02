import { useState } from "react";
import type { Harness, RunAnswer, RunPrompt, RunQuestion } from "../../../src/core/types";
import { agentWord } from "../runs";

/* ---------- prompts: permission and questions, a run's and the inbox's ---------- */

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
}) {
  const [message, setMessage] = useState("");
  const [why, setWhy] = useState(false);
  return (
    <div className="ask">
      <div className="eyebrow">{heading}</div>
      {detail && <pre className="ask-detail">{detail}</pre>}
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
 *  rest of the run, deny; or the agent's questions. */
export function RunPromptForm({
  prompt,
  harness,
  onAnswer,
}: {
  prompt: RunPrompt;
  /** whose prompt it is, for its heading */
  harness: Harness;
  onAnswer: (a: RunAnswer) => void;
}) {
  if (prompt.kind === "permission") {
    return (
      <PermissionForm
        heading={`${agentWord(harness)} wants to run`}
        detail={prompt.detail}
        onAllow={() => onAnswer({ kind: "allow" })}
        always={{ label: "allow all for this run", title: "Every later request in this run passes without asking", onClick: () => onAnswer({ kind: "allow-all" }) }}
        onDeny={() => onAnswer({ kind: "deny" })}
      />
    );
  }
  return <Questions questions={prompt.questions} who={agentWord(harness)} onAnswer={(answers) => onAnswer({ kind: "answers", answers })} />;
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

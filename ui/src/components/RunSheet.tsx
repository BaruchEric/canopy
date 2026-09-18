import { useEffect, useRef, useState } from "react";
import { ACTIONS, repoFacts } from "../../../src/core/actions";
import { describeAgent, isDefaultAgent } from "../../../src/core/agent";
import { agentFor, useStore, type Sheet } from "../store";
import { SearchSheet } from "./Search";
import {
  DEFAULT_AGENT,
  isRunActive,
  type AgentEffort,
  type AgentModel,
  type AgentSettings,
  type Repo,
  type Run,
  type RunAction,
  type RunAnswer,
  type RunPrompt,
  type RunQuestion,
  type RunStep,
} from "../../../src/core/types";
import { Seg } from "./Seg";

const STATUS_WORD: Record<Run["status"], string> = {
  working: "working",
  waiting: "waiting for you",
  idle: "your turn",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Re-renders once a second while `on`, for the elapsed clock. */
function useTick(on: boolean): number {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
  return Date.now();
}

/* ---------- the modal frame ---------- */

export function RunSheet() {
  const sheet = useStore((s) => s.sheet);
  const close = useStore((s) => s.closeSheet);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    // Focus lands inside, so the keyboard user is in the dialog, not behind it.
    ref.current
      ?.querySelector<HTMLElement>("input[type=search], textarea, button:not(.close)")
      ?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, close]);

  if (!sheet) return null;
  return (
    <div className="sheet-back" onPointerDown={(e) => {
      if (e.target === e.currentTarget) close();
    }}>
      <div
        ref={ref}
        className={sheet.kind === "search" ? "sheet wide" : "sheet"}
        role="dialog"
        aria-modal="true"
      >
        <Body sheet={sheet} />
      </div>
    </div>
  );
}

/** The repo a sheet is about: named outright, or through its run. */
const sheetRepoId = (sheet: Sheet, runs: Record<string, Run>): string | undefined =>
  sheet.kind === "run"
    ? runs[sheet.runId]?.repoId
    : sheet.kind === "plan" || sheet.kind === "agent" || sheet.kind === "flow-plan"
      ? sheet.repoId
      : undefined;

function Body({ sheet }: { sheet: Sheet }) {
  const close = useStore((s) => s.closeSheet);
  const repo = useStore((s) => s.repos.find((r) => r.id === sheetRepoId(sheet, s.runs)));
  const run = useStore((s) => (sheet.kind === "run" ? s.runs[sheet.runId] : undefined));

  if (sheet.kind === "plan") {
    if (!repo) return <Missing what="That repo is no longer in the tree." onClose={close} />;
    return <Plan repo={repo} action={sheet.action} />;
  }
  if (sheet.kind === "search") return <SearchSheet />;
  if (sheet.kind === "agent") {
    if (!repo) return <Missing what="That repo is no longer in the tree." onClose={close} />;
    return <AgentForm repo={repo} />;
  }
  if (!run) return <Missing what="That run is gone." onClose={close} />;
  return <Console run={run} repo={repo} />;
}

function Missing({ what, onClose }: { what: string; onClose: () => void }) {
  return (
    <>
      <p className="sheet-empty">{what}</p>
      <footer className="sheet-foot">
        <span className="spacer" />
        <button type="button" className="mini" onClick={onClose}>
          close
        </button>
      </footer>
    </>
  );
}

/* ---------- pre-flight ---------- */

function Plan({ repo, action }: { repo: Repo; action: RunAction }) {
  const close = useStore((s) => s.closeSheet);
  const startRun = useStore((s) => s.startRun);
  const agent = useStore((s) => agentFor(s, repo));
  const spec = ACTIONS[action];
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !busy && (!spec.noteRequired || note.trim().length > 0);

  const go = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await startRun(repo.id, action, note);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude</div>
          <h2 className="sheet-title">
            {spec.verb} <span className="sheet-repo">{repo.id}</span>
          </h2>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="sheet-body plan">
        <div className="facts">
          {repoFacts(repo).map((f) => (
            <span key={f} className="branch">
              {f}
            </span>
          ))}
          {!isDefaultAgent(agent) && (
            <span className="branch" title="This repo's agent settings">
              {describeAgent(agent)}
            </span>
          )}
        </div>
        <p className="blurb">{spec.blurb}</p>
        <textarea
          className="plan-note"
          rows={spec.noteRequired ? 5 : 3}
          placeholder={spec.notePlaceholder}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go();
          }}
          aria-label={spec.noteRequired ? "What Claude should do" : "Note for Claude"}
        />
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">
          {agent.yolo
            ? "Yolo is on for this repo: Claude runs without asking."
            : "Claude asks before running anything that is not part of the job."}
        </span>
        <button type="button" className="mini" onClick={close}>
          cancel
        </button>
        <button
          type="button"
          className="mini strong"
          disabled={!ready}
          title="⌘↩"
          onClick={() => void go()}
        >
          {busy ? "starting…" : spec.verb}
        </button>
      </footer>
    </>
  );
}

/* ---------- the console ---------- */

function Console({ run, repo }: { run: Run; repo: Repo | undefined }) {
  const close = useStore((s) => s.closeSheet);
  const stopRun = useStore((s) => s.stopRun);
  const dismissRun = useStore((s) => s.dismissRun);
  const answerRun = useStore((s) => s.answerRun);
  const sayRun = useStore((s) => s.sayRun);
  const active = isRunActive(run);
  const chat = run.chat;
  const noChange = run.status === "done" && run.outcome === "unchanged" && run.expectsChange;
  const now = useTick(active);
  const elapsed = (run.endedAt ?? now) - run.startedAt;
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  // Follow the newest step unless the reader has scrolled up to study
  // something; a jump while they read would lose their place.
  useEffect(() => {
    const el = list.current;
    if (!el || !stuck.current) return;
    el.scrollTop = el.scrollHeight;
  }, [run.steps.length, run.prompt, run.status]);

  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    }
  };

  // Claude's closing words arrive twice, as the last message and as the
  // result. The outcome box shows them once. A chat has no outcome box: its
  // replies stay in the timeline.
  const last = run.steps[run.steps.length - 1];
  const steps =
    !chat && run.result && last?.kind === "text" && last.text === run.result.text
      ? run.steps.slice(0, -1)
      : run.steps;

  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude</div>
          <h2 className="sheet-title">
            {run.verb} <span className="sheet-repo">{run.repoId}</span>
          </h2>
        </div>
        <span className={`status st-${run.status}${noChange ? " no-change" : ""}`}>
          <span className="dot" />
          {noChange ? "done, nothing changed" : STATUS_WORD[run.status]}
        </span>
        <span className="clock" title="elapsed">
          {mmss(elapsed)}
        </span>
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>

      <div
        ref={list}
        className="sheet-body console"
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {run.note && (
          <p className="run-note">
            <span className="eyebrow">your note</span>
            {run.note}
          </p>
        )}
        <ol className="steps">
          {steps.map((s) => (
            <Step key={s.id} step={s} />
          ))}
          {run.status === "working" && run.steps.length === 0 && (
            <li className="step k-note">
              <span className="node" />
              <span className="step-text">starting Claude Code in {repo?.path ?? run.repoId}…</span>
            </li>
          )}
          {run.status === "working" && run.steps.length > 0 && (
            <li className="step k-note thinking">
              <span className="node" />
              <span className="step-text">thinking…</span>
            </li>
          )}
          {chat && run.status === "idle" && run.steps.length === 0 && (
            <li className="step k-note">
              <span className="node" />
              <span className="step-text">
                Your first message starts Claude Code in {repo?.path ?? run.repoId}.
              </span>
            </li>
          )}
        </ol>
        {run.prompt && (
          <Prompt
            prompt={run.prompt}
            onAnswer={(a) => void act(() => answerRun(run.id, run.prompt?.id ?? "", a))}
          />
        )}
        {run.result && run.status === "done" && !chat && (
          <div className={noChange ? "outcome warn" : "outcome ok"}>
            {noChange && (
              <p className="outcome-lead">
                git status is the same as before this run, so the card still shows the repo as it was.
              </p>
            )}
            <p>{run.result.text || "Done."}</p>
          </div>
        )}
        {chat && run.status === "done" && (
          <div className="outcome dim">
            <p>Chat ended.</p>
          </div>
        )}
        {run.status === "failed" && (
          <div className="outcome err">
            <p>{run.error ?? "The run failed."}</p>
            {run.result?.text && run.result.text !== run.error && <p>{run.result.text}</p>}
          </div>
        )}
        {run.status === "stopped" && <div className="outcome dim"><p>Stopped. Whatever Claude had already done stays done.</p></div>}
        {noChange && !active && (
          <p className="sheet-hint followup-hint">
            Reopen the ⋯ menu to start another run, or ask Claude in a terminal to handle it.
          </p>
        )}
        {error && <p className="note err">{error}</p>}
      </div>

      {chat && active && (
        <Composer
          ready={run.status === "idle"}
          onSend={(text) => act(() => sayRun(run.id, text))}
        />
      )}

      <footer className="sheet-foot">
        {run.result && (
          <span className="sheet-hint">
            {run.result.turns} turn{run.result.turns === 1 ? "" : "s"} ·{" "}
            {mmss(run.result.durationMs)} · ${run.result.costUsd.toFixed(2)}
          </span>
        )}
        <span className="spacer" />
        {active ? (
          <button
            type="button"
            className="mini"
            title={chat && run.status === "idle" ? "Close the conversation; Claude Code exits" : undefined}
            onClick={() => void act(() => stopRun(run.id))}
          >
            {chat && run.status === "idle" ? "end chat" : "stop"}
          </button>
        ) : (
          <button type="button" className="mini" onClick={() => void act(() => dismissRun(run.id))}>
            dismiss
          </button>
        )}
        <button type="button" className="mini strong" onClick={close}>
          {active ? "hide" : "close"}
        </button>
      </footer>
    </>
  );
}

/** The chat's message box. Enter sends, shift-enter breaks a line. */
function Composer({
  ready,
  onSend,
}: {
  ready: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const can = ready && !busy && text.trim().length > 0;

  // Back to the box as soon as Claude has answered.
  useEffect(() => {
    if (ready) box.current?.focus();
  }, [ready]);

  const send = async () => {
    if (!can) return;
    const message = text;
    setBusy(true);
    setText("");
    try {
      await onSend(message);
    } catch {
      setText(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={box}
        className="composer-box"
        rows={2}
        placeholder={ready ? "say something…" : "Claude is replying…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        aria-label="Your message"
      />
      <button
        type="button"
        className="mini strong"
        disabled={!can}
        title="↩ sends, shift-↩ for a new line"
        onClick={() => void send()}
      >
        send
      </button>
    </div>
  );
}

function Step({ step }: { step: RunStep }) {
  if (step.kind === "tool" && step.tool) {
    const t = step.tool;
    return (
      <li className={`step k-tool st-${t.status}`}>
        <span className="node" />
        <div className="step-body">
          <code className="step-title">{t.title}</code>
          {t.output && (
            <details className="step-out">
              <summary>{t.status === "error" ? "error" : "output"}</summary>
              <pre>{t.output}</pre>
            </details>
          )}
        </div>
      </li>
    );
  }
  if (step.kind === "user") {
    return (
      <li className="step k-user">
        <span className="node" />
        <div className="step-body">
          <span className="eyebrow">you</span>
          <span className="step-text">{step.text}</span>
        </div>
      </li>
    );
  }
  return (
    <li className={`step k-${step.kind}`}>
      <span className="node" />
      <span className="step-text">{step.text}</span>
    </li>
  );
}

/* ---------- agent settings, per repo ---------- */

const MODELS: { value: AgentModel; label: string; title?: string }[] = [
  { value: "default", label: "default", title: "Whatever your claude picks" },
  { value: "fable", label: "fable" },
  { value: "opus", label: "opus" },
  { value: "sonnet", label: "sonnet" },
  { value: "haiku", label: "haiku" },
];

const EFFORTS: { value: AgentEffort; label: string; title?: string }[] = [
  { value: "default", label: "default", title: "Whatever your claude picks" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

const YOLO = [
  { value: "ask", label: "ask", title: "Claude asks before anything the rules do not allow" },
  {
    value: "yolo",
    label: "yolo",
    title: "Skip every permission prompt (--dangerously-skip-permissions)",
  },
] as const;

/** How Claude starts for this repo. Every change saves at once, like the
 *  settings popover; the extra-flags box saves when it loses focus or on
 *  enter, since a half-typed flag is not worth sending. */
function AgentForm({ repo }: { repo: Repo }) {
  const close = useStore((s) => s.closeSheet);
  const saved = useStore((s) => agentFor(s, repo));
  const setAgent = useStore((s) => s.setAgent);
  const [extra, setExtra] = useState(saved.extra);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setExtra(saved.extra), [saved.extra]);

  const save = async (next: AgentSettings) => {
    setError(null);
    try {
      await setAgent(repo.id, next);
    } catch (err) {
      setError(errText(err));
    }
  };
  const set = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) =>
    void save({ ...saved, [key]: value });
  const saveExtra = () => {
    if (extra.trim() !== saved.extra) set("extra", extra.trim());
  };

  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with claude</div>
          <h2 className="sheet-title">
            agent settings <span className="sheet-repo">{repo.id}</span>
          </h2>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="sheet-body agent-form">
        <p className="blurb">
          How Claude Code starts for this repo: the agent and herdr openers, and every run and
          chat here. Saved on the server, so it holds from any browser.
        </p>
        <section className="settings-row">
          <h3 className="panel-label">model</h3>
          <Seg label="Model" value={saved.model} options={MODELS} onChange={(v) => set("model", v)} />
        </section>
        <section className="settings-row">
          <h3 className="panel-label">effort</h3>
          <Seg
            label="Effort"
            value={saved.effort}
            options={EFFORTS}
            onChange={(v) => set("effort", v)}
          />
        </section>
        <section className="settings-row">
          <h3 className="panel-label">permissions</h3>
          <Seg
            label="Permissions"
            value={saved.yolo ? "yolo" : "ask"}
            options={YOLO}
            onChange={(v) => set("yolo", v === "yolo")}
          />
          {saved.yolo && (
            <p className="settings-hint warn">
              Every command runs without asking, in the terminal and in canopy's runs alike.
            </p>
          )}
        </section>
        <section className="settings-row">
          <h3 className="panel-label">extra flags</h3>
          <input
            type="text"
            className="agent-extra"
            placeholder="--add-dir ../shared --name work"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            onBlur={saveExtra}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveExtra();
            }}
            aria-label="Extra flags for the claude command line"
          />
          <p className="settings-hint">
            Appended to the claude command line as typed; quotes hold a word together.
          </p>
        </section>
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">{describeAgent(saved)}</span>
        <button
          type="button"
          className="mini"
          disabled={isDefaultAgent(saved)}
          onClick={() => void save(DEFAULT_AGENT)}
        >
          reset
        </button>
        <button type="button" className="mini strong" onClick={close}>
          done
        </button>
      </footer>
    </>
  );
}

/* ---------- prompts: permission and questions ---------- */

function Prompt({
  prompt,
  onAnswer,
}: {
  prompt: RunPrompt;
  onAnswer: (a: RunAnswer) => void;
}) {
  if (prompt.kind === "permission") {
    return (
      <div className="ask">
        <div className="eyebrow">claude wants to run</div>
        <pre className="ask-detail">{prompt.detail}</pre>
        <div className="ask-row">
          <button type="button" className="mini strong" onClick={() => onAnswer({ kind: "allow" })}>
            allow
          </button>
          <button
            type="button"
            className="mini"
            title="Every later request in this run passes without asking"
            onClick={() => onAnswer({ kind: "allow-all" })}
          >
            allow all for this run
          </button>
          <span className="spacer" />
          <button type="button" className="mini" onClick={() => onAnswer({ kind: "deny" })}>
            deny
          </button>
        </div>
      </div>
    );
  }
  return <Questions questions={prompt.questions} onAnswer={(answers) => onAnswer({ kind: "answers", answers })} />;
}

function Questions({
  questions,
  onAnswer,
}: {
  questions: RunQuestion[];
  onAnswer: (answers: Record<string, string>) => void;
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
    if (!complete) return;
    onAnswer(Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])));
  };

  return (
    <div className="ask">
      <div className="eyebrow">claude asks</div>
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
        <button type="button" className="mini strong" disabled={!complete} onClick={submit}>
          answer
        </button>
      </div>
    </div>
  );
}

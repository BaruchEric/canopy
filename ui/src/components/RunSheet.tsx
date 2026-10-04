import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ACTIONS, repoFacts } from "../../../src/core/actions";
import { describeAgent, isDefaultAgent } from "../../../src/core/agent";
import { describeLaunch, isDefaultLaunch } from "../../../src/core/launch";
import { agentFor, connOf, idText, launchFor, routesOf, tasksOf, useStore, type Sheet } from "../store";
import { backendOf } from "../registry";
import { resolveAgent } from "../../../src/core/route";
import { effectiveRows, harnessesOf, hasRouting, ROLE_LABEL, ROLE_TITLE, withPick } from "../agents";
import { EffectiveTable, PickEditor } from "./AgentForm";
import { FleetPlan, FleetSheet, FlowConsole, FlowPlan } from "./FlowSheet";
import { SearchSheet } from "./Search";
import { NewSproutSheet, SproutSheet } from "./Incubator";
import { RunPromptForm } from "./Prompts";
import { scopeOffers } from "../inbox";
import {
  AGENT_ROLES,
  DEFAULT_LAUNCH,
  isRunActive,
  type AgentRole,
  type LaunchSettings,
  type RepoAgent,
  type Repo,
  type Run,
  type RunAction,
  type RunAnswer,
  type RunStep,
} from "../../../src/core/types";
import { renameOld, taskDraftCwd, taskDraftPatch, withChange } from "../tasks";
import { AGENT_NAME, harnessOf, resultLine, tokenTitle } from "../runs";
import { HARNESS } from "../../../src/core/harness";

const STATUS_WORD: Record<Run["status"], string> = {
  working: "working",
  waiting: "waiting for you",
  idle: "your turn",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** Runs a console action, showing failures. A chat send rethrows so its
 * composer can restore the draft; buttons intentionally consume failures. */
export async function runConsoleAction(fn: () => Promise<void>, showError: (message: string) => void, propagate = false): Promise<void> {
  try {
    await fn();
  } catch (err) {
    showError(errText(err));
    if (propagate) throw err;
  }
}

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
    : sheet.kind === "plan" || sheet.kind === "agent" || sheet.kind === "launch" || sheet.kind === "task" || sheet.kind === "flow-plan"
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
    return <RepoAgentSheet repo={repo} />;
  }
  if (sheet.kind === "task") {
    if (!repo) return <Missing what="That repo is no longer in the tree." onClose={close} />;
    return <TaskForm repo={repo} name={sheet.name} />;
  }
  if (sheet.kind === "launch") {
    if (!repo) return <Missing what="That repo is no longer in the tree." onClose={close} />;
    return <LaunchForm repo={repo} />;
  }
  if (sheet.kind === "flow-plan") {
    if (!repo) return <Missing what="That repo is no longer in the tree." onClose={close} />;
    return <FlowPlan repo={repo} workflow={sheet.workflow} />;
  }
  if (sheet.kind === "new-sprout") return <NewSproutSheet />;
  if (sheet.kind === "sprout") return <SproutSheet key={sheet.id} id={sheet.id} />;
  if (sheet.kind === "flow") return <FlowConsole flowId={sheet.flowId} />;
  if (sheet.kind === "fleet-plan") return <FleetPlan workflow={sheet.workflow} />;
  if (sheet.kind === "fleet") return <FleetSheet fleetId={sheet.fleetId} />;
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
  const spec = ACTIONS[action];
  const agent = useStore((s) => agentFor(s, repo, spec.mode === "chat" ? "chat" : "job"));
  const name = AGENT_NAME[agent.harness];
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
          <div className="eyebrow">with {name}</div>
          <h2 className="sheet-title">
            {spec.verb} <span className="sheet-repo">{idText(repo.id)}</span>
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
            <span className="branch" title="The agent this repo's jobs start with">
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
          aria-label={spec.noteRequired ? `What ${name} should do` : `Note for ${name}`}
        />
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">
          {agent.yolo
            ? `Yolo is on for this repo: ${name} runs without asking.`
            : `${name} asks before running anything that is not part of the job.`}
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

/* ---------- the timeline: note, steps, the prompt, the outcome ---------- */

/** The run's timeline: note, steps, the prompt to answer, the outcome. Used
 *  by the run console and by a flow's console for the current step. */
export function Timeline({
  run,
  repo,
  error,
  onAnswer,
  extra,
}: {
  run: Run;
  repo: Repo | undefined;
  error: string | null;
  onAnswer: (a: RunAnswer) => void;
  /** rendered at the end of the same scrolling body, for a flow's step check */
  extra?: ReactNode;
}) {
  const chat = run.chat;
  const active = isRunActive(run);
  const noChange = run.status === "done" && run.outcome === "unchanged" && run.expectsChange;
  const harness = harnessOf(run);
  const list = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  // Follow the newest step unless the reader has scrolled up to study
  // something; a jump while they read would lose their place.
  useEffect(() => {
    const el = list.current;
    if (!el || !stuck.current) return;
    el.scrollTop = el.scrollHeight;
  }, [run.steps.length, run.prompt, run.status]);

  // The agent's closing words arrive twice, as the last message and as the
  // result. The outcome box shows them once. A chat has no outcome box: its
  // replies stay in the timeline.
  const last = run.steps[run.steps.length - 1];
  const steps =
    !chat && run.result && last?.kind === "text" && last.text === run.result.text
      ? run.steps.slice(0, -1)
      : run.steps;

  return (
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
            <span className="step-text">starting {AGENT_NAME[harness]} in {repo?.path ?? idText(run.repoId)}…</span>
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
              Your first message starts {AGENT_NAME[harness]} in {repo?.path ?? idText(run.repoId)}.
            </span>
          </li>
        )}
      </ol>
      {run.prompt && (
        <RunPromptForm
          prompt={run.prompt}
          harness={harness}
          onAnswer={onAnswer}
          {...(repo && !repo.host ? { root: repo.path } : {})}
          scopes={scopeOffers({ ...(run.flowStep ? { flowStep: run.flowStep } : {}), repo: repo?.name ?? idText(run.repoId), ...(repo && !repo.host ? { repoPath: repo.path } : {}) })}
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
      {run.status === "stopped" && <div className="outcome dim"><p>Stopped. Whatever {AGENT_NAME[harness]} had already done stays done.</p></div>}
      {noChange && !active && (
        <p className="sheet-hint followup-hint">
          Reopen the ⋯ menu to start another run, or ask the agent in a terminal to handle it.
        </p>
      )}
      {extra}
      {error && <p className="note err">{error}</p>}
    </div>
  );
}

/* ---------- the console ---------- */

function Console({ run, repo }: { run: Run; repo: Repo | undefined }) {
  const close = useStore((s) => s.closeSheet);
  const stopRun = useStore((s) => s.stopRun);
  const dismissRun = useStore((s) => s.dismissRun);
  const answerRun = useStore((s) => s.answerRun);
  const sayRun = useStore((s) => s.sayRun);
  const draft = useStore((s) => s.chatDrafts[run.id]);
  const active = isRunActive(run);
  const chat = run.chat;
  const noChange = run.status === "done" && run.outcome === "unchanged" && run.expectsChange;
  const now = useTick(active);
  const elapsed = (run.endedAt ?? now) - run.startedAt;
  const [error, setError] = useState<string | null>(null);

  const act = (fn: () => Promise<void>, propagate = false) => {
    setError(null);
    return runConsoleAction(fn, setError, propagate);
  };
  const harness = harnessOf(run);
  const name = AGENT_NAME[harness];

  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">
            <span className={`harness-glyph h-${harness}`} aria-hidden="true">
              {HARNESS[harness].glyph}
            </span>{" "}
            with {name}
            {run.by && <span className="run-by" title="the device that started it"> · from {run.by}</span>}
          </div>
          <h2 className="sheet-title">
            {run.verb} <span className="sheet-repo">{idText(run.repoId)}</span>
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

      <Timeline
        run={run}
        repo={repo}
        error={error}
        onAnswer={(a) => void act(() => answerRun(run.id, run.prompt?.id ?? "", a))}
      />

      {chat && active && (
        <Composer
          who={name}
          ready={run.status === "idle"}
          onSend={(text) => act(() => sayRun(run.id, text), true)}
          {...(draft ? { draft } : {})}
        />
      )}

      <footer className="sheet-foot">
        {run.result && (
          <span className="sheet-hint" title={tokenTitle(run.result) ?? undefined}>
            {resultLine(run.result)}
          </span>
        )}
        <span className="spacer" />
        {active ? (
          <button
            type="button"
            className="mini"
            title={chat && run.status === "idle" ? `Close the conversation; ${name} exits` : undefined}
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
  who,
  ready,
  onSend,
  draft = "",
}: {
  /** the agent's name, for the box's placeholder while it replies */
  who: string;
  ready: boolean;
  onSend: (text: string) => Promise<void>;
  /** what the box starts with: an accepted retro lesson, for the user to read and send */
  draft?: string;
}) {
  const [text, setText] = useState(draft);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const can = ready && !busy && text.trim().length > 0;

  // Back to the box as soon as the agent has answered.
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
      // the box stays live while a send is out, so keep what was typed since
      setText((now) => (now.trim() ? `${message}\n${now}` : message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={box}
        className="composer-box"
        // a draft is read before it is sent, so it gets room
        rows={draft ? 10 : 2}
        placeholder={ready ? "say something…" : `${who} is replying…`}
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

/* ---------- the agent override, per repo ---------- */

/** Which agent this repo starts: its row of the agents view's overrides.
 *  The whole-repo pick, a pick per role that beats it, and each role's
 *  effective harness and settings with where they came from. Every choice
 *  saves at once, on the repo's own backend. */
function RepoAgentSheet({ repo }: { repo: Repo }) {
  const close = useStore((s) => s.closeSheet);
  const backend = backendOf(repo.id);
  const routes = useStore((s) => routesOf(s, backend));
  const has = useStore((s) => harnessesOf(connOf(s, backend).backend));
  // a backend older than routing keeps one set of settings per repo
  const routing = useStore((s) => hasRouting(connOf(s, backend).backend));
  const setAgent = useStore((s) => s.setAgent);
  const [error, setError] = useState<string | null>(null);
  const current = routes.repos[repo.path] ?? {};
  const rows = useMemo(() => effectiveRows(routes, repo.path, has), [routes, repo.path, has]);

  const save = async (next: RepoAgent) => {
    setError(null);
    try {
      await setAgent(repo.id, next);
    } catch (err) {
      setError(errText(err));
    }
  };
  const seedFor = (slot: AgentRole | "all") => resolveAgent(routes, repo.path, slot === "all" ? "shell" : slot).settings;
  const shell = rows.find((r) => r.role === "shell");

  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">with an agent</div>
          <h2 className="sheet-title">
            agent routing <span className="sheet-repo">{idText(repo.id)}</span>
          </h2>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="sheet-body agent-form">
        {routing ? (
          <p className="blurb">
            Which agent this repo starts, and how: for every role at once, or per role. A pick left to inherit follows the role's route and then
            the default profile, which the agents view edits. Saved on {backend}, so it holds from any browser.
          </p>
        ) : (
          <p className="blurb">
            {backend} runs a canopy older than agent routing: it keeps one set of Claude settings per repo, with no profiles or per-role picks.
            Update it for those. Saved on {backend}, so it holds from any browser.
          </p>
        )}
        <section className="settings-row">
          <h3 className="panel-label">whole repo</h3>
          <PickEditor
            slot="all"
            pick={current.all}
            routes={routes}
            has={has}
            machine={backend}
            inherit={routing ? "inherit: the role routes" : "the defaults"}
            seed={seedFor("all")}
            profiles={routing}
            onChange={(p) => void save(withPick(current, "all", p))}
          />
        </section>
        {(routing ? AGENT_ROLES : []).map((role) => (
          <section key={role} className="settings-row">
            <h3 className="panel-label" title={ROLE_TITLE[role]}>
              {ROLE_LABEL[role]}
            </h3>
            <PickEditor
              slot={role}
              pick={current.roles?.[role]}
              routes={routes}
              has={has}
              machine={backend}
              inherit={current.all ? "inherit: the whole repo's pick" : "inherit: the role route"}
              seed={seedFor(role)}
              onChange={(p) => void save(withPick(current, role, p))}
            />
          </section>
        ))}
        <section className="settings-row">
          <h3 className="panel-label">effective</h3>
          <EffectiveTable rows={rows} />
        </section>
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">{shell ? `shells: ${shell.harness} · ${shell.line}` : ""}</span>
        <button type="button" className="mini" disabled={!routes.repos[repo.path]} onClick={() => void save({})}>
          reset
        </button>
        <button type="button" className="mini strong" onClick={close}>
          done
        </button>
      </footer>
    </>
  );
}

/* ---------- launch settings ---------- */

const LAUNCH_FIELDS: { key: keyof LaunchSettings; label: string; placeholder: string; hint: string }[] = [
  {
    key: "build",
    label: "build",
    placeholder: "bun run build · cargo build --release · cmake -B build && cmake --build build",
    hint: "Run in a pull request's worktree after the fetch, and in this checkout on build. Blank skips it.",
  },
  {
    key: "run",
    label: "run",
    placeholder: "bun run dev · ./build/bin/app · open build/App.app",
    hint: "Launches a checkout, from its root. Blank means a checkout cannot be launched, only built.",
  },
  {
    key: "asset",
    label: "release asset",
    placeholder: "*-macos-arm64.dmg",
    hint: "A glob for the release file to install on this machine. Blank picks by the platform words in the names.",
  },
  {
    key: "launch",
    label: "launch a release",
    placeholder: "open {file} · {file} --flag",
    hint: "How an installed release starts; {file} is the app or binary the download unpacked. Blank opens it the way its kind says.",
  },
];

/** Adds or edits a task: saved to this machine's overrides, or to the repo's
 *  own `.canopy/tasks.json` for a repo on this machine. */
function TaskForm({ repo, name }: { repo: Repo; name: string | null }) {
  const close = useStore((s) => s.closeSheet);
  const task = useStore((s) => (name ? tasksOf(s, repo.id).find((t) => t.name === name) : undefined));
  const saveTaskDef = useStore((s) => s.saveTaskDef);
  const [draft, setDraft] = useState({
    name: task?.name ?? "",
    cmd: task?.cmd ?? "",
    cwd: taskDraftCwd(task?.cwd),
    dev: task?.dev ?? false,
    keep: task?.keep ?? false,
    withPanel: task?.withPanel ?? false,
  });
  const [target, setTarget] = useState<"canopy" | "repo">(task?.source === "repo" && !repo.host ? "repo" : "canopy");
  const [error, setError] = useState<string | null>(null);

  const run = async (what: () => Promise<void>) => {
    setError(null);
    try {
      await what();
      close();
    } catch (err) {
      setError(errText(err));
    }
  };
  const save = () =>
    run(async () => {
      await saveTaskDef(
        repo.id,
        draft.name,
        // a hidden task stays hidden through an edit; the sheet has no box for it
        taskDraftPatch(draft, task?.hidden === true),
        target,
      );
      if (task && task.name !== draft.name) {
        const old = renameOld(task, target);
        await saveTaskDef(repo.id, task.name, old.def, old.target);
      }
    });
  const check = (key: "dev" | "keep" | "withPanel", label: string) => (
    <label className="settings-row">
      <input type="checkbox" checked={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })} /> {label}
    </label>
  );
  const text = (key: "name" | "cmd" | "cwd", label: string, placeholder: string, hint: string) => (
    <section className="settings-row">
      <h3 className="panel-label">{label}</h3>
      <input
        type="text"
        className="agent-extra"
        placeholder={placeholder}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        aria-label={label}
      />
      <p className="settings-hint">{hint}</p>
    </section>
  );

  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">task</div>
          <h2 className="sheet-title">
            {name ? `edit ${name}` : "add a task"} <span className="sheet-repo">{idText(repo.id)}</span>
          </h2>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="sheet-body agent-form">
        {text("name", "name", "dev", "lowercase letters, digits, dot, dash and underscore")}
        {text("cmd", "command", "bun run dev", "one line, run through a login shell")}
        {text("cwd", "folder", "the repo root", "relative to the repo root")}
        {check("dev", "the dev task, the one the preview pairs with")}
        {check("keep", "keep running: restart when it fails and after a restart")}
        {check("withPanel", "start when the repo's panel opens")}
        <section className="settings-row">
          <h3 className="panel-label">save to</h3>
          <label>
            <input type="radio" checked={target === "canopy"} onChange={() => setTarget("canopy")} /> this machine
          </label>{" "}
          <label title={repo.host ? "only for a repo on this machine" : undefined}>
            <input type="radio" disabled={!!repo.host} checked={target === "repo"} onChange={() => setTarget("repo")} /> the repo, .canopy/tasks.json
          </label>
        </section>
        {task?.suggested && (
          <p className="settings-hint">
            The repo file asks for {Object.keys(task.suggested).join(" and ")}, which runs things without a click, so it waits for you.{" "}
            <button type="button" className="mini" onClick={() => void run(() => saveTaskDef(repo.id, task.name, withChange(task, { ...task.suggested }), "canopy"))}>
              accept
            </button>
          </p>
        )}
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        {task?.source === "detected" && (
          <button type="button" className="mini" onClick={() => void run(() => saveTaskDef(repo.id, task.name, withChange(task, { hidden: true }), "canopy"))}>
            hide
          </button>
        )}
        {task && task.source !== "detected" && (
          <button type="button" className="mini" onClick={() => void run(() => saveTaskDef(repo.id, task.name, null, target))}>
            delete
          </button>
        )}
        <button type="button" className="mini" onClick={close}>
          cancel
        </button>
        <button type="button" className="mini strong" disabled={!draft.name || !draft.cmd} onClick={() => void save()}>
          save
        </button>
      </footer>
    </>
  );
}

function LaunchForm({ repo }: { repo: Repo }) {
  const close = useStore((s) => s.closeSheet);
  const saved = useStore((s) => launchFor(s, repo));
  const setLaunch = useStore((s) => s.setLaunch);
  const [draft, setDraft] = useState<LaunchSettings>(saved);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(saved), [saved]);

  const save = async (next: LaunchSettings) => {
    setError(null);
    try {
      await setLaunch(repo.id, next);
    } catch (err) {
      setError(errText(err));
    }
  };
  const commit = (key: keyof LaunchSettings) => {
    const value = draft[key].trim();
    if (value !== saved[key]) void save({ ...saved, [key]: value });
  };

  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">launch</div>
          <h2 className="sheet-title">
            launch settings <span className="sheet-repo">{idText(repo.id)}</span>
          </h2>
        </div>
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="sheet-body agent-form">
        <p className="blurb">
          How this repo is built and run: its pull requests checked out here, the checkout itself,
          and the releases it publishes on GitHub. Each line runs through your login shell from the
          build's folder. Saved on the server, keyed by the repo's path.
        </p>
        {LAUNCH_FIELDS.map((f) => (
          <section key={f.key} className="settings-row">
            <h3 className="panel-label">{f.label}</h3>
            <input
              type="text"
              className="agent-extra"
              placeholder={f.placeholder}
              value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              onBlur={() => commit(f.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit(f.key);
              }}
              aria-label={f.label}
            />
            <p className="settings-hint">{f.hint}</p>
          </section>
        ))}
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">{describeLaunch(saved)}</span>
        <button
          type="button"
          className="mini"
          disabled={isDefaultLaunch(saved)}
          onClick={() => void save(DEFAULT_LAUNCH)}
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

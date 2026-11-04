import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TabRef } from "../sectiontabs";
import { ACTIONS, planWords, repoFacts } from "../../../src/core/actions";
import { describeAgent, isDefaultAgent } from "../../../src/core/agent";
import { describeLaunch, isDefaultLaunch } from "../../../src/core/launch";
import { parseIssueRef } from "../../../src/core/issue";
import { agentFor, connOf, idText, landingAll, launchFor, prsAll, routesOf, tasksOf, treeTasksOf, useStore, type Sheet } from "../store";
import { ciChip, mergeWhy, prLine, prOfRun, prWord } from "../prs";
import { branchByDefault, runLanding, stoppedLandTitle } from "../landing";
import { backendOf } from "../registry";
import { resolveAgent } from "../../../src/core/route";
import { effectiveRows, harnessesOf, hasRouting, ROLE_LABEL, ROLE_TITLE, withPick, profileNames } from "../agents";
import { EffectiveTable, PickEditor } from "./AgentForm";
import { FleetPlan, FleetSheet, FlowConsole, FlowPlan } from "./FlowSheet";
import { GroupSheet } from "./GroupSheet";
import { ApproveSheet, OverlapChip } from "./Landing";
import { ScenarioPass } from "./Scenarios";
import { SweepSheet } from "./Sweep";
import { SearchSheet } from "./Search";
import { KeysSheet } from "./Keys";
import { WorkSheet } from "./Work";
import { WorkBlock } from "./WorkBlock";
import { NewSproutSheet, SproutSheet } from "./Incubator";
import { RunPromptForm } from "./Prompts";
import { DictateButton } from "./Dictate";
import { useMentions } from "./Mentions";
import { CoordTasks, ParentLine } from "./CoordTasks";
import { coordView, isCoordinator, type CoordView } from "../coord";
import { PHONE, useMedia } from "../media";
import { scopeOffers } from "../inbox";
import {
  AGENT_ROLES,
  DEFAULT_LAUNCH,
  isRunActive,
  isFlowActive,
  type Flow,
  type AgentRole,
  type Harness,
  type LaunchSettings,
  type RepoAgent,
  type Repo,
  type Run,
  type RunAction,
  type RunAnswer,
  type RunReplay,
  type RunStep,
} from "../../../src/core/types";
import { forkLine, stepWords } from "../../../src/core/handoff";
import { branchTask, branchTaskWords, devTask as devTaskOf, renameOld, taskDraftCwd, taskDraftPatch, withChange } from "../tasks";
import { AGENT_NAME, harnessOf, hideTodoSteps, nestSteps, resultLine, settledProposal, tokenTitle, type SettledProposal } from "../runs";
import { HARNESS } from "../../../src/core/harness";
import { CENTERED } from "../pop";
import { PopGear, PopGrip, PopHere } from "./PopGrip";
import { api } from "../api";
import { openSectionElsewhere, parseRoute } from "../routes";
import { nextGap, REPLAY_SPEEDS, replayClock, replayEnd, replayTime, replayTimeline, replayView, type ReplayJumpKind, type ReplaySpeed, type ReplayTimeline } from "../replay";

import { GROUP_MAX } from "../../../src/core/group";

const STATUS_WORD: Record<Run["status"], string> = {
  working: "working",
  waiting: "waiting for you",
  idle: "your turn",
  done: "done",
  failed: "failed",
  limited: "waiting for capacity",
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
  // a run's sheet (a chat or a coordinator) can become a tab (FR-030)
  const run = useStore((s) => (s.sheet?.kind === "run" ? s.runs[s.sheet.runId] : undefined));
  const repoName = useStore((s) => (run ? s.repos.find((r) => r.id === run.repoId)?.name : undefined));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // taken, so a surface under the sheet stays when this runs first
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    // Focus lands inside, so the keyboard user is in the dialog, not behind
    // it. Never on a coordinator's cards, where one Enter would start them,
    // nor on anything marked no-autofocus (the sweep's rows and its Close N,
    // where one Enter would close or restore something).
    [...(ref.current?.querySelectorAll<HTMLElement>("input[type=search], textarea, button:not(.close)") ?? [])]
      .find((el) => !el.closest(".coord-tasks") && !el.closest(".no-autofocus"))
      ?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, close]);

  if (!sheet) return null;
  // the tab finds the run again by the key the store keeps it under
  const tab: TabRef | undefined = run && sheet.kind === "run" ? { kind: "run", ref: sheet.runId, label: `${run.verb} · ${repoName ?? idText(run.repoId)}`, repoId: run.repoId } : undefined;
  const pop = { name: `sheet ${sheet.kind}`, anchor: CENTERED, gap: 24, ...(tab ? { tab } : {}) };
  return (
    <div className="sheet-back" onPointerDown={(e) => {
      if (e.target === e.currentTarget) close();
    }}>
      <div
        ref={ref}
        className={sheet.kind === "search" || sheet.kind === "group" ? "sheet wide" : "sheet"}
        role="dialog"
        aria-modal="true"
      >
        <PopHere.Provider value={pop}>
          <Body sheet={sheet} />
          <PopGrip {...pop} />
        </PopHere.Provider>
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
    return <Plan repo={repo} action={sheet.action} workspace={sheet.workspace} />;
  }
  if (sheet.kind === "group") return <GroupSheet key={sheet.groupId} groupId={sheet.groupId} />;
  if (sheet.kind === "search") return <SearchSheet />;
  if (sheet.kind === "keys") return <KeysSheet view={sheet.view} />;
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
    return <FlowPlan key={`${repo.id}\n${sheet.workflow}`} repo={repo} workflow={sheet.workflow} />;
  }
  if (sheet.kind === "new-sprout") return <NewSproutSheet draft={sheet.draft} />;
  if (sheet.kind === "sprout") return <SproutSheet key={sheet.id} id={sheet.id} />;
  if (sheet.kind === "flow") return <FlowConsole flowId={sheet.flowId} />;
  if (sheet.kind === "fleet-plan") return <FleetPlan key={sheet.workflow} workflow={sheet.workflow} />;
  if (sheet.kind === "fleet") return <FleetSheet fleetId={sheet.fleetId} />;
  if (sheet.kind === "work") return <WorkSheet key={sheet.id} id={sheet.id} />;
  if (sheet.kind === "approve") return <ApproveSheet key={sheet.id} id={sheet.id} />;
  // keyed by the pick that opened it, so every "pick" from the inbox starts
  // the sheet afresh, hand edits and all, and is never taken for the broom's
  if (sheet.kind === "sweep") return <SweepSheet key={sheet.pick === undefined ? "broom" : `pick-${sheet.pick}`} picks={sheet.picks} />;
  if (!run) return <Missing what="That run is gone." onClose={close} />;
  // keyed, so a coordinator's view and fold never carry over to the next run shown
  return <Console key={run.id} run={run} repo={repo} />;
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

/** A branch workflow keeps its slot between steps, including reader steps and gates. */
export function freeBranchSlots(repoId: string, runs: readonly Run[], flows: readonly Flow[]): number {
  const origins = new Set<string>();
  for (const run of runs) if (run.repoId === repoId && run.branch && isRunActive(run)) origins.add(run.branch.origin);
  for (const flow of flows) if (flow.repoId === repoId && flow.branch && isFlowActive(flow)) origins.add(flow.branch.origin);
  return Math.max(0, GROUP_MAX - origins.size);
}

export function GroupPreflight({ onBranch, times, free, profile, profiles, autoLand, onTimes, onProfile, onAutoLand }: {
  onBranch: boolean; times: number; free: number; profile: string; profiles: string[]; autoLand: boolean;
  onTimes: (n: number) => void; onProfile: (p: string) => void; onAutoLand: (on: boolean) => void;
}) {
  if (!onBranch) return null;
  return <fieldset className="plan-branch">
    <legend>Try it {times} {times === 1 ? "time" : "times"}</legend>
    <div role="group" aria-label="Number of branch runs">{[1, 2, 3].map(n => <button type="button" className={`mini${times === n ? " on" : ""}`} key={n} disabled={n > free} aria-pressed={times === n} onClick={() => onTimes(n)}>{n}</button>)}</div>
    <p className="note">{free} of {GROUP_MAX} slots free</p>
    {times > 1 && <>
      <label>Shared profile <select aria-label="Shared profile" value={profile} onChange={e => onProfile(e.target.value)}><option value="">repo's job route</option>{profiles.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
      <label className="plan-branch"><input type="checkbox" checked={autoLand} onChange={e => onAutoLand(e.target.checked)} /> auto-land the winner when its own review says auto</label>
    </>}
  </fieldset>;
}

/** `workspace` starts the run across that workspace, `repo` being its primary */
function Plan({ repo, action, workspace }: { repo: Repo; action: RunAction; workspace?: string | undefined }) {
  const close = useStore((s) => s.closeSheet);
  const startRun = useStore((s) => s.startRun);
  const startGroup = useStore((s) => s.startGroup);
  const free = useStore(s => freeBranchSlots(repo.id, Object.values(s.runs), Object.values(s.flows)));
  const routes = useStore(s => routesOf(s, backendOf(repo.id)));
  const profiles = profileNames(routes);
  const [times, setTimes] = useState(1);
  const [profile, setProfile] = useState("");
  const [autoLand, setAutoLand] = useState(false);
  const startWsRun = useStore((s) => s.startWsRun);
  const spec = ACTIONS[action];
  const words = planWords(action, workspace);
  const coordinate = action === "coordinate";
  const agent = useStore((s) => agentFor(s, repo, coordinate ? "coordinate" : spec.mode === "chat" ? "chat" : "job", { kind: "task", name: action }));
  const name = AGENT_NAME[agent.harness];
  const [note, setNote] = useState("");
  const noteBox = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentions({ box: noteBox, text: note, setText: setNote, repoId: repo.id, harness: agent.harness, side: "below" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteReady = !busy && (!spec.noteRequired || note.trim().length > 0);
  // a branch of its own: on for propose, off for the rest, never for a
  // workspace run or a checkout on another host or the forge; a coordinator
  // works from no checkout and branches through its cards
  const branchable = !coordinate && !workspace && !repo.host && !repo.forge;
  const byDefault = branchByDefault(action, workspace);
  const [onBranch, setOnBranch] = useState(byDefault);
  // FR-011: a PR in place of the landing queue, so only on a branch
  const [asPr, setAsPr] = useState(false);
  const pr = branchable && onBranch && asPr;
  // FR-039: the app beside the branch, only when asked for here; best-of-N
  // has no one worktree to mean
  const hasDev = useStore((s) => devTaskOf(tasksOf(s, repo.id)) !== undefined);
  const loadTasks = useStore((s) => s.loadTasks);
  useEffect(() => {
    if (branchable) loadTasks(repo.id).catch(() => {});
  }, [branchable, repo.id, loadTasks]);
  const [devTask, setDevTask] = useState(false);
  const startDev = branchable && onBranch && times === 1 && hasDev && devTask;
  const ready = noteReady && (!branchable || !onBranch || times <= free);
  // a branch run whose note opens with #123 or an issue URL starts from
  // that GitHub issue; the backend reads it with gh (core/issue)
  const issue = branchable && onBranch ? parseIssueRef(note) : null;

  const go = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      // the default is the backend's to apply, so a repo with no main yet keeps its propose in the checkout
      if (branchable && onBranch && times > 1) await startGroup(repo.id, action, note, times, profile || undefined, autoLand, pr);
      else await (workspace ? startWsRun(workspace, action, note) : startRun(repo.id, action, note, pr || startDev ? true : branchable && onBranch !== byDefault ? onBranch : undefined, pr ? true : undefined, startDev ? true : undefined));
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">
            with {name}
            {workspace && ` · in workspace ${workspace}`}
          </div>
          <h2 className="sheet-title">
            {spec.verb} <span className="sheet-repo">{idText(repo.id)}</span>
          </h2>
        </div>
        <PopGear />
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
        <p className="blurb">{words.blurb}</p>
        <div className="mention-host">
          <textarea
            ref={noteBox}
            className="plan-note"
            rows={spec.noteRequired ? 5 : 3}
            placeholder={words.notePlaceholder}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (mentions.onKeyDown(e)) return;
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go();
            }}
            aria-label={spec.noteRequired ? `What ${name} should do` : `Note for ${name}`}
          />
          {mentions.menu}
        </div>
        {branchable && onBranch && (
          <p className="plan-issue">
            {issue && (
              <span className="plan-issue-ref" title="The run starts from this issue's title, body and latest comments, read with gh on the backend">
                from issue #{issue.number}
                {issue.slug && ` in ${issue.slug}`}
              </span>
            )}
            <span>#123 or an issue URL at the start of the note starts from that GitHub issue</span>
          </p>
        )}
        {branchable && (
          <label className="plan-branch" title="The agent works in a worktree of its own on a run/ branch and commits there; the landing queue lands it on main once you say land">
            <input type="checkbox" checked={onBranch} onChange={(e) => setOnBranch(e.target.checked)} />
            on a branch of its own
          </label>
        )}
        <GroupPreflight onBranch={branchable && onBranch} times={times} free={free} profile={profile} profiles={profiles} autoLand={autoLand} onTimes={setTimes} onProfile={setProfile} onAutoLand={setAutoLand} />
        {branchable && onBranch && (
          <label className="plan-branch" title="Once the run is ready, canopy pushes its branch and opens a PR on GitHub instead of landing it here, then watches its checks and reviews">
            <input type="checkbox" checked={asPr} onChange={(e) => setAsPr(e.target.checked)} />
            open a PR when done
          </label>
        )}
        {branchable && onBranch && times === 1 && hasDev && (
          <label className="plan-branch" title="Once the worktree is set up, canopy runs the repo's dev task in it, on a port of its own, so you can preview the branch while the agent works">
            <input type="checkbox" checked={devTask} onChange={(e) => setDevTask(e.target.checked)} />
            start the dev task in the worktree
          </label>
        )}
        {error && <p className="note err">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <span className="sheet-hint">
          {coordinate
            ? `${name} works in a sandbox of its own and only proposes cards; nothing starts until you press start these.`
            : agent.yolo
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
  /** the answer names the prompt it was given on, never the one waiting at click time */
  onAnswer: (a: RunAnswer, promptId: string) => void;
  /** rendered at the end of the same scrolling body, for a flow's step check */
  extra?: ReactNode;
}) {
  const chat = run.chat;
  const active = !run.kept && isRunActive(run);
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
  const todos = run.todos ?? [];
  // a subagent's steps fold under its Agent call; the main thread's todo
  // steps give way to the checklist
  const nodes = nestSteps(hideTodoSteps(steps, todos.length > 0));
  // the latest plan, once settled: the one waiting shows in its form below
  const settled = settledProposal(run);

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
      {settled && (
        <details className="proposal">
          <summary>{PROPOSAL_SUMMARY[settled]}</summary>
          <pre className="proposal-text">{run.proposal}</pre>
        </details>
      )}
      {todos.length > 0 && (
        <ol className={run.status === "working" ? "todos live" : "todos"} aria-label="The agent's checklist">
          {todos.map((t) => (
            <li key={t.id} className={`todo t-${t.status}`}>
              <span className="todo-mark" aria-hidden="true" />
              <span className="todo-text">{t.status === "in_progress" && t.active ? t.active : t.subject}</span>
            </li>
          ))}
        </ol>
      )}
      <ol className="steps">
        {nodes.map((n) => (
          <Step key={n.step.id} step={n.step} kids={n.kids} />
        ))}
        {run.status === "working" && run.steps.length === 0 && (
          <li className="step k-note thinking">
            <span className="node" />
            <span className="step-text shimmer">starting {AGENT_NAME[harness]} in {repo?.path ?? idText(run.repoId)}…</span>
          </li>
        )}
        {run.status === "working" && run.steps.length > 0 && (
          <li className="step k-note thinking">
            <span className="node" />
            <span className="step-text shimmer">thinking…</span>
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
      {!run.kept && run.prompt && (
        <RunPromptForm
          key={run.prompt.id}
          prompt={run.prompt}
          harness={harness}
          repoId={run.repoId}
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
      {run.status === "limited" && (
        <div className="outcome warn">
          <p>The plan's usage limit: {run.error}</p>
          <p>The work is sound; it waits for the reset.</p>
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

export function Console({ run, repo, onClose }: { run: Run; repo: Repo | undefined; onClose?: () => void }) {
  // in a shell window's tab (FR-030) the ✕ closes the tab, not the sheet
  const closeSheet = useStore((s) => s.closeSheet);
  const close = onClose ?? closeSheet;
  const stopRun = useStore((s) => s.stopRun);
  const dismissRun = useStore((s) => s.dismissRun);
  const answerRun = useStore((s) => s.answerRun);
  const sayRun = useStore((s) => s.sayRun);
  const draft = useStore((s) => s.chatDrafts[run.id]);
  const active = !run.kept && isRunActive(run);
  const chat = run.chat;
  const noChange = run.status === "done" && run.outcome === "unchanged" && run.expectsChange;
  const now = useTick(active);
  const elapsed = (run.endedAt ?? now) - run.startedAt;
  const [error, setError] = useState<string | null>(null);

  const act = (fn: () => Promise<void>, propagate = false) => {
    setError(null);
    return run.kept ? Promise.resolve() : runConsoleAction(fn, setError, propagate);
  };
  const harness = harnessOf(run);
  const name = AGENT_NAME[harness];

  // A coordinator's cards: on a phone the sheet shows them or the chat,
  // opening on the view coordView picks; wider, they sit under the
  // timeline and fold to their head.
  const phone = useMedia(PHONE);
  const replay = useReplay(run);
  const [view, setView] = useState<CoordView>(() => coordView(run));
  const [folded, setFolded] = useState(false);
  // "fork from here" (FR-043 plan 3): the step the replay bar stands at,
  // or the end from the footer; the fork sheet takes the timeline's place
  const [forkAt, setForkAt] = useState<ForkAt | null>(null);
  const forkable = !active && !isCoordinator(run) && repo !== undefined && !repo.host && !repo.forge;
  const cards = isCoordinator(run) && ((run.tasks?.length ?? 0) > 0 || active);
  const cardsOnly = cards && phone && view === "cards";

  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">
            <span className={`harness-glyph h-${harness}`} aria-hidden="true">
              {HARNESS[harness].glyph}
            </span>{" "}
            with {name}
            {run.workspace && <span className="run-by" title="it works in this repo and sees the workspace's other members"> · in workspace {run.workspace}</span>}
            {run.by && <span className="run-by" title="the device that started it"> · from {run.by}</span>}
            {run.kept && <span className="run-by" title="Served from the run's record on disk; the live run is gone. Nothing here can be answered or stopped."> · kept</span>}
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
        <PopGear />
        <button type="button" className="mini close" onClick={close} aria-label="Close">
          ✕
        </button>
      </header>

      {(run.parent || run.group || run.branch?.group) && <ParentLine run={run} />}
      {run.forkOf && <ForkLine run={run} />}
      {run.branch && <BranchBlock run={run} act={act} />}
      {run.branch && !run.kept && <BranchApp run={run} act={act} />}
      {run.branch?.work && <WorkBlock run={run} />}
      {run.branch && <PrBlock run={run} act={act} />}

      {/* gone rather than hidden in the cards view, so it comes back
          following the newest step */}
      {!cardsOnly && replay.timeline && <ReplayBar replay={replay} timeline={replay.timeline} {...(forkable ? { onFork: setForkAt } : {})} />}
      {forkAt && repo && <ForkSheet run={run} repo={repo} at={forkAt} onClose={() => setForkAt(null)} />}
      {!cardsOnly && !forkAt && (
        <Timeline
          run={replay.view}
          repo={repo}
          error={error}
          onAnswer={(a, promptId) => void act(() => answerRun(run.id, promptId, a))}
        />
      )}

      {cards && (
        <CoordTasks
          run={run}
          act={act}
          layout={phone ? { kind: "phone", view, onView: setView } : { kind: "wide", folded, onFold: setFolded }}
          error={cardsOnly ? error : null}
        />
      )}

      {/* hidden, not gone, in the cards view, so what was typed stays */}
      {chat && active && (
        <Composer
          who={name}
          repoId={run.repoId}
          harness={harness}
          ready={run.status === "idle"}
          first={run.steps.length === 0}
          onSend={(text) => act(() => sayRun(run.id, text), true)}
          hidden={cardsOnly}
          {...(draft ? { draft } : {})}
        />
      )}

      <footer className="sheet-foot">
        {run.result && (
          <span className="sheet-hint" title={tokenTitle(run.result) ?? undefined}>
            {resultLine(run.result)}
          </span>
        )}
        {replay.failed && <span className="sheet-hint">no replay: {replay.failed}</span>}
        <span className="spacer" />
        {!active && !replay.wanted && (
          <button type="button" className="mini" title="Play the run back from its kept wire, step by step" onClick={replay.load}>
            replay
          </button>
        )}
        {forkable && !forkAt && (
          <button type="button" className="mini" title="Start a new run on a branch of its own, cut from the commit this one started at, that goes on from this run's end with its context" onClick={() => { const n = replay.timeline?.steps.length ?? run.steps.length; setForkAt({ step: null, at: n, of: n }); }}>
            fork
          </button>
        )}
        {active ? (
          <button
            type="button"
            className="mini"
            title={chat && run.status === "idle" ? `Close the conversation; ${name} exits` : undefined}
            onClick={() => void act(() => stopRun(run.id))}
          >
            {chat && run.status === "idle" ? "end chat" : "stop"}
          </button>
        ) : !run.kept && (
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

/* ---------- the replay bar (FR-043 plan 2) ---------- */

interface Replay {
  /** the replay was asked for, or is a kept run's, loaded as the sheet opens */
  wanted: boolean;
  load: () => void;
  /** why a replay asked for could not load */
  failed: string | null;
  data: RunReplay | null;
  timeline: ReplayTimeline | null;
  /** entries on show; the end shows the run as it ended */
  cursor: number;
  end: number;
  playing: boolean;
  speed: ReplaySpeed;
  /** the run the timeline draws: the replay's prefix, or the run itself */
  view: Run;
  play: () => void;
  pause: () => void;
  seek: (cursor: number) => void;
  setSpeed: (speed: ReplaySpeed) => void;
}

/** A finished run's replay: loaded from its kept wire when asked for, and at
 *  once for a kept run, whose record a restart may have left without steps;
 *  then a cursor over its timeline, moved by a timer while it plays. */
function useReplay(run: Run): Replay {
  const finished = !isRunActive(run);
  const [wanted, setWanted] = useState(run.kept === true);
  const [asked, setAsked] = useState(false);
  const [data, setData] = useState<RunReplay | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  useEffect(() => {
    if (!wanted || !finished || data) return;
    let live = true;
    api.runReplay(run.id).then(
      (r) => {
        if (live) setData(r);
      },
      // a kept run with no wire simply has no bar; one asked for says why,
      // and can be asked for again
      (err: unknown) => {
        if (!live || !asked) return;
        setFailed(errText(err));
        setWanted(false);
      },
    );
    return () => {
      live = false;
    };
  }, [wanted, finished, data, asked, run.id]);
  const timeline = useMemo(() => (data ? replayTimeline(data, run) : null), [data, run]);
  const end = timeline ? replayEnd(timeline) : 0;
  const at = cursor === null ? end : Math.min(cursor, end);
  useEffect(() => {
    if (!playing || !timeline) return;
    const gap = nextGap(timeline, at, speed);
    if (gap === null) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setCursor(at + 1), gap);
    return () => clearTimeout(timer);
  }, [playing, timeline, at, speed]);
  return {
    wanted,
    load: () => {
      setFailed(null);
      setAsked(true);
      setWanted(true);
    },
    failed,
    data,
    timeline,
    cursor: at,
    end,
    playing,
    speed,
    view: timeline ? replayView(run, timeline, at) : run,
    play: () => {
      if (at >= end) setCursor(0);
      setPlaying(true);
    },
    pause: () => setPlaying(false),
    seek: (c) => {
      setPlaying(false);
      setCursor(Math.max(0, Math.min(end, c)));
    },
    setSpeed,
  };
}

const JUMP_WORD: Record<ReplayJumpKind, string> = { prompt: "prompt", message: "message", subagent: "subagent", result: "" };

/** Where a fork is taken (FR-043 plan 3): a step of the replay and its
 *  number from 1, or null and the step count for the run's end; `of` is
 *  the count of the replay's steps, which the server numbers by too. */
interface ForkAt {
  step: RunStep | null;
  at: number;
  of: number;
}

/** Play at 1× or 4×, a scrubber over the steps and "jump to" the prompts,
 *  the messages, each subagent's start and the result; with `onFork`,
 *  "fork from here" at the step the cursor stands on. */
function ReplayBar({ replay, timeline, onFork }: { replay: Replay; timeline: ReplayTimeline; onFork?: (at: ForkAt) => void }) {
  const source = replay.data?.source;
  const here = Math.min(replay.cursor, timeline.steps.length);
  const fork = () => {
    const step = here >= timeline.steps.length ? null : (timeline.steps[here - 1] ?? null);
    onFork?.({ step, at: here, of: timeline.steps.length });
  };
  return (
    <div className="replay-bar" role="group" aria-label="Replay">
      <button
        type="button"
        className="mini"
        aria-label={replay.playing ? "Pause the replay" : "Play the run back"}
        onClick={replay.playing ? replay.pause : replay.play}
      >
        {replay.playing ? "❚❚ pause" : "▶ play"}
      </button>
      <span className="replay-speeds">
        {REPLAY_SPEEDS.map((s) => (
          <button key={s} type="button" className={replay.speed === s ? "mini on" : "mini"} aria-pressed={replay.speed === s} onClick={() => replay.setSpeed(s)}>
            {s}×
          </button>
        ))}
      </span>
      <input
        className="replay-scrub"
        type="range"
        min={0}
        max={replay.end}
        step={1}
        value={replay.cursor}
        aria-label="Steps shown"
        aria-valuetext={`${Math.min(replay.cursor, timeline.steps.length)} of ${timeline.steps.length} steps`}
        onChange={(e) => replay.seek(Number(e.target.value))}
      />
      <span className="replay-clock" title="Replay time: each wait between steps is capped at 3 seconds">
        {replayClock(replayTime(timeline, replay.cursor))} / {replayClock(timeline.length)}
      </span>
      <select
        className="replay-jump"
        aria-label="Jump to"
        value=""
        onChange={(e) => {
          if (e.target.value) replay.seek(Number(e.target.value));
        }}
      >
        <option value="">jump to…</option>
        {timeline.jumps.map((j) => (
          <option key={`${j.kind}-${j.cursor}`} value={j.cursor}>
            {j.kind === "result" ? j.label : `${JUMP_WORD[j.kind]}: ${j.label}`}
          </option>
        ))}
      </select>
      {source === "wire" && (
        <span className="replay-note" title="The run's record kept no steps of its own (a restart took the run) or trimmed its oldest, so these are folded back out of its wire; canopy's own notes are not in a wire.">
          rebuilt from the wire
        </span>
      )}
      {replay.data?.cut && <span className="replay-note" title="The wire reached its size limit and was cut, so the replay stops short.">cut short</span>}
      {onFork && (
        <button
          type="button"
          className="mini"
          disabled={here === 0}
          title={here === 0 ? "Scrub to a step first" : here >= timeline.steps.length ? "A new run that goes on from this run's end, with its context, on a branch of its own" : `A new run that goes on from step ${here} of ${timeline.steps.length}, knowing nothing past it, on a branch of its own`}
          onClick={fork}
        >
          fork from here
        </button>
      )}
    </div>
  );
}

/** Where a fork came from: "forked from run 3f2a at step 41, the
 *  transcript cut there and resumed", with the original's sheet a click
 *  away. */
function ForkLine({ run }: { run: Run }) {
  const showRun = useStore((s) => s.showRun);
  const f = run.forkOf;
  if (!f) return null;
  const words = forkLine({ ...f, run: idText(f.run) });
  return (
    <div className="run-fork">
      <span className="run-parent-text" title={HOW_TITLE[f.how]}>{words}</span>
      <span className="spacer" />
      <button type="button" className="mini" title="Open the run it was forked from" onClick={() => showRun(f.run)}>
        open the original
      </button>
    </div>
  );
}

const HOW_TITLE: Record<NonNullable<Run["forkOf"]>["how"], string> = {
  cut: "The fork resumed a copy of the original's transcript cut after that step, so it knows nothing past it.",
  whole: "The fork resumed the whole session under a new id; its first message says where the cut is and to disregard what came after.",
  brief: "The fork started fresh from a brief of the original's steps up to there: the other harness, or no session left to resume.",
};

/** The fork sheet (FR-043 plan 3): the step it forks at, the agent it will
 *  run on (a profile of this backend's, else the repo's own job route) and
 *  how the fork will get the original's context, a note for it, and the
 *  fork itself, which opens the new run's sheet. */
function ForkSheet({ run, repo, at, onClose }: { run: Run; repo: Repo; at: ForkAt; onClose: () => void }) {
  const showRun = useStore((s) => s.showRun);
  const routes = useStore((s) => routesOf(s, backendOf(repo.id)));
  const profiles = profileNames(routes);
  const [profile, setProfile] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action: RunAction = run.action === "propose" ? "propose" : "ask";
  const agent = resolveAgent(routes, repo.path, "job", profile ? { profile } : undefined, { kind: "task", name: action }).settings;
  const sameHarness = agent.harness === run.harness && run.session !== undefined;
  const where = at.step ? `step ${at.at} of ${at.of}: ${stepWords(at.step)}` : `its end (${at.of} step${at.of === 1 ? "" : "s"})`;
  const how = sameHarness
    ? run.harness === "claude"
      ? at.step
        ? "Claude resumes a copy of the session's transcript cut after that step, so the fork knows nothing past it."
        : "Claude resumes the whole session under a new id."
      : "Codex forks the thread, whole; the first message says where the cut is."
    : `${AGENT_NAME[agent.harness]} starts fresh from a brief of the steps up to there, as data in its note.`;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const fork = await api.forkRun(run.id, { ...(at.step ? { step: at.step.id } : {}), ...(profile ? { profile } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      onClose();
      showRun(fork.id);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return (
    <div className="fork-sheet" role="group" aria-label="Fork from here">
      <p className="fork-where">
        Fork run <b>{idText(run.id)}</b> at {where}
      </p>
      <p className="settings-hint">
        A new run on a branch of its own, cut from the commit this run started at: none of this run's changes are in it. {how}
      </p>
      <label className="fork-row">
        <span>agent</span>
        <select value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="Agent profile">
          <option value="">the repo's own ({describeAgent(agent)})</option>
          {profiles.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="plan-note"
        rows={3}
        placeholder="what the fork should do from here (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go();
        }}
        aria-label="Note for the fork"
      />
      {error && <p className="note err">{error}</p>}
      <div className="fork-actions">
        <span className="spacer" />
        <button type="button" className="mini" onClick={onClose} disabled={busy}>
          cancel
        </button>
        <button type="button" className="mini strong" onClick={() => void go()} disabled={busy}>
          {busy ? "forking…" : "fork"}
        </button>
      </div>
    </div>
  );
}

/** A branch run's branch and where its work stands in the landing queue,
 *  with "land" once it is ready (or a restart stopped it with its work
 *  whole) and "fix it" once the queue sent it back. */
function BranchBlock({ run, act }: { run: Run; act: (fn: () => Promise<void>) => Promise<void> }) {
  const info = useStore((s) => landingAll(s));
  const landRun = useStore((s) => s.landRun);
  const showApprove = useStore((s) => s.showApprove);
  const fixLanding = useStore((s) => s.fixLanding);
  const openPr = useStore((s) => s.openPr);
  const b = run.branch;
  const l = runLanding(run, info);
  if (!b || !l) return null;
  return (
    <div className="run-branch">
      <span className="branch" title={b.dir}>
        {b.name}
      </span>
      <span className="run-branch-word">{l.word}</span>
      {l.verdict && <span className="run-branch-why">{l.verdict}</span>}
      {l.why && <span className="run-branch-why">{l.why}</span>}
      {l.entry?.reason && l.entry.state !== "red" && <span className="run-branch-why">{l.entry.reason}</span>}
      {l.overlaps?.map((overlap, index) => <OverlapChip key={`${overlap.name}:${index}`} name={overlap.name} paths={overlap.paths} />)}
      {l.scenarios && <ScenarioPass pass={l.scenarios} title="The repo's holdout scenarios over this branch; their text stays on the server" />}
      <span className="spacer" />
      {!run.kept && l.canLand && l.approve && (
        <button type="button" className="mini strong" title="Open its sensitive files and their diffs, then approve and land" onClick={() => showApprove(b.origin)}>
          look and land
        </button>
      )}
      {!run.kept && l.canLand && !l.approve && (
        <button type="button" className="mini strong" title={l.stopped ? stoppedLandTitle(b.target) : `Rebase onto ${b.target}, run the gates, fast-forward ${b.target}; nothing is pushed`} onClick={() => void act(() => landRun(b.origin))}>
          land
        </button>
      )}
      {!run.kept && l.canFix && (
        <button type="button" className="mini strong" title="Continue on the branch with the reason as the next message" onClick={() => void act(() => fixLanding(b.origin))}>
          fix it
        </button>
      )}
      {!run.kept && l.canSkipJudge && (
        <button type="button" className="mini strong" title="Land it with its judge scenarios left out; its command scenarios ran and passed" onClick={() => void act(() => landRun(b.origin, undefined, true))}>
          land anyway
        </button>
      )}
      {!run.kept && l.canPr && (
        <button
          type="button"
          className="mini"
          title={`Push ${b.name} and open a PR against ${b.target} on GitHub instead of landing it here. Canopy watches its checks and reviews from then on`}
          onClick={() => void act(() => openPr(b.origin))}
        >
          open PR
        </button>
      )}
    </div>
  );
}

/** The repo's app on this run's branch (FR-039): "run the app here" starts
 *  the dev task in the worktree on a port of its own, and "preview this
 *  branch" shows that port in the repo's preview. Only while the worktree
 *  stands, and only when the repo has something to run. */
function BranchApp({ run, act }: { run: Run; act: (fn: () => Promise<void>) => Promise<void> }) {
  const b = run.branch;
  const repoId = run.repoId;
  const hasDev = useStore((s) => devTaskOf(tasksOf(s, repoId)) !== undefined);
  const task = useStore((s) => (b ? branchTask(treeTasksOf(s, repoId), b.origin) : undefined));
  const standing = useStore((s) => (b ? isRunActive(run) || landingAll(s).runs.some((r) => r.id === b.origin) : false));
  const loadTasks = useStore((s) => s.loadTasks);
  const treeTaskAct = useStore((s) => s.treeTaskAct);
  const previewBranch = useStore((s) => s.previewBranch);
  const [log, setLog] = useState<string | null>(null);
  useEffect(() => {
    loadTasks(repoId).catch(() => {});
  }, [repoId, loadTasks]);
  if (!b || !standing || (!hasDev && !task)) return null;
  const up = task?.status === "running" || task?.status === "backoff";
  const down = task?.status === "failed" || task?.status === "gave-up";
  // a run popped into its own window has no dock to show the preview in
  const preview = (port: number) => {
    previewBranch(repoId, port);
    if (parseRoute(window.location.search).run !== null) openSectionElsewhere(repoId, "preview", "tab");
  };
  const showLog = async (name: string) => {
    const page = await api.taskLog(repoId, name, "", undefined, b.origin);
    setLog(page.lines.slice(-20).map((l) => l.text).join("\n"));
  };
  return (
    <>
      <div className="run-branch">
        {task && <span className="run-branch-word">{branchTaskWords(task, Date.now())}</span>}
        <span className="spacer" />
        {!up && (
          <button type="button" className="mini" title="Run the repo's dev task in this branch's worktree, beside the main checkout" onClick={() => void act(() => treeTaskAct(repoId, b.origin, "start", task?.name))}>
            run the app here
          </button>
        )}
        {up && task.port !== undefined && (
          <button type="button" className="mini strong" title={`Show :${task.port} in the repo's preview`} onClick={() => task.port !== undefined && preview(task.port)}>
            preview this branch
          </button>
        )}
        {up && (
          <button type="button" className="mini" title="Stop the task; the worktree stays" onClick={() => void act(() => treeTaskAct(repoId, b.origin, "stop", task.name))}>
            stop
          </button>
        )}
        {down && (
          <button type="button" className="mini" title="The last lines the task printed" onClick={() => void act(() => showLog(task.name))}>
            log
          </button>
        )}
      </div>
      {down && log !== null && <pre className="run-branch-why">{log}</pre>}
    </>
  );
}

/** The PR a branch run opened: its line, the CI chip with every check
 *  under it, the auto-fix and auto-merge toggles, what auto-merge waits
 *  on, and comments from people canopy will not act for. */
function PrBlock({ run, act }: { run: Run; act: (fn: () => Promise<void>) => Promise<void> }) {
  const prs = useStore((s) => prsAll(s));
  const setPr = useStore((s) => s.setPr);
  const closePr = useStore((s) => s.closePr);
  const w = prOfRun(run, prs);
  if (!w) return null;
  const chip = ciChip(w);
  const open = w.state?.status !== "merged" && w.state?.status !== "closed";
  const why = mergeWhy(w);
  return (
    <div className="run-pr">
      <div className="run-pr-head">
        <a className="run-pr-link" href={w.url} target="_blank" rel="noreferrer" title={`${w.slug} #${w.number}`}>
          {prLine(w)}
        </a>
        <span className="run-branch-word">{prWord(w)}</span>
        {chip && (
          <details className={`run-pr-ci ${chip.tone}`}>
            <summary>{chip.text}</summary>
            <ul>
              {w.state?.checks.map((c) => (
                <li key={c.name} className={c.state}>
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer">
                      {c.name}
                    </a>
                  ) : (
                    c.name
                  )}{" "}
                  <span className="dim">{c.state}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <span className="spacer" />
        {!run.kept && open && (
          <button type="button" className="mini" title="Close the PR on GitHub. The branch stays, and the run may land here again" onClick={() => void act(() => closePr(w.id))}>
            close PR
          </button>
        )}
      </div>
      {!run.kept && open && (
        <div className="run-pr-toggles">
          <label title="A failed check or a review comment from someone with write access starts a fix run on the branch, which canopy pushes. Up to 3 tries each">
            <input type="checkbox" checked={w.autoFix} onChange={(e) => void act(() => setPr(w.id, { autoFix: e.target.checked }))} />
            auto-fix CI and address comments
          </label>
          <label title="Merge on GitHub once every check passes, the review approves or asks nothing, and GitHub says it merges clean">
            <input type="checkbox" checked={w.autoMerge} onChange={(e) => void act(() => setPr(w.id, { autoMerge: e.target.checked }))} />
            auto-merge when ready
          </label>
        </div>
      )}
      {w.fixing && <span className="run-pr-note">a fix is going for {w.fixing.key.replace(/^check:/, "check ").replace(/^comment:/, "comment ")}</span>}
      {why && <span className="run-pr-note">{why}</span>}
      {w.scenarios && <ScenarioPass pass={w.scenarios} head={w.state?.head} title="The repo's holdout scenarios over the PR's head, run before auto-merge; their text stays on the server, and a red one leaves the merge to you" />}
      {w.gaveUp && <span className="run-branch-why">auto-fix gave up: {w.gaveUp}</span>}
      {w.error && <span className="run-branch-why">{w.error}</span>}
      {w.untrusted && w.untrusted.length > 0 && (
        <details className="run-pr-untrusted">
          <summary>
            {w.untrusted.length} {w.untrusted.length === 1 ? "comment" : "comments"} from people without write access, not acted on
          </summary>
          <ul>
            {w.untrusted.map((c) => (
              <li key={c.id}>
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.author}
                </a>
                : {c.body.length > 200 ? `${c.body.slice(0, 200)}…` : c.body}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * A run's timeline and, for a chat, its message box, with no sheet around
 * them: what the agents board shows for a canopy run or chat. Its prompts
 * answer here as they do in the sheet, and the box never takes the
 * keyboard until clicked.
 */
export function RunPane({ run, repo }: { run: Run; repo: Repo | undefined }) {
  const answerRun = useStore((s) => s.answerRun);
  const sayRun = useStore((s) => s.sayRun);
  const draft = useStore((s) => s.chatDrafts[run.id]);
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<void>, propagate = false) => {
    setError(null);
    return run.kept ? Promise.resolve() : runConsoleAction(fn, setError, propagate);
  };
  return (
    <div className="run-pane" data-voice-run={run.id}>
      <Timeline run={run} repo={repo} error={error} onAnswer={(a, promptId) => void act(() => answerRun(run.id, promptId, a))} />
      {!run.kept && run.chat && isRunActive(run) && (
        <Composer
          who={AGENT_NAME[harnessOf(run)]}
          repoId={run.repoId}
          harness={harnessOf(run)}
          ready={run.status === "idle"}
          first={run.steps.length === 0}
          onSend={(text) => act(() => sayRun(run.id, text), true)}
          quiet
          {...(draft ? { draft } : {})}
        />
      )}
    </div>
  );
}

/** The chat's message box. Enter sends, shift-enter breaks a line; `/`,
 *  `$` and `@` open the agent's commands, skills and the repo's files. */
function Composer({
  who,
  repoId,
  harness,
  ready,
  onSend,
  draft = "",
  quiet = false,
  hidden = false,
  first = false,
}: {
  /** the agent's name, for the box's placeholder while it replies */
  who: string;
  /** whose files and commands the menu offers */
  repoId: string;
  harness: Harness;
  ready: boolean;
  onSend: (text: string) => Promise<void>;
  /** what the box starts with: an accepted retro lesson, for the user to read and send */
  draft?: string;
  /** never takes the keyboard on its own (the agents board, whose keys
   *  would otherwise type into it) */
  quiet?: boolean;
  /** out of sight but kept, with what was typed (a coordinator's cards view) */
  hidden?: boolean;
  /** nothing has been said yet: this message starts the agent inside
   *  canopy's prompt, where the CLI reads no slash command */
  first?: boolean;
}) {
  const [text, setText] = useState(draft);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const can = ready && !busy && text.trim().length > 0;
  const mentions = useMentions({ box, text, setText, repoId, harness, bare: !first });

  // Back to the box as soon as the agent has answered, unless it is out of
  // sight. Coming back into sight is no answer, so it takes no focus: on a
  // phone that would raise the keyboard over the chat just switched to.
  const shown = useRef(!hidden);
  useEffect(() => {
    shown.current = !hidden;
  }, [hidden]);
  useEffect(() => {
    if (ready && !quiet && shown.current) box.current?.focus();
  }, [ready, quiet]);

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
    <div className="composer" hidden={hidden}>
      <div className="mention-host">
        {/* first, so it opens over the box; the timeline gives it room */}
        {mentions.menu}
        <textarea
          ref={box}
          className="composer-box"
          // a draft is read before it is sent, so it gets room
          rows={draft ? 10 : 2}
          placeholder={ready ? "say something…" : `${who} is replying…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (mentions.onKeyDown(e)) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label="Your message"
          data-mic
        />
      </div>
      <DictateButton target={box} />
      <button
        type="button"
        className="mini strong"
        disabled={!can}
        title={`↩ sends, shift-↩ for a new line; ${harness === "codex" ? "/ or $ for a skill" : "/ for a command or skill"}, @ for a file`}
        onClick={() => void send()}
      >
        send
      </button>
    </div>
  );
}

/** the approved-plan card's line, by how the latest plan was settled. Both
 *  approvals read the same: a bypass the CLI refused falls back to asking,
 *  which the timeline's note says and this line could not. */
const PROPOSAL_SUMMARY: Record<SettledProposal, string> = {
  approved: "the approved plan",
  "approved-auto": "the approved plan",
  "sent back": "the plan, sent back",
  "turned down": "the plan, turned down",
};

/** A subagent's steps folded under the Agent call that started them. The
 *  fold opens when one of them starts running (the Agent step's own status
 *  says nothing, since an async one is done the moment it launches), and
 *  otherwise stays as the user left it: a fold they opened never closes on
 *  them when the last one finishes. */
function KidSteps({ kids }: { kids: readonly RunStep[] }) {
  const running = kids.some((k) => k.tool?.status === "running");
  const [open, setOpen] = useState(running);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  return (
    <details className="step-kids" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {kids.length} step{kids.length === 1 ? "" : "s"} inside
      </summary>
      <ol>
        {kids.map((k) => (
          <Step key={k.id} step={k} />
        ))}
      </ol>
    </details>
  );
}

/** One step, and a subagent's steps under the Agent call that started them. */
function Step({ step, kids = [] }: { step: RunStep; kids?: readonly RunStep[] }) {
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
          {kids.length > 0 && <KidSteps kids={kids} />}
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
        <PopGear />
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
        <PopGear />
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
        <PopGear />
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

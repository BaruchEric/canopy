import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { keepKeys, escapeCloses } from "../surface";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { useFitPop } from "../pop";
import { taskShellUrl } from "../routes";
import { tasksOf, useStore } from "../store";
import { frontTask, markTime, STATUS_WORD, taskChip, taskWhen } from "../tasks";
import { benchSolo, benchTask } from "../front";
import type { TermTab } from "../term";
import type { Repo, TaskInfo, TaskLogLine } from "../../../src/core/types";
import { Seg } from "./Seg";
import { Section, SectionWindow, ShellSpotHere, useSectionClosed } from "./Surface";
import { TermView } from "./TermDock";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** how often a running task's log tail is read again while it shows */
const TAIL_EVERY = 2000;

/** the glyphs after a task's name for the flags it has */
function Flags({ t }: { t: TaskInfo }) {
  return (
    <span className="task-flags">
      {t.dev && <span title="the dev task, the one the preview pairs with">◉</span>}
      {t.keep && <span title="keep running: restarted when it fails and after a restart">↻</span>}
      {t.withPanel && <span title="starts when the panel opens">▣</span>}
    </span>
  );
}

/** A repo's tasks: one line each with start, stop and restart. A click on a
 *  running task opens its terminal among the panel's shells; the picked
 *  task's log shows under the list, searchable. In the project's bench (⧉,
 *  or a task picked in the top bar's list) they are tabs along its side,
 *  and the picked task's live terminal or its log is the bench's log pane. */
export function TasksSection({ repo }: { repo: Repo }) {
  const lone = useContext(SectionWindow);
  const closed = useSectionClosed(repo.id, "tasks");
  const tasks = useStore(useShallow((s) => tasksOf(s, repo.id)));
  const errors = useStore((s) => s.taskErrors[repo.id]);
  const loadTasks = useStore((s) => s.loadTasks);
  const taskAct = useStore((s) => s.taskAct);
  const editTask = useStore((s) => s.editTask);
  const openTaskTab = useStore((s) => s.openTaskTab);
  const asked = useStore((s) => benchTask(s.front, repo.id));
  const bringTask = useStore((s) => s.bringTask);
  const dropBenchTask = useStore((s) => s.dropBenchTask);
  const soloBench = useStore((s) => s.soloBench);
  const soloed = useStore((s) => benchSolo(s.front, repo.id) === "log");
  const [open, setOpen] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inFront = asked !== undefined;

  useEffect(() => {
    if (closed) return;
    loadTasks(repo.id).catch((e: unknown) => setError(errText(e)));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [closed, repo.id, loadTasks]);

  // gone (hidden, or the panel's level switched), the tasks give back the
  // task they asked the bench for; the bench itself stays
  useEffect(() => () => useStore.getState().dropBenchTask(repo.id), [repo.id]);
  useEffect(() => {
    if (closed && inFront) dropBenchTask(repo.id);
  }, [closed, inFront, dropBenchTask, repo.id]);

  const act = async (action: "start" | "stop" | "restart", name: string) => {
    setBusy(`${action}:${name}`);
    setError(null);
    try {
      await taskAct(repo.id, action, name);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy("");
    }
  };

  const shown = tasks.filter((t) => showHidden || !t.hidden);
  const hidden = tasks.filter((t) => t.hidden).length;
  const running = tasks.filter((t) => t.status === "running").length;
  const picked = inFront ? frontTask(shown, asked, open) : (shown.find((t) => t.name === open) ?? null);

  // in the bench, the ⧉ has the log take the whole bench, or give it back
  const flipBench = () => {
    if (!inFront) {
      bringTask(repo.id, open);
      return;
    }
    // what showed in the bench stays open in place
    if (picked) setOpen(picked.name);
    soloBench(repo.id, soloed ? null : "log");
  };
  const benchWord = soloed ? "Give the bench back" : "The log takes the bench";

  const pick = (t: TaskInfo) => {
    if (inFront) {
      bringTask(repo.id, t.name);
      setOpen(t.name);
      return;
    }
    setOpen(open === t.name ? null : t.name);
    if (t.live && open !== t.name) openTaskTab(repo.id, t, "panel");
  };

  const actions = (t: TaskInfo) => (
    <span className="task-actions">
      {t.status === "running" ? (
        <>
          <button type="button" className="mini" disabled={!!busy} onClick={() => void act("restart", t.name)} title="Restart">
            ↻
          </button>
          <button type="button" className="mini" disabled={!!busy} onClick={() => void act("stop", t.name)} title="Stop">
            ■
          </button>
        </>
      ) : t.status === "backoff" ? (
        <button type="button" className="mini" disabled={!!busy} onClick={() => void act("stop", t.name)} title="Stop restarting">
          ■
        </button>
      ) : (
        !t.gone && (
          <button type="button" className="mini" disabled={!!busy} onClick={() => void act("start", t.name)} title="Start">
            ▶
          </button>
        )
      )}
      {t.live && (
        <button type="button" className="mini" title="Open in a window" onClick={() => window.open(taskShellUrl(repo.id, t.termId, t.name), "_blank", "noopener")}>
          ↗
        </button>
      )}
      {!t.gone && (
        <button type="button" className="mini" onClick={() => editTask(repo.id, t.name)} title="Edit">
          ⋯
        </button>
      )}
    </span>
  );

  return (
    <Section
      repo={repo}
      k="tasks"
      className="tasks"
      label="Tasks"
      head={running ? `${running} running` : tasks.length ? String(tasks.length) : ""}
      title="The repo's dev server, tests and builds, run and watched by canopy"
      copy={() => shown.map((t) => `${t.name}  ${STATUS_WORD[t.status]}  ${t.cmd}`).join("\n")}
      tools={
        !lone && (
          <button
            type="button"
            className={`term-new term-focus task-front-btn${soloed ? " on" : ""}`}
            title={inFront ? benchWord : "Bring the project to the front"}
            aria-label={inFront ? benchWord : "Bring the project to the front"}
            aria-pressed={soloed}
            onClick={flipBench}
          >
            ⧉
          </button>
        )
      }
      below={inFront && picked && <TaskOutput key={picked.name} repo={repo} task={picked} />}
    >
      {errors?.map((e) => (
        <p key={e} className="note err">
          {e}
        </p>
      ))}
      {error && <p className="note err">{error}</p>}
      {shown.length === 0 ? (
        <p className="panel-clean">No tasks yet. Add one, or give the repo a package.json, Cargo.toml or Makefile.</p>
      ) : inFront ? (
        <>
          <nav className="task-tabs" aria-label={`Tasks at ${repo.name}`}>
            {shown.map((t) => (
              <button
                key={t.name}
                type="button"
                className={`task-tab${t.name === picked?.name ? " on" : ""}`}
                aria-current={t.name === picked?.name}
                title={t.cmd}
                onClick={() => pick(t)}
              >
                <span className={`task-dot ${t.status}`} aria-label={STATUS_WORD[t.status]} />
                {t.name}
              </button>
            ))}
          </nav>
          {picked && (
            <div className={`task-row open ${picked.status}`}>
              <span className="task-main">
                <span className="task-cmd" title={picked.cmd}>
                  {picked.cmd}
                </span>
                <span className="task-when">{taskWhen(picked, now)}</span>
              </span>
              {actions(picked)}
            </div>
          )}
        </>
      ) : (
        <ul className="task-list">
          {shown.map((t) => (
            <li key={t.name} className={`task-row ${t.status}${open === t.name ? " open" : ""}`}>
              <button type="button" className="task-main" onClick={() => pick(t)} aria-expanded={open === t.name}>
                <span className={`task-dot ${t.status}`} aria-label={STATUS_WORD[t.status]} />
                <span className="task-name">{t.name}</span>
                <Flags t={t} />
                <span className="task-cmd" title={t.cmd}>
                  {t.cmd}
                </span>
                {t.source !== "detected" && <span className="task-source">{t.source}</span>}
                {t.gone && <span className="task-source">not defined</span>}
                <span className="task-when">{taskWhen(t, now)}</span>
              </button>
              {actions(t)}
            </li>
          ))}
        </ul>
      )}
      {!inFront && (
        <div className="task-foot">
          <button type="button" className="mini" onClick={() => editTask(repo.id, null)}>
            add task
          </button>
          {hidden > 0 && (
            <button type="button" className="mini" onClick={() => setShowHidden(!showHidden)}>
              {showHidden ? "leave hidden out" : `${hidden} hidden`}
            </button>
          )}
        </div>
      )}
      {!inFront && picked && <TaskLog key={picked.name} repo={repo} task={picked} />}
    </Section>
  );
}

const VIEWS = [
  { value: "term", label: "terminal", title: "The task's live terminal, where it can be typed into" },
  { value: "log", label: "log", title: "The task's log, searchable, every run marked" },
] as const satisfies readonly { value: "term" | "log"; label: string; title: string }[];

/** A task's output in front, filling the box: its live terminal while it
 *  runs (joined, never started or ended from here), else its log, with a
 *  switch between the two while both are there. */
function TaskOutput({ repo, task }: { repo: Repo; task: TaskInfo }) {
  const [view, setView] = useState<"term" | "log">("term");
  const showTerm = task.live && view === "term";
  const tab: TermTab = { id: task.termId, repoId: repo.id, name: `${repo.name} · ${task.name}`, path: repo.path, place: "panel", task: task.name };
  return (
    <div className="task-front">
      {task.live && <Seg label="Show" value={showTerm ? "term" : "log"} options={VIEWS} onChange={setView} className="task-view" />}
      {showTerm ? (
        <ShellSpotHere.Provider value="place">
          <div className="term-body">
            {/* a restart is a new view on the new process */}
            <TermView key={`${task.termId}:${task.startedAt ?? 0}`} tab={tab} active />
          </div>
        </ShellSpotHere.Provider>
      ) : (
        <TaskLog repo={repo} task={task} />
      )}
    </div>
  );
}

/** The picked task's log: its tail, read again while it runs, or the lines matching a search. */
function TaskLog({ repo, task }: { repo: Repo; task: TaskInfo }) {
  const [q, setQ] = useState("");
  const [lines, setLines] = useState<TaskLogLine[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the tail stays in view as lines arrive, until the reader scrolls up
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = pre.current;
    if (el && stick.current && !q) el.scrollTop = el.scrollHeight;
  }, [lines, q]);

  useEffect(() => {
    let live = true;
    const read = () =>
      api
        .taskLog(repo.id, task.name, q)
        .then((p) => {
          if (!live) return;
          setLines(p.lines);
          setMore(p.more);
          setError(null);
        })
        .catch((e: unknown) => {
          if (live) setError(errText(e));
        });
    const first = setTimeout(read, q ? 250 : 0);
    const again = (task.status === "running" || task.status === "backoff") && !q ? setInterval(read, TAIL_EVERY) : null;
    return () => {
      live = false;
      clearTimeout(first);
      if (again) clearInterval(again);
    };
  }, [repo.id, task.name, task.status, q]);

  return (
    <div className="task-open">
      {error && <p className="note err">{error}</p>}
      <input className="task-search" type="search" placeholder={`search ${task.name}'s log`} value={q} onChange={(e) => setQ(e.target.value)} />
      <pre
        className="task-log"
        ref={pre}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {more && <span className="task-more">{q ? "earlier lines match too" : "earlier lines are in the log"}{"\n"}</span>}
        {lines?.map((l) => (
          <span key={l.n} className={l.mark ? "task-mark" : undefined}>
            {l.mark && l.at !== null ? `── started ${markTime(l.at)} ──` : l.text}
            {"\n"}
          </span>
        ))}
        {lines?.length === 0 && (q ? "no match" : "nothing logged yet")}
      </pre>
    </div>
  );
}

/** a card's word on its tasks: ▶ n running, or ✕ name in rust for one in trouble */
export function TaskChip({ repoId }: { repoId: string }) {
  const tasks = useStore(useShallow((s) => s.taskAll.filter((t) => t.repoId === repoId)));
  const showTasks = useStore((s) => s.showTasks);
  const chip = taskChip(tasks);
  if (!chip) return null;
  return (
    <button
      type="button"
      className={`run-chip task-chip${chip.bad ? " bad" : ""}`}
      title={chip.title}
      onClick={(e) => {
        e.stopPropagation();
        showTasks(repoId);
      }}
      onAuxClick={(e) => e.stopPropagation()}
      onKeyDown={keepKeys}
    >
      {chip.text}
    </button>
  );
}

/** The top bar's ▶ n: every task that is not idle, on every shown backend,
 *  each with open, restart and stop. Nothing when none is. */
export function TasksChip() {
  const all = useStore((s) => s.taskAll);
  const repos = useStore((s) => s.repos);
  const bringTask = useStore((s) => s.bringTask);
  const taskAct = useStore((s) => s.taskAct);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      escapeCloses(e, () => setOpen(false));
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(tick);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (all.length === 0) return null;
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  const list = [...all].sort((a, b) => repoName(a.repoId).localeCompare(repoName(b.repoId)) || a.name.localeCompare(b.name));
  const chip = taskChip(all);
  const running = all.filter((t) => t.status === "running").length;
  const act = (t: TaskInfo, action: "restart" | "stop") => {
    setError("");
    taskAct(t.repoId, action, t.name).catch((e: unknown) => setError(errText(e)));
  };

  return (
    <div className="settings tasks-chip" ref={ref}>
      <button
        type="button"
        className={`mini${open ? " on" : ""}${chip?.bad ? " bad" : ""}`}
        aria-label="Tasks"
        aria-expanded={open}
        title={chip?.title ?? "Tasks"}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">▶</span> {running}
      </button>
      {open && (
        <div className="settings-pop tasks-pop" role="dialog" aria-label="Tasks">
          <ul className="task-list">
            {list.map((t) => (
              <li key={t.termId} className={`task-row ${t.status}`}>
                <button
                  type="button"
                  className="task-main"
                  disabled={t.gone === "repo"}
                  title={`Bring ${t.name} to the front`}
                  onClick={() => {
                    bringTask(t.repoId, t.name);
                    setOpen(false);
                  }}
                >
                  <span className={`task-dot ${t.status}`} aria-label={STATUS_WORD[t.status]} />
                  <span className="task-name">{repoName(t.repoId)}</span>
                  <span>{t.name}</span>
                  <span className="task-when">{t.gone === "repo" ? "not in scan" : taskWhen(t, now)}</span>
                </button>
                <span className="task-actions">
                  {t.status === "running" && !t.gone && (
                    <button type="button" className="mini" title="Restart" onClick={() => act(t, "restart")}>
                      ↻
                    </button>
                  )}
                  {(t.status === "running" || t.status === "backoff") && (
                    <button type="button" className="mini" title="Stop" onClick={() => act(t, "stop")}>
                      ■
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {error && <p className="note err">{error}</p>}
        </div>
      )}
    </div>
  );
}

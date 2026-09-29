import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { useFitPop } from "../pop";
import { taskShellUrl } from "../routes";
import { tasksOf, useStore } from "../store";
import { markTime, STATUS_WORD, taskChip, taskWhen } from "../tasks";
import type { Repo, TaskInfo, TaskLogLine } from "../../../src/core/types";
import { Section, useSectionClosed } from "./Surface";

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
 *  task's log shows under the list, searchable. */
export function TasksSection({ repo }: { repo: Repo }) {
  const closed = useSectionClosed(repo.id, "tasks");
  const tasks = useStore(useShallow((s) => tasksOf(s, repo.id)));
  const errors = useStore((s) => s.taskErrors[repo.id]);
  const loadTasks = useStore((s) => s.loadTasks);
  const taskAct = useStore((s) => s.taskAct);
  const editTask = useStore((s) => s.editTask);
  const openTaskTab = useStore((s) => s.openTaskTab);
  const [open, setOpen] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (closed) return;
    loadTasks(repo.id).catch((e: unknown) => setError(errText(e)));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [closed, repo.id, loadTasks]);

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

  const pick = (t: TaskInfo) => {
    setOpen(open === t.name ? null : t.name);
    if (t.live && open !== t.name) openTaskTab(repo.id, t, "panel");
  };

  const shown = tasks.filter((t) => showHidden || !t.hidden);
  const hidden = tasks.filter((t) => t.hidden).length;
  const running = tasks.filter((t) => t.status === "running").length;
  const picked = shown.find((t) => t.name === open) ?? null;

  return (
    <Section
      repo={repo}
      k="tasks"
      className="tasks"
      label="Tasks"
      head={running ? `${running} running` : tasks.length ? String(tasks.length) : ""}
      title="The repo's dev server, tests and builds, run and watched by canopy"
      copy={() => shown.map((t) => `${t.name}  ${STATUS_WORD[t.status]}  ${t.cmd}`).join("\n")}
    >
      {errors?.map((e) => (
        <p key={e} className="note err">
          {e}
        </p>
      ))}
      {error && <p className="note err">{error}</p>}
      {shown.length === 0 ? (
        <p className="panel-clean">No tasks yet. Add one, or give the repo a package.json, Cargo.toml or Makefile.</p>
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
            </li>
          ))}
        </ul>
      )}
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
      {picked && <TaskLog key={picked.name} repo={repo} task={picked} />}
    </Section>
  );
}

/** The picked task's log: its tail, read again while it runs, or the lines matching a search. */
function TaskLog({ repo, task }: { repo: Repo; task: TaskInfo }) {
  const [q, setQ] = useState("");
  const [lines, setLines] = useState<TaskLogLine[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <pre className="task-log">
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
  const showTasks = useStore((s) => s.showTasks);
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
      if (e.key === "Escape") setOpen(false);
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
        aria-label="Tasks on this backend"
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
                  onClick={() => {
                    showTasks(t.repoId);
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

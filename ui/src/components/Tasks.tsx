import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { tasksOf, useStore } from "../store";
import { markTime, STATUS_WORD, taskWhen } from "../tasks";
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

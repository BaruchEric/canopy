/**
 * The server's side of tasks: the routes, the per-task lock that keeps two
 * starts from racing, and the supervisor that watches tmux every tick and
 * tells the browsers when a repo's tasks change. A task is a tmux session
 * named like a shell, so the terminal socket joins it with `attach=1`;
 * the shell lists pass over it by its `task` tag.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { interruptTask, listTaskPanes, logPath, readLog, readTaskFiles, readTaskState, startTaskSession, taskTermId, writeTaskState, appendMark } from "../core/taskrun";
import { detectTasks, logPage, mergeTasks, nextDelay, normalizeTaskPatch, parseTaskFile, TASK_TIMINGS, taskStatus, isTaskName, type MergedTask, type TaskTimings } from "../core/tasks";
import { killSession, type TaskPane } from "../core/tmux";
import { loadConfig, setTask, tasksFor } from "../core/store";
import type { Repo, ServerEvent, TaskAction, TaskPatch, TaskInfo, TaskRecord, TasksResult, TermInfo } from "../core/types";

export interface TaskHubDeps {
  /** canopy's tmux argv front; null means no tasks on this backend */
  tmux: string[] | null;
  repos: () => Repo[];
  /** whether a repo is the user's, which is what lets its repo file's auto flags apply */
  own: (repo: Repo) => Promise<boolean>;
  /** the device names with a socket on a session */
  viewers: (termId: string) => string[];
  /** puts a task's session among the ones the terminal socket may join */
  hold: (info: TermInfo) => void;
  broadcast: (ev: ServerEvent) => void;
  /** said when keep running gives up on a task */
  gaveUp: (repo: string, task: string) => void;
  timings?: Partial<TaskTimings>;
}

export class TaskError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Runtime {
  fails: number;
  restarts: number;
  retryAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  gaveUp: boolean;
  lastStart?: number;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ACTIONS: readonly TaskAction[] = ["start", "stop", "restart"];

export class TaskHub {
  private readonly t: TaskTimings;
  private state: Record<string, TaskRecord> = {};
  /** the last pane list, by termId */
  private panes = new Map<string, TaskPane>();
  private rt = new Map<string, Runtime>();
  /** merged definitions by repo path, from the last read */
  private defs = new Map<string, TasksResult & { merged: MergedTask[] }>();
  /** what each repo's tasks looked like when last told, by repo id */
  private told = new Map<string, string>();
  private locks = new Map<string, Promise<unknown>>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private ticking: Promise<void> | null = null;
  /** set by stop(): nothing armed after it may launch */
  private stopped = false;

  constructor(private readonly deps: TaskHubDeps) {
    this.t = { ...TASK_TIMINGS, ...deps.timings };
  }

  async start(): Promise<void> {
    if (!this.deps.tmux) return;
    this.state = await readTaskState();
    await this.tick();
    // A keep task that was meant to run and has no session (the machine
    // went down, or tmux did) starts again. One that died while canopy was
    // down was caught by the tick above, through onDeath.
    for (const [id, rec] of Object.entries(this.state)) {
      // a clean exit stays down, as it does while canopy is up
      if (rec.want !== "running" || rec.exitCode === 0 || this.panes.has(id)) continue;
      const repo = this.deps.repos().find((r) => r.path === rec.path);
      if (!repo) continue;
      const def = (await this.defsOf(repo, true)).merged.find((m) => m.name === rec.name);
      if (!def?.keep || def.hidden) continue;
      await this.lock(id, () => this.launch(repo, def)).catch((err) => console.error(`task ${def.name}: ${err instanceof Error ? err.message : err}`));
    }
    this.timers.push(setInterval(() => void this.poke(), this.t.tick));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    for (const r of this.rt.values()) if (r.timer) clearTimeout(r.timer);
    this.timers = [];
    this.stopped = true;
  }

  /** one tick at a time, never stacked */
  private poke(): Promise<void> {
    if (!this.ticking) this.ticking = this.tick().catch(() => {}).finally(() => (this.ticking = null));
    return this.ticking;
  }

  /** runs `fn` after anything already running for the same task */
  private lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(id, next);
    // the caller sees the rejection; this branch only cleans up
    void next
      .finally(() => {
        if (this.locks.get(id) === next) this.locks.delete(id);
      })
      .catch(() => {});
    return next;
  }

  private runtime(id: string): Runtime {
    let r = this.rt.get(id);
    if (!r) this.rt.set(id, (r = { fails: 0, restarts: 0, gaveUp: false }));
    return r;
  }

  private async save(): Promise<void> {
    await writeTaskState(this.state);
  }

  /* ---------- definitions ---------- */

  private async defsOf(repo: Repo, fresh: boolean): Promise<TasksResult & { merged: MergedTask[] }> {
    const cached = this.defs.get(repo.path);
    if (cached && !fresh) return cached;
    const files = await readTaskFiles(repo.path);
    const file = files.repoFile !== undefined ? parseTaskFile(files.repoFile) : { patches: [], errors: [] };
    const cfg = await loadConfig();
    const { tasks, errors } = mergeTasks(detectTasks(files), file.patches, tasksFor(cfg, repo.path), await this.deps.own(repo));
    const out = { merged: tasks, tasks: [] as TaskInfo[], errors: [...file.errors, ...errors] };
    this.defs.set(repo.path, out);
    return out;
  }

  private info(repo: Repo, d: MergedTask, gone?: TaskInfo["gone"]): TaskInfo {
    const id = taskTermId(repo.path, d.name);
    const p = this.panes.get(id);
    const rec = this.state[id];
    const rt = this.rt.get(id);
    return {
      ...d,
      repoId: repo.id,
      termId: id,
      status: taskStatus({ live: p !== undefined, dead: p?.dead ?? false, want: rec?.want, exitedAt: rec?.exitedAt, exitCode: rec?.exitCode, retryAt: rt?.retryAt, gaveUp: rt?.gaveUp ?? false }),
      live: p !== undefined,
      ...(rec?.startedAt !== undefined ? { startedAt: rec.startedAt } : {}),
      ...(rec?.exitedAt !== undefined ? { exitedAt: rec.exitedAt } : {}),
      ...(rec?.exitCode !== undefined ? { exitCode: rec.exitCode } : {}),
      ...(rt?.retryAt !== undefined ? { retryAt: rt.retryAt } : {}),
      restarts: rt?.restarts ?? 0,
      viewers: this.deps.viewers(id),
      ...(gone ? { gone } : {}),
    };
  }

  /** a repo's tasks, plus any still running under a name no layer defines any more */
  async tasksOf(repo: Repo, fresh: boolean): Promise<TasksResult> {
    const d = await this.defsOf(repo, fresh);
    const tasks = d.merged.map((m) => this.info(repo, m));
    for (const p of this.panes.values()) {
      if (p.path !== repo.path || d.merged.some((m) => m.name === p.task)) continue;
      tasks.push(this.info(repo, { name: p.task, cmd: "", source: "detected" }, "definition"));
    }
    return { tasks, errors: d.errors };
  }

  /** every task that is not idle, across repos, and the ones whose repo left the scan */
  async all(): Promise<TaskInfo[]> {
    const out: TaskInfo[] = [];
    const repos = this.deps.repos();
    for (const repo of repos) {
      if (repo.forge) continue;
      const has = [...this.panes.values()].some((p) => p.path === repo.path) || Object.values(this.state).some((r) => r.path === repo.path && this.rt.get(taskTermId(r.path, r.name))?.retryAt !== undefined);
      if (!has) continue;
      out.push(...(await this.tasksOf(repo, false)).tasks.filter((t) => t.status !== "idle"));
    }
    for (const p of this.panes.values()) {
      if (repos.some((r) => r.path === p.path)) continue;
      const ghost = { id: p.repoId, name: p.repoId, path: p.path } as Repo;
      out.push(this.info(ghost, { name: p.task, cmd: "", source: "detected" }, "repo"));
    }
    return out;
  }

  /** tells the browsers a repo's tasks when they differ from what was last told */
  private async tell(repoId: string): Promise<void> {
    const repo = this.deps.repos().find((r) => r.id === repoId);
    if (!repo) return;
    const { tasks } = await this.tasksOf(repo, false);
    const text = JSON.stringify(tasks);
    if (this.told.get(repoId) === text) return;
    this.told.set(repoId, text);
    this.deps.broadcast({ type: "tasks", repoId, tasks });
  }

  /** a viewer came or went: re-tell every repo with a task session */
  refresh(): void {
    const ids = new Set([...this.panes.values()].map((p) => this.deps.repos().find((r) => r.path === p.path)?.id).filter((x): x is string => !!x));
    for (const id of ids) void this.tell(id);
  }

  /* ---------- actions ---------- */

  private need(): string[] {
    if (!this.deps.tmux) throw new TaskError(503, "tasks need tmux on this backend");
    return this.deps.tmux;
  }

  private async launch(repo: Repo, def: MergedTask): Promise<void> {
    const tmux = this.need();
    const id = taskTermId(repo.path, def.name);
    const at = Date.now();
    // set before anything touches tmux, so a tick listing meanwhile knows this run is newer
    this.runtime(id).lastStart = at;
    try {
      await appendMark(id, at, def.cmd);
    } catch (err) {
      throw new TaskError(500, `cannot write the log at ${logPath(id)}: ${err instanceof Error ? err.message : err}`);
    }
    await startTaskSession(tmux, { id, repoId: repo.id, path: repo.path, task: def.name }, repo.path, def.cmd, def.cwd);
    this.state[id] = { repoId: repo.id, path: repo.path, name: def.name, want: "running", startedAt: at };
    await this.save();
    this.panes.set(id, { termId: id, task: def.name, repoId: repo.id, path: repo.path, dead: false, code: null, createdAt: at });
    this.deps.hold({ id, repoId: repo.id, path: repo.path, place: "strip", attached: false, viewers: [], startedAt: at, task: def.name });
  }

  private running(id: string): boolean {
    const p = this.panes.get(id);
    return p !== undefined && !p.dead;
  }

  private async stopTask(repo: Repo, name: string): Promise<void> {
    const tmux = this.need();
    const id = taskTermId(repo.path, name);
    const rec = this.state[id];
    if (rec) rec.want = "stopped";
    const rt = this.runtime(id);
    if (rt.timer) clearTimeout(rt.timer);
    rt.retryAt = undefined;
    rt.timer = undefined;
    await this.save();
    if (!this.running(id)) return;
    await interruptTask(tmux, id);
    const until = Date.now() + this.t.grace;
    while (Date.now() < until) {
      await this.poke();
      if (!this.running(id)) return;
      await Bun.sleep(100);
    }
    await killSession(tmux, id);
    // a tick already listing began before the kill, so let it finish and look again
    await this.ticking;
    await this.poke();
    const after = this.state[id];
    if (after && after.exitedAt === undefined) {
      after.exitedAt = Date.now();
      after.exitCode = null;
      await this.save();
    }
  }

  async act(repo: Repo, action: TaskAction, name: string | undefined, reason?: string): Promise<TasksResult> {
    this.need();
    if (action === "start" && reason === "panel" && name === undefined) {
      const { merged } = await this.defsOf(repo, true);
      for (const def of merged.filter((m) => m.withPanel && !m.hidden)) {
        const id = taskTermId(repo.path, def.name);
        await this.lock(id, async () => {
          if (this.running(id) || this.rt.get(id)?.gaveUp) return;
          const rt = this.runtime(id);
          if (rt.timer) clearTimeout(rt.timer);
          rt.retryAt = undefined;
          rt.timer = undefined;
          await this.launch(repo, def);
        }).catch((err) => console.error(`task ${def.name}: ${err instanceof Error ? err.message : err}`));
      }
    } else {
      if (!isTaskName(name)) throw new TaskError(400, "name the task");
      const { merged } = await this.defsOf(repo, true);
      const def = merged.find((m) => m.name === name);
      const id = taskTermId(repo.path, name);
      if (action === "stop") {
        if (!def && !this.panes.has(id)) throw new TaskError(404, `no task ${name}`);
        await this.lock(id, () => this.stopTask(repo, name));
      } else {
        if (!def) throw new TaskError(404, `no task ${name}`);
        await this.lock(id, async () => {
          if (action === "start" && this.running(id)) throw new TaskError(409, `${name} is already running`);
          const rt = this.runtime(id);
          if (rt.timer) clearTimeout(rt.timer);
          Object.assign(rt, { fails: 0, restarts: 0, gaveUp: false, retryAt: undefined, timer: undefined });
          await this.launch(repo, def);
        });
      }
    }
    await this.tell(repo.id);
    return this.tasksOf(repo, false);
  }

  /* ---------- the supervisor ---------- */

  /** one look at tmux: records deaths, holds new sessions, tells what changed */
  private async tick(): Promise<void> {
    const tmux = this.deps.tmux;
    if (!tmux) return;
    // A start that lands while the list is being read is newer than the
    // list: its pane is either missing from it or still the old dead one.
    // Those tasks keep what `launch` set rather than what the list says.
    const listedAt = Date.now();
    const newer = (id: string): boolean => (this.rt.get(id)?.lastStart ?? -1) >= listedAt;
    const list = await listTaskPanes(tmux);
    // tmux did not answer (its container restarting): say nothing, mark nothing dead
    if (list === null) return;
    const now = Date.now();
    const next = new Map(list.map((p) => [p.termId, p]));
    const changed = new Set<string>();
    let dirty = false;
    const died = (p: TaskPane, code: number | null) => {
      const rec = this.state[p.termId];
      if (!rec || rec.exitedAt !== undefined) return;
      rec.exitedAt = now;
      rec.exitCode = code;
      dirty = true;
      this.onDeath(p.termId, rec, code);
    };
    for (const [id, p] of this.panes) if (newer(id)) next.set(id, p);
    for (const p of next.values()) {
      if (newer(p.termId)) continue;
      const before = this.panes.get(p.termId);
      if (!before) {
        this.deps.hold({ id: p.termId, repoId: p.repoId, path: p.path, place: "strip", attached: false, viewers: [], startedAt: p.createdAt, task: p.task });
        changed.add(p.path);
      }
      if (p.dead && (!before || !before.dead)) {
        died(p, p.code);
        changed.add(p.path);
      }
    }
    for (const [id, before] of this.panes) {
      if (next.has(id) || newer(id)) continue;
      changed.add(before.path);
      // gone while it ran: killed from outside, which counts as a failure
      if (!before.dead) died(before, null);
    }
    this.panes = next;
    for (const [id, rt] of this.rt) {
      const p = next.get(id);
      if (p && !p.dead && rt.lastStart !== undefined && now - rt.lastStart > this.t.uptime) rt.fails = 0;
    }
    if (dirty) await this.save();
    for (const path of changed) {
      const repo = this.deps.repos().find((r) => r.path === path);
      if (repo) await this.tell(repo.id);
    }
  }

  /** A death under keep running: a restart after the backoff, or giving up
   *  after too many in a row. A clean exit, a stopped task and a task with
   *  no keep flag stay down. A pane killed by a signal has no code and counts
   *  as a failure. */
  private onDeath(id: string, rec: TaskRecord, code: number | null): void {
    if (rec.want !== "running" || code === 0) return;
    const repo = this.deps.repos().find((r) => r.path === rec.path);
    if (!repo) return;
    void this.defsOf(repo, false)
      .then(({ merged }) => {
      if (this.stopped) return;
      const def = merged.find((m) => m.name === rec.name);
      if (!def?.keep || def.hidden) return;
      const rt = this.runtime(id);
      if (rt.timer) clearTimeout(rt.timer);
      rt.fails += 1;
      if (rt.fails >= this.t.giveUp) {
        rt.gaveUp = true;
        this.deps.gaveUp(repo.name, def.name);
        void this.tell(repo.id);
        return;
      }
      const wait = nextDelay(rt.fails, this.t.backoff, this.t.backoffCap);
      rt.retryAt = Date.now() + wait;
      rt.timer = setTimeout(() => {
        void this.lock(id, async () => {
          rt.retryAt = undefined;
          rt.timer = undefined;
          if (this.stopped || this.state[id]?.want !== "running" || this.running(id)) return;
          await this.launch(repo, def);
          rt.restarts += 1;
        })
          .catch((err) => console.error(`task ${def.name}: ${err instanceof Error ? err.message : err}`))
          .finally(() => void this.tell(repo.id));
      }, wait);
      void this.tell(repo.id);
      })
      .catch((err) => console.error(`task ${rec.name}: ${err instanceof Error ? err.message : err}`));
  }

  /** stores one task's definition in canopy's layer or rewrites it in the repo file */
  private async setDef(repo: Repo, name: string, patch: TaskPatch | null, target: "canopy" | "repo"): Promise<void> {
    if (target === "canopy") {
      await setTask(repo.path, name, patch);
    } else {
      if (repo.host) throw new TaskError(400, "the repo file can only be written for a repo on this machine");
      const file = join(repo.path, ".canopy", "tasks.json");
      let list: TaskPatch[] = [];
      try {
        const parsed = parseTaskFile(await readFile(file, "utf8"));
        if (parsed.errors.length) throw new TaskError(409, `fix .canopy/tasks.json first: ${parsed.errors[0]}`);
        list = parsed.patches;
      } catch (err) {
        if (err instanceof TaskError) throw err;
        // no file yet
      }
      list = list.filter((t) => t.name !== name);
      if (patch) list.push(patch);
      await mkdir(join(repo.path, ".canopy"), { recursive: true });
      await writeFile(file, JSON.stringify(list, null, 2) + "\n");
    }
    this.defs.delete(repo.path);
    await this.tell(repo.id);
  }

  /* ---------- routes ---------- */

  async handle(req: Request, url: URL, repoOf: (id: string) => Repo | undefined): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/tasks" && path !== "/api/repos/tasks" && !path.startsWith("/api/repos/tasks/")) return null;
    const method = req.method;
    try {
      this.need();
      if (path === "/api/tasks" && method === "GET") return json(await this.all());
      const repo = repoOf(url.searchParams.get("id") ?? "");
      if (!repo) return json({ error: "unknown repo" }, 404);
      if (repo.forge) return json({ error: `${repo.name} is on the forge; there is nothing to run` }, 400);
      if (path === "/api/repos/tasks" && method === "GET") return json(await this.tasksOf(repo, true));
      if (path === "/api/repos/tasks" && method === "POST") {
        const body = (await req.json().catch(() => null)) as { action?: unknown; name?: unknown; reason?: unknown } | null;
        const action = body?.action;
        if (!ACTIONS.includes(action as TaskAction)) return json({ error: "action is start, stop or restart" }, 400);
        const name = typeof body?.name === "string" ? body.name : undefined;
        const reason = typeof body?.reason === "string" ? body.reason : undefined;
        return json(await this.act(repo, action as TaskAction, name, reason));
      }
      if (path === "/api/repos/tasks/log" && method === "GET") {
        const name = url.searchParams.get("name");
        if (!isTaskName(name)) return json({ error: "name the task" }, 400);
        const before = Number(url.searchParams.get("before"));
        const limit = Number(url.searchParams.get("limit"));
        const raw = await readLog(taskTermId(repo.path, name));
        return json(
          logPage(raw, {
            q: url.searchParams.get("q") ?? "",
            ...(Number.isFinite(before) && before > 0 ? { before } : {}),
            ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.min(limit, 2000) } : {}),
          }),
        );
      }
      if (path === "/api/repos/tasks/def" && method === "POST") {
        const body = (await req.json().catch(() => null)) as { name?: unknown; def?: unknown; target?: unknown } | null;
        if (!isTaskName(body?.name)) return json({ error: "name the task" }, 400);
        const target = body?.target;
        if (target !== "canopy" && target !== "repo") return json({ error: "target is canopy or repo" }, 400);
        let patch: TaskPatch | null = null;
        if (body?.def !== null && body?.def !== undefined) {
          if (typeof body.def !== "object" || Array.isArray(body.def)) return json({ error: "def is an object or null" }, 400);
          const p = normalizeTaskPatch({ ...(body.def as object), name: body.name });
          if (typeof p === "string") return json({ error: p }, 400);
          patch = p;
        }
        await this.setDef(repo, body.name, patch, target);
        return json(await this.tasksOf(repo, true));
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      const status = err instanceof TaskError ? err.status : 500;
      return json({ error: String(err instanceof Error ? err.message : err) }, status);
    }
  }
}

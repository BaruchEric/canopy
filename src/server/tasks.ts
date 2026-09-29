/**
 * The server's side of tasks: the routes, the per-task lock that keeps two
 * starts from racing, and the supervisor that watches tmux every tick and
 * tells the browsers when a repo's tasks change. A task is a tmux session
 * named like a shell, so the terminal socket joins it with `attach=1`;
 * the shell lists pass over it by its `task` tag.
 */
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { interruptTask, listTaskPanes, logPath, readLog, readTaskFiles, readTaskState, startTaskSession, taskTermId, writeTaskState, appendMark, rotateIfBig, repipe, listLogs, removeLog } from "../core/taskrun";
import { detectTasks, logPage, mergeTasks, nextDelay, normalizeTaskPatch, parseTaskFile, expiredTaskLogs, definedFrom, reapable, staleWants, TASK_TIMINGS, taskStatus, isTaskName, listedTask, overrideOf, paneReading, type MergedTask, type TaskTimings } from "../core/tasks";
import { killSession, type TaskPane } from "../core/tmux";
import { loadConfig, setTask, tasksFor } from "../core/store";
import type { Repo, ServerEvent, TaskAction, TaskDef, TaskPatch, TaskInfo, TaskRecord, TasksResult, TermInfo } from "../core/types";

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

/** what a task has in this process only; its failures and giving up are on its record */
interface Runtime {
  restarts: number;
  retryAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  lastStart?: number;
}

const say = (what: string) => (err: unknown) => console.error(`${what}: ${err instanceof Error ? err.message : err}`);

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
  /** whether the last listing answered: undefined before the first, false while tmux does not */
  private answering: boolean | undefined;
  /** since when "no server" has been doubted (see paneReading) */
  private noServerSince: number | undefined;
  /** when this hub started: a death on record from before it was seen by the last canopy */
  private bootAt = Date.now();
  private recovered = false;

  constructor(private readonly deps: TaskHubDeps) {
    this.t = { ...TASK_TIMINGS, ...deps.timings };
  }

  /** whether an id is a task's session, live or remembered: a plain shell
   *  socket must never start or join a session under it */
  knows(termId: string): boolean {
    return this.panes.has(termId) || termId in this.state;
  }

  /** Reads the records and starts the supervisor. Nothing here waits on
   *  tmux, gh or ssh: recovery and the first sweep run once a listing has
   *  answered, after the server is listening. */
  async start(): Promise<void> {
    if (!this.deps.tmux) return;
    this.bootAt = Date.now();
    this.state = await readTaskState();
    this.timers.push(setInterval(() => void this.poke(), this.t.tick));
    this.timers.push(setInterval(() => void this.sweep().catch(say("task sweep")), this.t.sweep));
    void this.poke();
  }

  /** A keep task that was meant to run comes back: one with no session at
   *  all (the machine or tmux went down) starts now, one whose death is on
   *  record from before this canopy goes back to its backoff, dead pane or
   *  not. A clean exit and a task keep running gave up on stay down. */
  private async recover(): Promise<void> {
    for (const [id, rec] of Object.entries(this.state)) {
      if (this.stopped) return;
      if (rec.want !== "running" || rec.exitCode === 0 || rec.gaveUp || this.running(id)) continue;
      // a death this process saw is onDeath's, already armed or about to be
      if (rec.exitedAt !== undefined && rec.exitedAt >= this.bootAt) continue;
      const repo = this.deps.repos().find((r) => r.path === rec.path);
      if (!repo) continue;
      const def = (await this.defsOf(repo, true)).merged.find((m) => m.name === rec.name);
      if (!def?.keep || def.hidden || this.state[id] !== rec) continue;
      if (rec.exitedAt !== undefined) {
        this.arm(id, repo, def);
        void this.tell(repo.id);
      } else await this.lock(id, () => this.launch(repo, def, false)).catch(say(`task ${def.name}`));
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    for (const r of this.rt.values()) if (r.timer) clearTimeout(r.timer);
    this.timers = [];
    this.stopped = true;
  }

  /** one tick at a time, never stacked */
  private poke(): Promise<void> {
    if (!this.ticking) this.ticking = this.tick().catch(say("task supervisor")).finally(() => (this.ticking = null));
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
    if (!r) this.rt.set(id, (r = { restarts: 0 }));
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

  /** a task as the layers under canopy's merge it: what an override is a diff against */
  private async below(repo: Repo, name: string): Promise<TaskDef | undefined> {
    const files = await readTaskFiles(repo.path);
    const file = files.repoFile !== undefined ? parseTaskFile(files.repoFile) : { patches: [], errors: [] };
    return mergeTasks(detectTasks(files), file.patches, [], await this.deps.own(repo)).tasks.find((t) => t.name === name);
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
      status: taskStatus({ live: p !== undefined, dead: p?.dead ?? false, want: rec?.want, exitedAt: rec?.exitedAt, exitCode: rec?.exitCode, retryAt: rt?.retryAt, gaveUp: rec?.gaveUp ?? false }),
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

  /** Every task the top bar lists (`listedTask`, the same test the browser
   *  applies to a `tasks` event), across repos, and the sessions whose repo
   *  left the scan. Only a repo with a session or a record can have one. */
  async all(): Promise<TaskInfo[]> {
    const out: TaskInfo[] = [];
    const repos = this.deps.repos();
    for (const repo of repos) {
      if (repo.forge) continue;
      const has = [...this.panes.values()].some((p) => p.path === repo.path) || Object.values(this.state).some((r) => r.path === repo.path);
      if (!has) continue;
      out.push(...(await this.tasksOf(repo, false)).tasks.filter(listedTask));
    }
    out.push(...this.ghosts());
    return out;
  }

  /** a task session whose repo left the scan, as a repo that only has an id and a path */
  private ghostRepo(repoId: string, path: string): Repo {
    return { id: repoId, name: repoId, path } as Repo;
  }

  private ghosts(repoId?: string): TaskInfo[] {
    const repos = this.deps.repos();
    const out: TaskInfo[] = [];
    for (const p of this.panes.values()) {
      if (repos.some((r) => r.path === p.path) || (repoId !== undefined && p.repoId !== repoId)) continue;
      out.push(this.info(this.ghostRepo(p.repoId, p.path), { name: p.task, cmd: "", source: "detected" }, "repo"));
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

  /** Runs a task. `fresh` is a start by hand: it forgets the failures in a
   *  row and a gave-up; a retry or a recovery carries them on. */
  private async launch(repo: Repo, def: MergedTask, fresh: boolean): Promise<void> {
    const tmux = this.need();
    // tmux not answering may be its container restarting: a start now could
    // make a second server, or land on one about to go
    if (this.answering === false) throw new TaskError(503, "tmux is not answering; try again in a moment");
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
    const fails = fresh ? 0 : (this.state[id]?.fails ?? 0);
    this.state[id] = { repoId: repo.id, path: repo.path, name: def.name, want: "running", startedAt: at, ...(fails ? { fails } : {}) };
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
    // Known gone: the next listing need not say so. Killing the last session
    // ends the tmux server, and a pane still held as live here would have
    // the listing doubt that as tmux restarting and show the task running.
    this.panes.delete(id);
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

  /** Stops a task whose repo left the scan, the top bar's one action on it.
   *  Its definition is not read: the folder may be gone. Tells the browsers
   *  what is left under that repo id, since no repo event will. */
  private async stopGhost(repoId: string, name: string): Promise<TasksResult | null> {
    const pane = [...this.panes.values()].find((p) => p.repoId === repoId && p.task === name);
    const rec = Object.values(this.state).find((r) => r.repoId === repoId && r.name === name);
    const path = pane?.path ?? rec?.path;
    if (path === undefined) return null;
    const ghost = this.ghostRepo(repoId, path);
    await this.lock(taskTermId(path, name), () => this.stopTask(ghost, name));
    const tasks = this.ghosts(repoId);
    this.deps.broadcast({ type: "tasks", repoId, tasks });
    return { tasks, errors: [] };
  }

  async act(repo: Repo, action: TaskAction, name: string | undefined, reason?: string): Promise<TasksResult> {
    this.need();
    if (action === "start" && reason === "panel" && name === undefined) {
      const { merged } = await this.defsOf(repo, true);
      for (const def of merged.filter((m) => m.withPanel && !m.hidden)) {
        const id = taskTermId(repo.path, def.name);
        await this.lock(id, async () => {
          if (this.running(id) || this.state[id]?.gaveUp) return;
          const rt = this.runtime(id);
          if (rt.timer) clearTimeout(rt.timer);
          rt.retryAt = undefined;
          rt.timer = undefined;
          await this.launch(repo, def, false);
        }).catch(say(`task ${def.name}`));
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
          Object.assign(rt, { restarts: 0, retryAt: undefined, timer: undefined });
          await this.launch(repo, def, true);
        });
      }
    }
    await this.tell(repo.id);
    return this.tasksOf(repo, false);
  }

  /* ---------- the supervisor ---------- */

  /** Clears what gone tasks left: dead panes nobody watches, then logs and
   *  records of tasks with no definition and no session. Never a live process. */
  private async sweep(): Promise<void> {
    const tmux = this.deps.tmux;
    if (!tmux || this.stopped) return;
    // the guarded path: never beside the interval's own tick
    await this.ticking;
    await this.poke();
    if (this.stopped) return;
    const now = Date.now();
    for (const id of Array.from(this.panes.keys())) {
      await this.lock(id, async () => {
        // re-read under the lock: a start may have reused the pane since
        const p = this.panes.get(id);
        if (this.stopped || !p) return;
        const rec = this.state[id];
        if (reapable({ dead: p.dead, ...(rec?.exitedAt !== undefined ? { exitedAt: rec.exitedAt } : {}), viewers: this.deps.viewers(id).length }, Date.now(), this.t.reap)) {
          await killSession(tmux, id);
          // known gone; see stopTask
          this.panes.delete(id);
        }
      }).catch(say("task sweep"));
    }
    await this.poke();
    if (this.stopped) return;
    const known = new Map<string, boolean | null>();
    const lookup = async (id: string) => {
      const rec = this.state[id];
      const repo = rec ? this.deps.repos().find((r) => r.path === rec.path) : undefined;
      if (!rec || !repo) known.set(id, false);
      else if (repo.host) known.set(id, null);
      else known.set(id, (await this.defsOf(repo, true)).merged.some((m) => m.name === rec.name));
    };
    const logs = await listLogs();
    for (const id of new Set([...logs.map((l) => l.termId), ...Object.keys(this.state)])) await lookup(id);
    const defined = definedFrom(known);
    const candidates = new Set([...expiredTaskLogs(logs, new Set(this.panes.keys()), defined, now, this.t.logAge), ...staleWants(this.state, new Set(this.panes.keys()), defined)]);
    for (const id of candidates) {
      await this.lock(id, async () => {
        if (this.stopped || this.panes.has(id)) return;
        // look again inside the lock: a start may have brought it back
        await lookup(id);
        const again = definedFrom(known);
        const fresh = await listLogs();
        for (const gone of expiredTaskLogs(fresh, new Set(this.panes.keys()), again, Date.now(), this.t.logAge)) if (gone === id) await removeLog(id);
        if (staleWants(this.state, new Set(this.panes.keys()), again).includes(id)) {
          delete this.state[id];
          await this.save();
        }
      }).catch(say("task sweep"));
    }
  }

  /** one look at tmux: records deaths, holds new sessions, tells what changed */
  private async tick(): Promise<void> {
    const tmux = this.deps.tmux;
    if (!tmux) return;
    // A start that lands while the list is being read is newer than the
    // list: its pane is either missing from it or still the old dead one.
    // Those tasks keep what `launch` set rather than what the list says.
    const listedAt = Date.now();
    const newer = (id: string): boolean => (this.rt.get(id)?.lastStart ?? -1) >= listedAt;
    const got = await listTaskPanes(tmux);
    const hadLive = [...this.panes.values()].some((p) => !p.dead);
    const reading = paneReading(got, hadLive, this.noServerSince, Date.now(), this.t.noServerGrace);
    this.noServerSince = reading.since;
    this.answering = reading.panes !== null;
    // tmux did not answer, or said no server right after live panes (its
    // container restarting): say nothing, mark nothing dead
    const list = reading.panes;
    if (list === null) return;
    if (!this.recovered) {
      // the first answer: bring back what was meant to run, then clear what
      // gone tasks left, both after this tick rather than inside it
      this.recovered = true;
      void Promise.resolve()
        .then(() => this.recover())
        .catch(say("task recovery"))
        .then(() => this.sweep())
        .catch(say("task sweep"));
    }
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
      // every tick, not only a new pane's first: holding is idempotent, and a
      // shell list read before a launch could otherwise drop what it held
      this.deps.hold({ id: p.termId, repoId: p.repoId, path: p.path, place: "strip", attached: false, viewers: [], startedAt: p.createdAt, task: p.task });
      if (!before) changed.add(p.path);
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
    for (const p of next.values()) {
      if (this.stopped) break;
      if (!p.dead && (await rotateIfBig(p.termId, this.t.logCap))) await repipe(tmux, p.termId);
    }
    // a good stretch up forgets the failures in a row; read off the record,
    // so a task running since before a canopy restart counts too
    for (const [id, rec] of Object.entries(this.state)) {
      const p = next.get(id);
      if (!rec.fails || !p || p.dead || rec.startedAt === undefined || now - rec.startedAt <= this.t.uptime) continue;
      delete rec.fails;
      dirty = true;
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
    if (rec.want !== "running" || code === 0 || rec.gaveUp) return;
    const repo = this.deps.repos().find((r) => r.path === rec.path);
    if (!repo) return;
    void this.defsOf(repo, false)
      .then(async ({ merged }) => {
        // a stop or a new start in the meantime has the last word
        if (this.stopped || this.state[id] !== rec || rec.want !== "running") return;
        const def = merged.find((m) => m.name === rec.name);
        if (!def?.keep || def.hidden) return;
        // everything decided before the save's await, so nothing can land in between
        rec.fails = (rec.fails ?? 0) + 1;
        if (rec.fails >= this.t.giveUp) {
          rec.gaveUp = true;
          this.deps.gaveUp(repo.name, def.name);
        } else this.arm(id, repo, def);
        void this.tell(repo.id);
        await this.save();
      })
      .catch(say(`task ${rec.name}`));
  }

  /** Starts a keep task again after the backoff its record's failures call
   *  for. While tmux does not answer the retry waits a tick at a time, so
   *  nothing starts a session on a server that is not there. */
  private arm(id: string, repo: Repo, def: MergedTask): void {
    const rt = this.runtime(id);
    if (rt.timer) clearTimeout(rt.timer);
    const wait = nextDelay(this.state[id]?.fails ?? 1, this.t.backoff, this.t.backoffCap);
    const fire = () =>
      void this.lock(id, async () => {
        rt.retryAt = undefined;
        rt.timer = undefined;
        if (this.stopped || this.state[id]?.want !== "running" || this.state[id]?.gaveUp || this.running(id)) return;
        if (this.answering === false) {
          rt.retryAt = Date.now() + this.t.tick;
          rt.timer = setTimeout(fire, this.t.tick);
          return;
        }
        await this.launch(repo, def, false);
        rt.restarts += 1;
      })
        .catch(say(`task ${def.name}`))
        .finally(() => void this.tell(repo.id));
    rt.retryAt = Date.now() + wait;
    rt.timer = setTimeout(fire, wait);
  }

  /** stores one task's definition in canopy's layer or rewrites it in the repo file */
  private async setDef(repo: Repo, name: string, patch: TaskPatch | null, target: "canopy" | "repo"): Promise<void> {
    if (target === "canopy") {
      // only what differs from the layers under it, so a later change there shows through
      await setTask(repo.path, name, patch ? overrideOf(patch, await this.below(repo, name)) : null);
    } else {
      if (repo.host) throw new TaskError(400, "the repo file can only be written for a repo on this machine");
      const dir = join(repo.path, ".canopy");
      const file = join(dir, "tasks.json");
      // never written through a link: a checked-in link could point the write anywhere
      for (const p of [dir, file]) {
        const st = await lstat(p).catch(() => null);
        if (st?.isSymbolicLink()) throw new TaskError(409, `${p === dir ? ".canopy" : ".canopy/tasks.json"} is a symbolic link; canopy will not write through it`);
        if (st && p === file && !st.isFile()) throw new TaskError(409, ".canopy/tasks.json is not a file");
      }
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
      await mkdir(dir, { recursive: true });
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
      const repoId = url.searchParams.get("id") ?? "";
      const repo = repoOf(repoId);
      if (!repo && path === "/api/repos/tasks" && method === "POST") {
        // a task whose repo left the scan can still be stopped from the top bar
        const body = (await req.json().catch(() => null)) as { action?: unknown; name?: unknown } | null;
        const done = body?.action === "stop" && isTaskName(body.name) ? await this.stopGhost(repoId, body.name) : null;
        return done ? json(done) : json({ error: "unknown repo" }, 404);
      }
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

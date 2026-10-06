/**
 * The task hub on its own, with fake deps and a tmux server of its own under
 * a scratch config dir per test: what a canopy restart, a gone repo and a
 * tmux server that goes away do to the supervisor.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTaskPanes, taskTermId } from "../core/taskrun";
import { killServer, killSession, tmuxBase } from "../core/tmux";
import type { TaskTimings } from "../core/tasks";
import type { Repo, ServerEvent, TaskInfo, TasksResult, TermInfo } from "../core/types";
import { TaskHub, type TaskHubDeps } from "./tasks";

const tmux = Bun.which("tmux") !== null;
setDefaultTimeout(30_000);
const previous = process.env["CANOPY_CONFIG_DIR"];
let scratch = "";
let n = 0;
let hubs: TaskHub[] = [];
let app: Repo;
let solo: Repo;

const TIMINGS: Partial<TaskTimings> = { tick: 50, grace: 300, backoff: 100, backoffCap: 200, giveUp: 3, uptime: 60_000, sweep: 3_600_000 };

async function until(pred: () => Promise<boolean>, what: string, ms = 15_000) {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(25);
  }
}

async function makeRepo(name: string, tasks: object[]): Promise<Repo> {
  const path = join(scratch, "root", name);
  await mkdir(join(path, ".canopy"), { recursive: true });
  await writeFile(join(path, ".canopy/tasks.json"), JSON.stringify(tasks));
  return { id: name, name, path } as Repo;
}

let repos: Repo[] = [];

function hub(over: Partial<TaskHubDeps> & { timings?: Partial<TaskTimings> } = {}): TaskHub {
  const h = new TaskHub({
    tmux: tmuxBase(),
    repos: () => repos,
    own: async () => true,
    viewers: () => [],
    hold: () => {},
    broadcast: () => {},
    gaveUp: () => {},
    ...over,
    timings: { ...TIMINGS, ...over.timings },
  });
  hubs.push(h);
  return h;
}

const info = async (h: TaskHub, name: string, repo = app): Promise<TaskInfo> => (await h.tasksOf(repo, false)).tasks.find((t) => t.name === name)!;
const panes = async () => {
  const r = await listTaskPanes(tmuxBase()!);
  return Array.isArray(r) ? r : [];
};
const record = async (id: string) =>
  (JSON.parse(await readFile(join(process.env["CANOPY_CONFIG_DIR"]!, "tasks/state.json"), "utf8")) as Record<string, { fails?: number; gaveUp?: boolean; exitedAt?: number }>)[id];

const post = (h: TaskHub, path: string, body: unknown, repoOf: (id: string) => Repo | undefined) => {
  const url = new URL(`http://x${path}`);
  return h.handle(new Request(url.href, { method: "POST", body: JSON.stringify(body) }), url, repoOf);
};

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-tasks-hub-"));
  app = await makeRepo("app", [
    { name: "crash", cmd: "echo crash; exit 1", keep: true },
    { name: "runner", cmd: "echo up; sleep 30", keep: true },
    { name: "late", cmd: "sleep 0.4; exit 1", keep: true },
  ]);
  solo = await makeRepo("solo", [{ name: "lonely", cmd: "trap '' INT; echo lonely; sleep 30" }]);
});

beforeEach(async () => {
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, `config-${++n}`);
  repos = [app, solo];
  hubs = [];
  await writeFile(
    join(app.path, ".canopy/tasks.json"),
    JSON.stringify([
      { name: "crash", cmd: "echo crash; exit 1", keep: true },
      { name: "runner", cmd: "echo up; sleep 30", keep: true },
      { name: "late", cmd: "sleep 0.4; exit 1", keep: true },
    ]),
  );
});

afterEach(async () => {
  for (const h of hubs) h.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
});

afterAll(async () => {
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

describe.skipIf(!tmux)("keep running across a canopy restart", () => {
  test("a task waiting on its backoff, dead pane and all, is started again", async () => {
    const first = hub({ timings: { backoff: 5000, backoffCap: 5000 } });
    await first.start();
    await first.act(app, "start", "crash");
    await until(async () => (await info(first, "crash")).status === "backoff", "the first backoff");
    // the backoff shows from memory; the next canopy only knows the death once it is saved
    await until(async () => (await record(taskTermId(app.path, "crash")))?.fails === 1, "the death on disk");
    first.stop();
    const next = hub();
    await next.start();
    await until(async () => (await info(next, "crash")).restarts >= 1, "the retry after the restart");
  });

  test("a task killed from outside while it backs off is retried, not started fresh", async () => {
    const first = hub({ timings: { backoff: 5000, backoffCap: 5000 } });
    await first.start();
    // another session keeps the tmux server up: killing the last one ends it,
    // which reads as tmux going away rather than the task dying
    await first.act(solo, "start", "lonely");
    await first.act(app, "start", "runner");
    const id = taskTermId(app.path, "runner");
    await killSession(tmuxBase()!, id);
    await until(async () => (await info(first, "runner")).status === "backoff", "the backoff after the kill");
    // the backoff shows from memory; the next canopy only knows the death once it is saved
    await until(async () => (await record(id))?.fails === 1, "the death on disk");
    first.stop();
    const next = hub();
    await next.start();
    await until(async () => {
      const t = await info(next, "runner");
      return t.status === "running" && t.restarts >= 1;
    }, "the retry after the restart");
  });

  test("giving up tells once, stays given up across a restart, and a start by hand clears it", async () => {
    let told = 0;
    const first = hub({ gaveUp: () => told++, timings: { backoff: 50, backoffCap: 50 } });
    await first.start();
    await first.act(app, "start", "crash");
    await until(async () => (await info(first, "crash")).status === "gave-up", "giving up");
    await Bun.sleep(300);
    expect(told).toBe(1);
    const id = taskTermId(app.path, "crash");
    expect((await record(id))?.gaveUp).toBe(true);
    first.stop();
    let toldAgain = 0;
    const next = hub({ gaveUp: () => toldAgain++, timings: { backoff: 5000, backoffCap: 5000 } });
    await next.start();
    await Bun.sleep(400);
    const t = await info(next, "crash");
    expect(t.status).toBe("gave-up");
    expect(t.restarts).toBe(0);
    expect(toldAgain).toBe(0);
    await next.act(app, "start", "crash");
    await until(async () => (await info(next, "crash")).status === "backoff", "a fresh backoff");
    // the backoff shows from memory, the record follows once it is saved
    await until(async () => (await record(id))?.fails === 1, "the failure on disk");
    expect((await record(id))?.gaveUp).toBeUndefined();
  });

  test("stop cancels a pending retry", async () => {
    const h = hub({ timings: { backoff: 800, backoffCap: 800 } });
    await h.start();
    await h.act(app, "start", "crash");
    await until(async () => (await info(h, "crash")).status === "backoff", "the backoff");
    await h.act(app, "stop", "crash");
    expect((await info(h, "crash")).status).toBe("stopped");
    await Bun.sleep(1100);
    const t = await info(h, "crash");
    expect(t.status).toBe("stopped");
    expect(t.restarts).toBe(0);
  });

  test("a pending retry reloads the public definition and stops when keep is turned off", async () => {
    const h = hub({ timings: { backoff: 1500, backoffCap: 1500 } });
    await h.start();
    await h.act(app, "start", "crash");
    await until(async () => (await info(h, "crash")).status === "backoff", "the backoff");
    const res = (await post(h, "/api/repos/tasks/def?id=app", { name: "crash", def: { name: "crash", cmd: "echo crash; exit 1", keep: false }, target: "repo" }, () => app))!;
    expect(res.status).toBe(200);
    await until(async () => (await info(h, "crash")).status === "failed", "the retry to give way");
    // "failed" also shows while the retry reads the definition, so let it land
    await Bun.sleep(300);
    expect((await info(h, "crash")).status).toBe("failed");
    expect((await info(h, "crash")).restarts).toBe(0);
  });

  test("a pending retry uses an edited command", async () => {
    const h = hub({ timings: { backoff: 1500, backoffCap: 1500 } });
    await h.start();
    await h.act(app, "start", "crash");
    await until(async () => (await info(h, "crash")).status === "backoff", "the backoff");
    const res = (await post(h, "/api/repos/tasks/def?id=app", { name: "crash", def: { name: "crash", cmd: "echo changed; sleep 30", keep: true }, target: "repo" }, () => app))!;
    expect(res.status).toBe(200);
    const id = taskTermId(app.path, "crash");
    await until(async () => (await Bun.file(join(process.env["CANOPY_CONFIG_DIR"]!, `tasks/logs/${id}.log`)).text()).includes("changed"), "the edited command output");
    await until(async () => (await info(h, "crash")).status === "running", "the edited task running");
    // the retry that was pending already ran the edit, not one more crash first
    expect((await info(h, "crash")).restarts).toBe(1);
    await h.act(app, "stop", "crash");
  });

  test("a pending retry stays down when its repo leaves the scan", async () => {
    const h = hub({ timings: { backoff: 1500, backoffCap: 1500 } });
    await h.start();
    await h.act(app, "start", "crash");
    await until(async () => (await info(h, "crash")).status === "backoff", "the backoff");
    repos = [solo];
    await until(async () => (await info(h, "crash")).status === "failed", "the retry to give way");
    // "failed" also shows while the retry reads the definition, so let it land
    await Bun.sleep(300);
    expect((await info(h, "crash")).status).toBe("failed");
    expect((await info(h, "crash")).restarts).toBe(0);
  });

  test("a pending retry stays down when the current definition is hidden", async () => {
    const h = hub({ timings: { backoff: 1500, backoffCap: 1500 } });
    await h.start();
    await h.act(app, "start", "crash");
    await until(async () => (await info(h, "crash")).status === "backoff", "the backoff");
    await writeFile(join(app.path, ".canopy/tasks.json"), JSON.stringify([{ name: "crash", cmd: "echo crash; exit 1", keep: true, hidden: true }]));
    await until(async () => (await info(h, "crash")).status === "failed", "the retry to give way");
    // "failed" also shows while the retry reads the definition, so let it land
    await Bun.sleep(300);
    expect((await info(h, "crash")).status).toBe("failed");
    expect((await info(h, "crash")).restarts).toBe(0);
  });

  test("a stop while a death is being looked at leaves it stopped, not restarting", async () => {
    const first = hub();
    await first.start();
    await first.act(app, "start", "late");
    first.stop();
    const id = taskTermId(app.path, "late");
    // a busy machine can be slow to start the pane and see it exit
    await until(async () => (await panes()).some((p) => p.termId === id && p.dead), "late to exit", 25_000);
    // the next canopy's first look at the definitions is slow, which is the gap
    let slow = true;
    const next = hub({
      own: async () => {
        if (slow) {
          slow = false;
          await Bun.sleep(700);
        }
        return true;
      },
      timings: { backoff: 5000, backoffCap: 5000 },
    });
    await next.start();
    await until(async () => (await info(next, "late")).exitedAt !== undefined, "the death on record", 25_000);
    await next.act(app, "stop", "late");
    await Bun.sleep(900);
    expect((await info(next, "late")).status).toBe("stopped");
  }, 60_000);
});

describe.skipIf(!tmux)("the supervisor", () => {
  test("no server right after live panes is doubted for the grace, then believed", async () => {
    const h = hub({ timings: { noServerGrace: 1500 } });
    await h.start();
    await h.act(app, "start", "runner");
    await killServer(tmuxBase()!);
    await Bun.sleep(600);
    const during = await info(h, "runner");
    expect(during.status).toBe("running");
    expect(during.restarts).toBe(0);
    await until(async () => (await info(h, "runner")).restarts >= 1, "the restart once the grace is over");
  });

  test("every live task pane is held again on each tick", async () => {
    const held: string[] = [];
    const h = hub({ hold: (t: TermInfo) => void held.push(t.id) });
    await h.start();
    await h.act(app, "start", "runner");
    const id = taskTermId(app.path, "runner");
    held.length = 0;
    await Bun.sleep(300);
    expect(held.filter((x) => x === id).length).toBeGreaterThanOrEqual(2);
  });

  test("a start does not wait on recovery or the repo checks", async () => {
    const first = hub();
    await first.start();
    await first.act(app, "start", "runner");
    first.stop();
    const next = hub({ own: () => new Promise<boolean>(() => {}) });
    const won = await Promise.race([next.start().then(() => "started"), Bun.sleep(1000).then(() => "stuck")]);
    expect(won).toBe("started");
  });

  test("the sweep runs once at startup, not only after an hour", async () => {
    const dir = join(process.env["CANOPY_CONFIG_DIR"]!, "tasks/logs");
    await mkdir(dir, { recursive: true });
    const stale = join(dir, `${"e".repeat(32)}.log`);
    await writeFile(stale, "old\n");
    await utimes(stale, new Date(0), new Date(0));
    const h = hub({ timings: { logAge: 1000 } });
    await h.start();
    await until(async () => !(await Bun.file(stale).exists()), "the stale log to go");
  });

  test("a task stopped and killed stays in the top bar's list as stopped", async () => {
    const h = hub();
    await h.start();
    await h.act(solo, "start", "lonely");
    const id = taskTermId(solo.path, "lonely");
    await until(async () => (await readFile(join(process.env["CANOPY_CONFIG_DIR"]!, `tasks/logs/${id}.log`), "utf8")).split(/\r?\n/).includes("lonely"), "lonely's output");
    await h.act(solo, "stop", "lonely");
    const all = await h.all();
    expect(all.find((t) => t.name === "lonely")).toMatchObject({ status: "stopped", live: false });
  });
});

describe.skipIf(!tmux)("routes", () => {
  test("a task whose repo left the scan can still be stopped", async () => {
    const events: ServerEvent[] = [];
    const h = hub({ broadcast: (ev) => void events.push(ev) });
    await h.start();
    await h.act(app, "start", "runner");
    const id = taskTermId(app.path, "runner");
    repos = [solo];
    await until(async () => (await h.all()).some((t) => t.name === "runner" && t.gone === "repo"), "runner listed as not in scan");
    const res = (await post(h, "/api/repos/tasks?id=app", { action: "stop", name: "runner" }, () => undefined))!;
    expect(res.status).toBe(200);
    // its dead pane stays until the sweep reaps it, listed as stopped
    const stopped = (t: TaskInfo) => t.name !== "runner" || (t.status === "stopped" && t.gone === "repo");
    expect(((await res.json()) as TasksResult).tasks.every(stopped)).toBe(true);
    expect((await panes()).some((p) => p.termId === id && !p.dead)).toBe(false);
    expect(events.some((e) => e.type === "tasks" && e.repoId === "app" && e.tasks.every(stopped))).toBe(true);
    expect((await h.all()).every(stopped)).toBe(true);
  });

  test("the repo file is never written through a link", async () => {
    const h = hub();
    await h.start();
    const elsewhere = join(scratch, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const linked = join(scratch, "root", "linked");
    await mkdir(linked, { recursive: true });
    await symlink(elsewhere, join(linked, ".canopy"));
    const fileLinked = await makeRepo("filelinked", []);
    await rm(join(fileLinked.path, ".canopy/tasks.json"));
    await symlink(join(elsewhere, "target.json"), join(fileLinked.path, ".canopy/tasks.json"));
    const byId: Record<string, Repo> = { linked: { id: "linked", name: "linked", path: linked } as Repo, filelinked: fileLinked };
    for (const id of ["linked", "filelinked"]) {
      const res = (await post(h, `/api/repos/tasks/def?id=${id}`, { name: "x", def: { name: "x", cmd: "true" }, target: "repo" }, (i) => byId[i]))!;
      expect(res.status).toBe(409);
    }
    expect(await Bun.file(join(elsewhere, "tasks.json")).exists()).toBe(false);
    expect(await Bun.file(join(elsewhere, "target.json")).exists()).toBe(false);
  });
});

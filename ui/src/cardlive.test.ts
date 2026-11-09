import { describe, expect, test } from "bun:test";
import type { AgentCard, TaskInfo, TermInfo } from "../../src/core/types";
import {
  LIVE_CAP,
  TRACE_MS,
  departed,
  lastEnded,
  liveEdge,
  liveFlow,
  liveGlyph,
  liveGroups,
  liveHead,
  liveMarks,
  traceFits,
  traceUntil,
  traceWords,
  type LiveInput,
  type LiveMark,
  type LiveTrace,
  type ShellMark,
  type TaskMark,
} from "./cardlive";

const M = 60_000;
const H = 60 * M;

/** home ids are plain, another backend's carry its name and a bar */
const split = (id: string): [string, string] => {
  const i = id.indexOf("|");
  return i < 0 ? ["mac", id] : [id.slice(0, i), id.slice(i + 1)];
};

let n = 0;
function agent(over: Partial<AgentCard> = {}): AgentCard {
  n++;
  return {
    id: `claude:s${n}`,
    handle: `app-${n}`,
    node: "ericmac",
    harness: "claude",
    session: `s${n}`,
    origin: "elsewhere",
    cwd: "/dev/app",
    repo: null,
    branch: "main",
    model: null,
    mode: null,
    state: "working",
    waiting: null,
    caps: [],
    offers: [],
    notifyIdle: false,
    where: { os: "darwin", container: false, pid: 1, term: "kitty", canopy: null },
    transcript: null,
    startedAt: n,
    seenAt: n,
    endedAt: null,
    ...over,
  };
}

const task = (over: Partial<TaskInfo> = {}): TaskInfo => ({ name: "dev", cmd: "x", repoId: "app", source: "detected", termId: "0".repeat(32), status: "running", live: true, restarts: 0, viewers: [], ...over });

const shell = (over: Partial<TermInfo> = {}): TermInfo => ({ id: "t1", repoId: "app", path: "/dev/app", place: "strip", attached: false, viewers: [], startedAt: 0, ...over });

const input = (over: Partial<LiveInput> = {}): LiveInput => ({ lead: "app", agents: [], trail: {}, tasks: [], shells: [], split, ...over });

const states = (marks: readonly LiveMark[]): string[] => marks.map((m) => `${m.kind}:${m.state}`);
const tasksOf = (marks: readonly LiveMark[]): TaskMark[] => marks.flatMap((m) => (m.kind === "task" ? [m] : []));
const shellsOf = (marks: readonly LiveMark[]): ShellMark[] => marks.flatMap((m) => (m.kind === "shell" ? [m] : []));

describe("the marks", () => {
  test("a quiet repo has none", () => {
    expect(liveMarks(input())).toEqual([]);
    expect(liveMarks(input({ agents: [agent({ state: "ended" }), agent({ state: "lost" })], tasks: [task({ status: "idle" }), task({ status: "exited" }), task({ status: "stopped" })] }))).toEqual([]);
  });

  test("agents first, the one that waits before the ones at work, the idle last", () => {
    const idle = agent({ state: "idle" });
    const working = agent({ state: "working" });
    const waiting = agent({ state: "waiting", waiting: "permission: Bash" });
    const marks = liveMarks(input({ agents: [idle, working, waiting] }));
    expect(states(marks)).toEqual(["agent:waiting", "agent:working", "agent:idle"]);
    expect(marks[0]).toMatchObject({ id: `agent:${waiting.id}`, repoId: "app", title: `${waiting.handle}: waiting: permission: Bash, kitty on ericmac` });
  });

  test("an agent's since is when the page saw it take its state", () => {
    const seen = agent({ state: "working" });
    const met = agent({ state: "working" });
    const marks = liveMarks(input({ agents: [seen, met], trail: { [seen.id]: [{ state: "idle", at: 5 }, { state: "working", at: 9 }], [met.id]: [{ state: "idle", at: 5 }] } }));
    expect(marks.find((m) => m.id === `agent:${seen.id}`)?.since).toBe(9);
    expect(marks.find((m) => m.id === `agent:${met.id}`)?.since).toBeNull();
  });

  test("tasks: trouble, then a restart, then what runs, each with its name and port", () => {
    const marks = tasksOf(
      liveMarks(
        input({
          tasks: [
            task({ name: "dev", startedAt: 100, port: 5173 }),
            task({ name: "api", status: "backoff", retryAt: 900 }),
            task({ name: "test", status: "failed", exitedAt: 200 }),
            task({ name: "lint", status: "gave-up" }),
          ],
        }),
      ),
    );
    expect(marks.map((m) => `${m.name}:${m.state}`)).toEqual(["lint:failed", "test:failed", "api:restarting", "dev:running"]);
    expect(marks.find((m) => m.name === "dev")).toMatchObject({ id: "task:app:dev", port: 5173, since: 100, title: "dev running" });
    expect(marks.find((m) => m.name === "test")).toMatchObject({ port: null, since: 200, title: "test failed" });
    expect(marks.find((m) => m.name === "lint")?.title).toBe("lint gave up");
    expect(marks.find((m) => m.name === "api")?.since).toBeNull();
  });

  test("a task on another machine's checkout says where", () => {
    const [mark] = liveMarks(input({ tasks: [task({ repoId: "mini|app" })] }));
    expect(mark).toMatchObject({ id: "task:mini|app:dev", repoId: "mini|app", title: "dev running on mini" });
  });

  test("shells: the ones on a screen first; a task's session, the ranger's and an agent's own shell are not shells here", () => {
    const inShell = agent({ where: { os: "linux", container: true, pid: 4, term: null, canopy: { backend: "mini", term: "t9" } } });
    const marks = shellsOf(
      liveMarks(
        input({
          agents: [inShell],
          shells: [
            shell({ id: "t1", startedAt: 10 }),
            shell({ id: "t2", startedAt: 20, attached: true, viewers: ["Mac Chrome", "fold"] }),
            shell({ id: "t3", task: "dev" }),
            shell({ id: "t4", ranger: true }),
            shell({ id: "mini|t9", repoId: "mini|app" }),
            shell({ id: "mini|t8", repoId: "mini|app", startedAt: 30, label: "logs" }),
          ],
        }),
      ),
    );
    expect(marks.map((m) => `${m.term}:${m.state}`)).toEqual(["t2:watched", "mini|t8:held", "t1:held"]);
    expect(marks.find((m) => m.term === "t2")).toMatchObject({ id: "shell:t2", since: 20, repoId: "app", title: "shell: open on Mac Chrome, fold" });
    expect(marks.find((m) => m.term === "mini|t8")?.title).toBe("logs on mini: running, on no screen");
  });

  test("an ended agent's shell is a shell again", () => {
    const ended = agent({ state: "ended", where: { os: "linux", container: true, pid: 4, term: null, canopy: { backend: "mac", term: "t1" } } });
    expect(states(liveMarks(input({ agents: [ended], shells: [shell({ id: "t1" })] })))).toEqual(["shell:held"]);
  });

  test("a glyph for each state", () => {
    const glyphs = liveMarks(
      input({
        agents: [agent({ state: "waiting" }), agent({ state: "working" })],
        tasks: [task({}), task({ name: "a", status: "backoff" }), task({ name: "b", status: "failed" })],
        shells: [shell()],
      }),
    ).map(liveGlyph);
    expect(glyphs).toEqual(["⚑", "✦", "✕", "↻", "▶", "▍"]);
  });
});

describe("the groups", () => {
  test("one per kind that has a mark, in words", () => {
    const marks = liveMarks(
      input({
        agents: [agent({ state: "waiting" }), agent({ state: "working" }), agent({ state: "working" })],
        tasks: [task({}), task({ name: "test", status: "failed" })],
        shells: [shell({ id: "t1", attached: true, viewers: ["Mac"] }), shell({ id: "t2" })],
      }),
    );
    const groups = liveGroups(marks, []);
    expect(groups.map((g) => g.kind)).toEqual(["agent", "task", "shell"]);
    expect(groups.map((g) => g.words)).toEqual(["3 agents: 1 waiting, 2 working", "2 tasks: test failed, dev running", "2 shells, 1 on a screen"]);
    expect(groups.map((g) => g.more)).toEqual([0, 0, 0]);
    expect(liveGroups(liveMarks(input({ shells: [shell()] })), [])[0]?.words).toBe("1 shell, on no screen");
  });

  test("past the cap the rest is a count", () => {
    const agents = Array.from({ length: LIVE_CAP.agent + 3 }, () => agent());
    const [group] = liveGroups(liveMarks(input({ agents })), []);
    expect(group?.marks).toHaveLength(LIVE_CAP.agent);
    expect(group?.more).toBe(3);
    expect(group?.first?.id).toBe(group?.marks[0]?.mark.id);
    expect(group?.words).toBe(`${LIVE_CAP.agent + 3} agents: ${LIVE_CAP.agent + 3} working`);
  });

  test("a mark that just ended stays at the end of its group, and holds the group open alone", () => {
    const a = agent();
    const [was] = liveMarks(input({ agents: [a] }));
    const now = liveMarks(input({ agents: [agent({ state: "idle" })], tasks: [task({})] }));
    const groups = liveGroups(now, was ? [was] : []);
    expect(groups[0]?.marks.map((m) => m.gone)).toEqual([false, true]);
    expect(groups[0]?.words).toBe("1 agent: 1 idle");
    const alone = liveGroups([], was ? [was] : []);
    expect(alone).toHaveLength(1);
    expect(alone[0]).toMatchObject({ kind: "agent", words: "an agent just ended", more: 0, first: null });
    expect(alone[0]?.marks).toEqual(was ? [{ mark: was, gone: true }] : []);
  });
});

describe("the headline", () => {
  const head = (over: Partial<LiveInput>, now = 10 * H) => liveHead(liveMarks(input(over)), now);

  test("nothing live, nothing said", () => {
    expect(head({})).toBeNull();
  });

  test("the most pressing thing, in this order", () => {
    const waiting = agent({ state: "waiting" });
    const working = agent({ state: "working" });
    const idle = agent({ state: "idle" });
    const failed = task({ name: "test", status: "failed" });
    const restarting = task({ name: "api", status: "backoff" });
    const running = task({ name: "dev", startedAt: 10 * H - 3 * H });
    const sh = shell({ startedAt: 10 * H - 2 * 24 * H });
    const all = { agents: [waiting, working, idle], tasks: [failed, restarting, running], shells: [sh] };
    expect(head(all)).toEqual({ tone: "ask", text: "needs you" });
    expect(head({ ...all, agents: [working, idle] })).toEqual({ tone: "bad", text: "test failed" });
    expect(head({ ...all, agents: [working, idle], tasks: [restarting, running] })).toEqual({ tone: "work", text: "working" });
    expect(head({ ...all, agents: [idle], tasks: [restarting, running] })).toEqual({ tone: "hold", text: "api restarting" });
    expect(head({ ...all, agents: [idle], tasks: [running] })).toEqual({ tone: "calm", text: "up 3h" });
    expect(head({ agents: [idle], shells: [sh] })).toEqual({ tone: "calm", text: "idle" });
    expect(head({ shells: [sh] })).toEqual({ tone: "calm", text: "shell open 2d" });
  });

  test("how long, once it is a minute, when the page saw it start", () => {
    const a = agent({ state: "waiting" });
    const at = (ms: number) => liveHead(liveMarks(input({ agents: [a], trail: { [a.id]: [{ state: "waiting", at: 0 }] } })), ms);
    expect(at(30_000)?.text).toBe("needs you");
    expect(at(4 * M + 5_000)?.text).toBe("needs you 4m");
    expect(at(5 * H)?.text).toBe("needs you 5h");
  });

  test("a lone task goes unnamed, its mark beside the words naming it; a failure says how long ago", () => {
    expect(head({ tasks: [task({ name: "test", status: "failed", exitedAt: 10 * H - 5 * M })] })?.text).toBe("failed 5m ago");
    expect(head({ tasks: [task({ name: "test", status: "gave-up" })] })?.text).toBe("failed");
    expect(head({ tasks: [task({ name: "api", status: "backoff" })] })?.text).toBe("restarting");
    expect(head({ tasks: [task({ name: "dev", startedAt: 10 * H - 30_000 })] })?.text).toBe("up");
    expect(head({ tasks: [task({ name: "test", status: "failed", exitedAt: 10 * H - 5 * M }), task({ name: "dev" })] })?.text).toBe("test failed 5m ago");
  });

  test("several of a kind are counted", () => {
    expect(head({ agents: [agent({ state: "waiting" }), agent({ state: "waiting" })] })?.text).toBe("2 need you");
    expect(head({ agents: [agent(), agent(), agent()] })?.text).toBe("3 working");
    expect(head({ tasks: [task({ name: "a", status: "failed" }), task({ name: "b", status: "gave-up" })] })?.text).toBe("2 tasks failed");
    expect(head({ tasks: [task({ name: "a" }), task({ name: "b" })] })?.text).toBe("2 tasks up");
    expect(head({ shells: [shell({ id: "a" }), shell({ id: "b" })] })?.text).toBe("2 shells open");
  });
});

describe("sap and the leaf edge", () => {
  test("the branch line carries sap only while an agent works", () => {
    expect(liveFlow(liveMarks(input({ agents: [agent({ state: "waiting" }), agent({ state: "working" })] })))).toBe(true);
    expect(liveFlow(liveMarks(input({ agents: [agent({ state: "idle" })], tasks: [task({})], shells: [shell({ attached: true })] })))).toBe(false);
  });

  test("the edge asks before it works", () => {
    expect(liveEdge([])).toBeNull();
    expect(liveEdge([agent({ state: "idle" }), agent({ state: "ended" })])).toBeNull();
    expect(liveEdge([agent({ state: "idle" }), agent({ state: "working" })])).toBe("working");
    expect(liveEdge([agent({ state: "working" }), agent({ state: "waiting" })])).toBe("waiting");
  });
});

describe("the trace", () => {
  const last = (over: Partial<LiveInput>) => lastEnded(input(over));

  test("nothing ended, nothing remembered: what still runs, and what failed, is on the row", () => {
    expect(last({})).toBeNull();
    expect(
      last({
        agents: [agent(), agent({ state: "idle" }), agent({ state: "waiting" })],
        tasks: [
          task({}),
          task({ name: "a", status: "failed", exitedAt: 5 }),
          task({ name: "b", status: "gave-up", exitedAt: 5 }),
          task({ name: "c", status: "backoff", exitedAt: 5 }),
          task({ name: "d", status: "idle" }),
        ],
      }),
    ).toBeNull();
  });

  test("an agent that ended, or one the broker lost", () => {
    const ended = agent({ state: "ended", handle: "app-main", startedAt: H, seenAt: 2 * H, endedAt: 2 * H + 5 * M });
    expect(last({ agents: [ended] })).toEqual({
      id: `agent:${ended.id}:${2 * H + 5 * M}`,
      kind: "agent",
      text: "agent ended",
      title: "app-main, kitty on ericmac, ran 1h 5m",
      at: 2 * H + 5 * M,
      repoId: "app",
    });
    const lost = agent({ state: "lost", startedAt: H, seenAt: 3 * H });
    expect(last({ agents: [lost] })).toMatchObject({ text: "agent lost", at: 3 * H });
    // an end that carries no time of its own happened at the last beat
    expect(last({ agents: [agent({ state: "ended", seenAt: 4 * H })] })?.at).toBe(4 * H);
  });

  test("a task that ran to its end or was stopped; a check that came back clean passed", () => {
    expect(last({ tasks: [task({ name: "build", status: "exited", exitedAt: 9, exitCode: 0 })] })).toEqual({
      id: "task:app:build:9",
      kind: "task",
      text: "build finished",
      title: "build finished",
      at: 9,
      repoId: "app",
    });
    for (const name of ["test", "tests", "test:e2e", "lint", "typecheck", "check", "e2e", "verify", "ci"]) {
      expect(last({ tasks: [task({ name, status: "exited", exitedAt: 9 })] })?.text).toBe(`${name} passed`);
    }
    // a name that only starts like a check is not one
    expect(last({ tasks: [task({ name: "testbed", status: "exited", exitedAt: 9 })] })?.text).toBe("testbed finished");
    expect(last({ tasks: [task({ name: "dev", status: "stopped", exitedAt: 9 })] })?.text).toBe("dev stopped");
    // no time, no trace: the row cannot say how long ago
    expect(last({ tasks: [task({ name: "build", status: "exited" })] })).toBeNull();
  });

  test("a task on another machine's checkout says where, and opens there", () => {
    expect(last({ tasks: [task({ name: "test", repoId: "mini|app", status: "exited", exitedAt: 9 })] })).toMatchObject({
      id: "task:mini|app:test:9",
      title: "test passed on mini",
      repoId: "mini|app",
    });
  });

  test("the newest of them, whatever its kind", () => {
    const agents = [agent({ state: "ended", endedAt: 2 * H }), agent({ state: "lost", seenAt: 3 * H }), agent({ state: "ended", endedAt: H })];
    const tasks = [task({ name: "test", status: "exited", exitedAt: 2 * H + M }), task({ name: "dev", status: "stopped", exitedAt: H })];
    expect(last({ agents, tasks })?.text).toBe("agent lost");
    expect(last({ agents: agents.slice(0, 1), tasks })?.text).toBe("test passed");
    expect(last({ agents: agents.slice(2), tasks: tasks.slice(1) })?.kind).toBe("agent");
  });

  test("in words: how long ago, once that is a minute", () => {
    const t: LiveTrace = { id: "x", kind: "task", text: "test passed", title: "test passed", at: 10 * H, repoId: "app" };
    expect(traceWords(t, 10 * H + 20_000)).toBe("test passed just now");
    expect(traceWords(t, 10 * H + 4 * M + 5_000)).toBe("test passed 4m ago");
    expect(traceWords(t, 12 * H)).toBe("test passed 2h ago");
    // the backend's clock a little ahead of the page's
    expect(traceWords(t, 10 * H - 5_000)).toBe("test passed just now");
  });

  test("it has room while the branch line keeps its own length: a line cut short gave the room up", () => {
    expect(traceFits(16, 16)).toBe(true);
    expect(traceFits(140.5, 16)).toBe(true);
    expect(traceFits(15.9, 16)).toBe(false);
    expect(traceFits(8, 16)).toBe(false);
    // a browser lays out in 64ths of a pixel, and less than one is no cut
    expect(traceFits(16 - 1 / 128, 16)).toBe(true);
  });

  test("the row remembers it for half an hour", () => {
    const t: LiveTrace = { id: "x", kind: "agent", text: "agent ended", title: "", at: 10 * H, repoId: "app" };
    expect(TRACE_MS).toBe(30 * M);
    expect(traceUntil(t)).toBe(10 * H + 30 * M);
  });
});

describe("marks that just ended", () => {
  const mark = (id: string): LiveMark => ({ id, kind: "agent", state: "working", title: id, since: null, repoId: "app" });

  test("one that left is held for a while", () => {
    const gone = departed([mark("a"), mark("b")], [mark("b")], [], 1000, 900);
    expect(gone).toEqual([{ item: mark("a"), until: 1900 }]);
  });

  test("nothing left, nothing changes", () => {
    const held = [{ item: mark("a"), until: 1900 }];
    expect(departed([mark("b")], [mark("b")], held, 1000, 900)).toBe(held);
    const none: { item: LiveMark; until: number }[] = [];
    expect(departed([], [mark("b")], none, 1000, 900)).toBe(none);
  });

  test("its time over, or back again, it is let go", () => {
    const held = [{ item: mark("a"), until: 1900 }, { item: mark("c"), until: 2500 }];
    expect(departed([], [], held, 2000, 900)).toEqual([{ item: mark("c"), until: 2500 }]);
    expect(departed([], [mark("c")], held, 1000, 900)).toEqual([{ item: mark("a"), until: 1900 }]);
  });

  test("one already held is not held twice", () => {
    const held = [{ item: mark("a"), until: 1900 }];
    expect(departed([mark("a")], [], held, 1500, 900)).toBe(held);
  });
});

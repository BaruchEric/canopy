import { describe, expect, test } from "bun:test";
import type { AgentCard, CoordTask, Repo, Run, TermInfo } from "../../src/core/types";
import { agentName, allAgents, chatOf, madeWord, runCard, runOfCard, runState, shellsToProbe, type Ids } from "./allagents";

// home is "mac"; another backend's ids carry "mini|"
const ids: Ids = {
  split: (id) => (id.startsWith("mini|") ? ["mini", id.slice(5)] : ["mac", id]),
  qual: (b, id) => (b === "mac" ? id : `${b}|${id}`),
};

const repo = { id: "app", name: "app", path: "/dev/app", link: "https://github.com/Me/App", status: { branch: "main" } } as unknown as Repo;

const run = (over: Partial<Run> = {}): Run =>
  ({ id: "r1", repoId: "app", verb: "review", chat: false, harness: "claude", status: "working", steps: [], prompt: null, startedAt: 100, ...over }) as unknown as Run;

const shell = (over: Partial<TermInfo> = {}): TermInfo => ({ id: "t1", repoId: "app", path: "/dev/app", place: "panel", attached: false, viewers: [], startedAt: 50, ...over });

function card(over: Partial<AgentCard> = {}): AgentCard {
  return {
    id: "claude:s1",
    handle: "app-1",
    node: "mac",
    harness: "claude",
    session: "s1",
    origin: "canopy-shell",
    cwd: "/dev/app",
    repo: null,
    branch: null,
    model: null,
    mode: null,
    state: "working",
    waiting: null,
    caps: [],
    offers: [],
    notifyIdle: false,
    where: { os: "darwin", container: false, pid: 1, term: null, canopy: null },
    transcript: null,
    startedAt: 1,
    seenAt: 2,
    endedAt: null,
    ...over,
  };
}

describe("runState", () => {
  test("a chat between turns and a prompt are both the user's turn; a finished run has ended", () => {
    expect(runState("working")).toBe("working");
    expect(runState("waiting")).toBe("waiting");
    expect(runState("idle")).toBe("waiting");
    for (const s of ["done", "failed", "stopped"] as const) expect(runState(s)).toBe("ended");
  });
});

describe("runCard", () => {
  test("names the backend's own run id, the repo, and what it waits on", () => {
    const c = runCard(run({ id: "mini|r9", status: "waiting", prompt: { id: "p", kind: "permission", tool: "Bash", title: "rm -rf build", detail: "" } }), repo, ids);
    expect(c.id).toBe("run:mini|r9");
    expect(c.where.canopy).toEqual({ backend: "mini", run: "r9" });
    expect(c.origin).toBe("canopy-run");
    expect(c.state).toBe("waiting");
    expect(c.waiting).toBe("permission: rm -rf build");
    expect(c.repo).toBe("https://github.com/Me/App");
    expect(c.branch).toBe("main");
    expect(runOfCard(c, ids)).toBe("mini|r9");
  });

  test("an ended run carries its end", () => {
    const c = runCard(run({ status: "done", endedAt: 900 }), repo, ids);
    expect(c.state).toBe("ended");
    expect(c.endedAt).toBe(900);
  });

  test("a chat between turns waits on your turn", () => {
    expect(runCard(run({ chat: true, status: "idle" }), repo, ids).waiting).toBe("your turn");
  });

  test("an idle coordinator waits on you only while its cards wait for start these", () => {
    const task = (state: CoordTask["state"]): CoordTask => ({ id: "t1", title: "t", repo: "app", note: "n", action: "ask", state });
    const waits = runCard(run({ action: "coordinate", chat: true, status: "idle", tasks: [task("proposed")] }), repo, ids);
    expect([waits.state, waits.waiting]).toEqual(["waiting", "1 card waits for start these"]);
    const quiet = runCard(run({ action: "coordinate", chat: true, status: "idle", tasks: [task("running")] }), repo, ids);
    expect([quiet.state, quiet.waiting]).toEqual(["idle", null]);
  });
});

describe("allAgents", () => {
  const input = { cards: [] as AgentCard[], runs: [] as Run[], shells: [] as TermInfo[], shellAgents: {}, repos: [repo], ids };

  test("a run no card names gets a card; one a hook card names does not", () => {
    const hooked = card({ id: "claude:s2", origin: "canopy-run", where: { os: "", container: false, pid: 1, term: null, canopy: { backend: "mac", run: "r1" } } });
    expect(allAgents({ ...input, runs: [run()] }).map((c) => c.id)).toEqual(["run:r1"]);
    expect(allAgents({ ...input, cards: [hooked], runs: [run()] }).map((c) => c.id)).toEqual(["claude:s2"]);
  });

  test("a shell shows only with an agent in it, never a task's, and not when a live card names it", () => {
    const shells = [shell(), shell({ id: "t2" }), shell({ id: "t3", task: "dev" }), shell({ id: "mini|t4" })];
    const shellAgents = { t1: "claude", t2: null, t3: "codex", "mini|t4": "codex" } as const;
    const named = card({ where: { os: "", container: false, pid: 1, term: null, canopy: { backend: "mini", term: "t4" } } });
    expect(allAgents({ ...input, shells, shellAgents }).map((c) => c.id)).toEqual(["shell:t1", "shell:mini|t4"]);
    expect(allAgents({ ...input, cards: [named], shells, shellAgents }).map((c) => c.id)).toEqual(["claude:s1", "shell:t1"]);
    // an ended card no longer speaks for the shell
    const gone = { ...named, state: "ended" as const };
    expect(allAgents({ ...input, cards: [gone], shells, shellAgents }).map((c) => c.id)).toEqual(["claude:s1", "shell:t1", "shell:mini|t4"]);
  });

  test("a shell's card joins its shell and takes its harness and handle", () => {
    const [c] = allAgents({ ...input, shells: [shell({ id: "mini|t4", handle: "app-mini" })], shellAgents: { "mini|t4": "codex" } });
    expect(c?.where.canopy).toEqual({ backend: "mini", term: "t4" });
    expect(c?.harness).toBe("codex");
    expect(c?.handle).toBe("app-mini");
    expect(c?.state).toBe("idle");
  });
});

describe("allAgents and scans", () => {
  test("a live scan of the same harness in the shell's folder, started since, is the shell's agent", () => {
    const scan = (over: Partial<AgentCard>) => card({ id: "scan:n:h:9", origin: "scan", harness: "codex", handle: "", cwd: "/dev/app", startedAt: 60, ...over });
    const shells = [shell()];
    const shellAgents = { t1: "codex" } as const;
    const base = { runs: [], shells, shellAgents, repos: [repo], ids };
    expect(allAgents({ ...base, cards: [scan({})] }).map((c) => c.id)).toEqual(["shell:t1"]);
    expect(allAgents({ ...base, cards: [scan({ startedAt: 10 })] }).map((c) => c.id)).toEqual(["scan:n:h:9", "shell:t1"]);
    expect(allAgents({ ...base, cards: [scan({ cwd: "/elsewhere" })] }).map((c) => c.id)).toEqual(["scan:n:h:9", "shell:t1"]);
    expect(allAgents({ ...base, cards: [scan({ harness: "claude" })] }).map((c) => c.id)).toEqual(["scan:n:h:9", "shell:t1"]);
  });
});

describe("shellsToProbe", () => {
  test("every shell but a task's and one a live card names", () => {
    const named = card({ where: { os: "", container: false, pid: 1, term: null, canopy: { backend: "mac", term: "t1" } } });
    const shells = [shell(), shell({ id: "t2" }), shell({ id: "t3", task: "dev" })];
    expect(shellsToProbe([named], shells, ids)).toEqual(["t2"]);
    expect(shellsToProbe([{ ...named, state: "ended" }], shells, ids)).toEqual(["t1", "t2"]);
  });
});

describe("agentName and madeWord", () => {
  test("a made card without a repo link is called by its folder", () => {
    const c = runCard(run(), { ...repo, link: undefined } as unknown as Repo, ids);
    expect(agentName(c)).toBe("app");
    expect(agentName(card({ cwd: "/x/y", handle: "" }))).toBe("claude pid 1");
    expect(madeWord(c, run({ chat: true }))).toBe("canopy chat");
    expect(madeWord(c, run())).toBe("canopy run: review");
    expect(madeWord(card(), undefined)).toBeNull();
  });
});

describe("chatOf", () => {
  test("a chat's made card and a registry card naming a chat's run; not a job's, not a shell's", () => {
    const chat = chatOf(["mini|r9", "r2"], ids);
    const where = (canopy: { backend: string; run?: string; term?: string }): AgentCard["where"] => ({ os: "darwin", container: false, pid: 1, term: null, canopy });
    expect(chat(runCard(run({ id: "mini|r9", chat: true }), repo, ids))).toBe(true);
    expect(chat(card({ origin: "canopy-run", where: where({ backend: "mac", run: "r2" }) }))).toBe(true);
    expect(chat(runCard(run({ id: "mini|r3" }), repo, ids))).toBe(false);
    expect(chat(card({ where: where({ backend: "mac", term: "r2" }) }))).toBe(false);
    expect(chat(card())).toBe(false);
  });
});

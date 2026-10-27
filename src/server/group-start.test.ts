/** Best-of-N over a scratch HTTP backend. Only the paid agent process is fake. */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS } from "../core/actions";
import type { DriveCtx, RunDriver } from "../core/driver";
import { exec } from "../core/exec";
import type { FlowFile } from "../core/flowstore";
import { parseWorkflow } from "../core/workflow";
import { addRunTree, repoKey } from "../core/worktree";
import { DEFAULT_AGENT, type Harness } from "../core/types";
import { startServer } from "./index";
import { CallerBook } from "./callers";

const worlds: {
  stop: () => Promise<void>;
  dir: string;
  previous: string | undefined;
  tmux: string | undefined;
  callers: string | undefined;
}[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0).reverse()) {
    await w.stop();
    if (w.previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
    else process.env["CANOPY_CONFIG_DIR"] = w.previous;
    if (w.tmux === undefined) delete process.env["CANOPY_TMUX"];
    else process.env["CANOPY_TMUX"] = w.tmux;
    if (w.callers === undefined) delete process.env["CANOPY_CALLERS"];
    else process.env["CANOPY_CALLERS"] = w.callers;
    await rm(w.dir, { recursive: true, force: true });
  }
});
const git = async (cwd: string, ...args: string[]) => {
  const result = await exec(["git", ...args], { cwd });
  if (result.code) throw new Error(result.stderr);
  return result.stdout.trim();
};
async function until<T>(
  read: () => Promise<T | undefined | false> | T | undefined | false,
  why: string,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() - start > 10_000) throw new Error(`waiting for ${why}`);
    await Bun.sleep(10);
  }
}
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function groupBody(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["state"] !== "string" ||
    !Array.isArray(value["members"])
  )
    throw new Error(`not a group: ${JSON.stringify(value)}`);
  const members = value["members"].map((member: unknown) => {
    if (
      !isRecord(member) ||
      typeof member["run"] !== "string" ||
      typeof member["origin"] !== "string" ||
      !(member["profile"] === null || typeof member["profile"] === "string")
    )
      throw new Error("bad member response");
    return {
      run: member["run"],
      origin: member["origin"],
      profile: member["profile"],
    };
  });
  return {
    id: value["id"],
    state: value["state"],
    members,
    expectedMembers: value["expectedMembers"],
    action: value["action"],
    note: value["note"],
    autoLand: value["autoLand"],
  };
}

async function world(
  opts: {
    failCheck?: number;
    earlyResult?: boolean;
    checkReached?: (check: number) => void;
    holdExit?: (ctx: DriveCtx) => boolean;
    reviewerPreflight?: () => Promise<void>;
    cutFailure?: boolean;
    autoSort?: boolean;
    flow?: boolean;
    heldBranchFlow?: boolean;
    prs?: boolean;
    enforce?: boolean;
  } = {},
) {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "canopy-group-start-")),
  );
  const config = join(dir, "config");
  const repo = join(dir, "root", "app");
  const callers = process.env["CANOPY_CALLERS"];
  process.env["CANOPY_CALLERS"] = opts.enforce ? "enforce" : "off";
  const previous = process.env["CANOPY_CONFIG_DIR"];
  const tmux = process.env["CANOPY_TMUX"];
  process.env["CANOPY_TMUX"] = "0";
  process.env["CANOPY_CONFIG_DIR"] = config;
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.name", "test");
  await git(repo, "config", "user.email", "test@example.test");
  await writeFile(join(repo, "base.txt"), "base\n");
  if (opts.autoSort) {
    await mkdir(join(repo, ".canopy"), { recursive: true });
    await writeFile(
      join(repo, ".canopy", "gates.json"),
      JSON.stringify({ gates: [{ name: "test", run: "true" }] }),
    );
    await writeFile(
      join(repo, ".canopy", "review.json"),
      JSON.stringify({ autoLand: ["docs"], approve: [] }),
    );
  }
  if (opts.flow) {
    await mkdir(join(repo, ".canopy", "workflows"), { recursive: true });
    await writeFile(
      join(repo, ".canopy", "workflows", "hold.md"),
      "---\nblurb: Hold the checkout.\n---\n\n## First\ngate: ask\n\nRead the files.\n\n## Second\n\nRead again.\n",
    );
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  if (opts.heldBranchFlow) {
    const id = "abcdef42";
    const base = await git(repo, "rev-parse", "HEAD");
    const tree = join(config, "worktrees", repoKey(repo), id);
    await addRunTree(repo, tree, "run/held-flow", base);
    const parsed = parseWorkflow("---\nblurb: held branch\n---\n\n## First\nmode: manual\n\nRead the files.\n", { name: "held-branch", source: "user", file: "/held-branch.md" });
    if (!parsed.ok) throw new Error(parsed.error);
    const saved: FlowFile = {
      v: 1, before: "", savedAt: 1, root: join(dir, "root"), repoPath: repo, workflow: parsed.workflow,
      flow: {
        id, repoId: "app", workflow: "held-branch", verb: "held branch", note: "", status: "gated", current: 0, startedAt: 1,
        steps: [{ name: "First", status: "held", reason: "First waits for your go" }],
        branch: { name: "run/held-flow", target: "main", base, dir: tree, state: "working", origin: id, held: true },
      },
    };
    await mkdir(join(config, "flows"), { recursive: true });
    await writeFile(join(config, "flows", `${id}.json`), JSON.stringify(saved));
  }
  if (opts.cutFailure) {
    const hook = join(repo, ".git", "hooks", "post-checkout");
    await writeFile(
      hook,
      '#!/bin/sh\ngroup_common=$(git rev-parse --git-common-dir)\ngroup_count_file="$group_common/group-cut-count"\ngroup_count=0\nif [ -f "$group_count_file" ]; then group_count=$(cat "$group_count_file"); fi\ngroup_count=$((group_count + 1))\nprintf "%s" "$group_count" > "$group_count_file"\nif [ "$group_count" -eq 3 ]; then echo "third cut refused" >&2; exit 1; fi\n',
    );
    await chmod(hook, 0o755);
  }
  const ghCalls: string[][] = [];
  let token: string | undefined;
  let limitedToken: string | undefined;
  if (opts.enforce) {
    const book = new CallerBook({ file: join(config, "callers.json") });
    token = book.mint("ranger", { label: "test operator" }).token;
    limitedToken = book.mint("helper", { label: "test helper" }).token;
    await book.flush();
  }
  if (opts.prs) {
    const bare = join(dir, "remote.git");
    await git(dir, "init", "--bare", "-q", bare);
    await git(repo, "remote", "add", "origin", bare);
    await git(repo, "push", "-q", "origin", "main");
  }
  const starts: { ctx: DriveCtx; message: string; harness: Harness }[] = [];
  const cutCounts: number[] = [];
  const groupsAtCheck: unknown[] = [];
  let checks = 0;
  class FakeDriver implements RunDriver {
    label = "test agent";
    ctx?: DriveCtx;
    constructor(readonly harness: Harness) {}
    check() {
      checks++;
      opts.checkReached?.(checks);
      const trees = Bun.spawnSync([
        "git",
        "-C",
        repo,
        "worktree",
        "list",
        "--porcelain",
      ]);
      cutCounts.push(
        (trees.stdout.toString().match(/^worktree /gm) ?? []).length - 1,
      );
      const path = join(config, "landing", "groups");
      if (existsSync(path))
        groupsAtCheck.push(
          ...readdirSync(path)
            .filter((name) => name.endsWith(".json"))
            .map((name) => JSON.parse(readFileSync(join(path, name), "utf8"))),
        );
      return checks === opts.failCheck ? "third member cannot start" : null;
    }
    start(ctx: DriveCtx, message: string) {
      this.ctx = ctx;
      starts.push({ ctx, message, harness: this.harness });
      if (opts.earlyResult && starts.length === 1)
        ctx.result(
          { text: "early result", costUsd: 0.01, durationMs: 1, turns: 1 },
          null,
        );
    }
    say() {}
    stop() {
      if (this.ctx && opts.holdExit?.(this.ctx)) return;
      this.ctx?.exited({ code: null, stderr: "stopped" });
    }
  }
  const server = await startServer({
    root: join(dir, "root"),
    port: 0,
    chan: null,
    harnesses: ["claude", "codex"],
    ...(opts.reviewerPreflight
      ? { groups: { reviewerPreflight: opts.reviewerPreflight } }
      : {}),
    runner: { driver: (harness) => new FakeDriver(harness) },
    ...(opts.prs
      ? {
          prs: {
            tickEvery: 3_600_000,
            slugOf: async () => "fixture/app",
            gh: async (args: string[]) => {
              ghCalls.push(args);
              return {
                code: 0,
                stdout:
                  args[0] === "pr" && args[1] === "create"
                    ? "https://example.test/fixture/app/pull/42\n"
                    : "",
                stderr: "",
              };
            },
          },
        }
      : {}),
  });
  worlds.push({ ...server, dir, previous, tmux, callers });
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const post = (path: string, body: unknown) =>
    fetch(url(path), {
      method: "POST",
      body: JSON.stringify(body),
      ...(token ? { headers: { "X-Canopy-Token": token } } : {}),
    });
  const start = (over: Record<string, unknown> = {}) =>
    post("/api/repos/run?id=app", {
      action: "ask",
      note: "same task",
      branch: true,
      times: 2,
      ...over,
    });
  const readRuns = async () => {
    const value: unknown = await (await fetch(url("/api/runs"))).json();
    if (!Array.isArray(value)) throw new Error("runs absent");
    return value.map((run: unknown) => {
      if (!isRecord(run)) throw new Error("bad run");
      return {
        id: run["id"],
        action: run["action"],
        note: run["note"],
        group: run["group"],
        priority: run["priority"],
        branch: isRecord(run["branch"])
          ? { group: run["branch"]["group"] }
          : undefined,
        status: run["status"],
      };
    });
  };
  const groups = async () => {
    const value: unknown = await (await fetch(url("/api/groups"))).json();
    if (!Array.isArray(value)) throw new Error("groups absent");
    return value.map(groupBody);
  };
  const landing = async () => {
    const value: unknown = await (await fetch(url("/api/landing"))).json();
    if (
      !isRecord(value) ||
      !Array.isArray(value["runs"]) ||
      !Array.isArray(value["entries"])
    )
      throw new Error("landing absent");
    return {
      runs: value["runs"].map((run: unknown) => {
        if (!isRecord(run) || typeof run["branch"] !== "string")
          throw new Error("bad landing run");
        return {
          branch: run["branch"],
          group: run["group"],
          review: run["review"],
        };
      }),
      entries: value["entries"],
    };
  };
  const finish = async (index: number, text = "done") => {
    const item = starts[index];
    if (!item) throw new Error(`start ${index} absent`);
    const name = `member-${index}.md`;
    if (item.ctx.cwd !== repo) {
      await writeFile(join(item.ctx.cwd, name), "work\n");
      await git(item.ctx.cwd, "add", "-A");
      await git(item.ctx.cwd, "commit", "-qm", `work ${index}`);
    }
    item.ctx.result({ text, costUsd: 0.01, durationMs: 1, turns: 1 }, null);
    item.ctx.exited({ code: 0, stderr: "" });
  };
  const diskGroups = () =>
    readdir(join(config, "landing", "groups")).then(
      (names) => names.filter((name) => name.endsWith(".json")),
      () => [],
    );
  return {
    dir,
    config,
    repo,
    server,
    starts,
    cutCounts,
    groupsAtCheck,
    post,
    start,
    readRuns,
    groups,
    landing,
    finish,
    diskGroups,
    url,
    ghCalls,
    limitedToken,
  };
}

test("times one preserves the existing single branch run", async () => {
  const w = await world();
  const response = await w.start({ times: 1 });
  expect(response.status).toBe(201);
  const run: unknown = await response.json();
  expect(run).toMatchObject({ action: "ask", branch: { state: "working" } });
  expect(run).not.toHaveProperty("group");
});

for (const times of [2, 3])
  test(`times ${times} persists fanout before cuts, cuts all trees before starting, and shares note/action`, async () => {
    const w = await world();
    const response = await w.start({ times });
    expect(response.status).toBe(201);
    const group = groupBody(await response.json());
    expect(group).toMatchObject({
      expectedMembers: times,
      action: "ask",
      note: "same task",
      autoLand: false,
    });
    expect(group.members).toHaveLength(times);
    expect(w.cutCounts).toEqual(Array(times).fill(times));
    expect(w.groupsAtCheck[0]).toMatchObject({
      id: group.id,
      expectedMembers: times,
      members: [],
    });
    expect(
      (await w.readRuns())
        .filter((r) => r.branch)
        .map((r) => [r.action, r.note, r.group, r.priority, r.branch?.group]),
    ).toEqual(
      Array(times).fill(["ask", "same task", group.id, "low", group.id]),
    );
    expect((await w.landing()).runs.every((r) => r.group === group.id)).toBe(
      true,
    );
  });

test("validation refuses malformed times, non-branch groups, multiple profiles and direct compare before cuts", async () => {
  const w = await world();
  for (const over of [
    { times: 0 },
    { times: 4 },
    { times: 1.5 },
    { times: "2" },
    { branch: false },
    { branch: undefined },
    { profiles: ["default", "default"] },
    { profiles: "default" },
    { profiles: ["__proto__"] },
    { action: "compare" },
    { autoLand: "true" },
  ]) {
    const response = await w.start(over);
    expect(response.status).toBe(400);
  }
  expect(w.cutCounts).toEqual([]);
  expect(await w.diskGroups()).toEqual([]);
  expect(
    (await git(w.repo, "worktree", "list", "--porcelain")).match(
      /^worktree /gm,
    ),
  ).toHaveLength(1);
});

test("insufficient branch slots refuses before cutting a group", async () => {
  const w = await world();
  expect((await w.start({ times: 1 })).status).toBe(201);
  const before = await git(w.repo, "worktree", "list", "--porcelain");
  const response = await w.start({ times: 3 });
  expect(response.status).toBe(409);
  expect(await git(w.repo, "worktree", "list", "--porcelain")).toBe(before);
  expect(await w.diskGroups()).toEqual([]);
});

test("a held branch workflow consumes one group slot between step runs", async () => {
  const w = await world({ heldBranchFlow: true });
  const flows: unknown = await (await fetch(w.url("/api/flows"))).json();
  expect(flows).toEqual([expect.objectContaining({ id: "abcdef42", status: "gated", branch: expect.objectContaining({ held: true }) })]);
  expect(w.starts).toHaveLength(0);
  expect((await w.readRuns()).filter((run) => run.status === "working")).toHaveLength(0);
  const before = await git(w.repo, "worktree", "list", "--porcelain");
  expect((await w.start({ times: 3 })).status).toBe(409);
  expect(await git(w.repo, "worktree", "list", "--porcelain")).toBe(before);
  expect(await w.diskGroups()).toEqual([]);
  const accepted = await w.start({ times: 2 });
  expect(accepted.status).toBe(201);
  expect(groupBody(await accepted.json()).members).toHaveLength(2);
});

test("one shared profile reaches every member; unusable propose profile refuses before cuts", async () => {
  const w = await world();
  expect(
    (
      await w.post("/api/agents/profile", {
        name: "shared",
        settings: { ...DEFAULT_AGENT, harness: "codex", model: "group-model" },
      })
    ).status,
  ).toBe(200);
  expect(
    (await w.start({ action: "propose", profiles: ["shared"] })).status,
  ).toBe(400);
  expect(w.cutCounts).toEqual([]);
  const response = await w.start({ profiles: ["shared"] });
  const group = groupBody(await response.json());
  expect(group.members.map((m) => m.profile)).toEqual(["shared", "shared"]);
  await until(() => w.starts.length === 2, "profile starts");
  expect(w.starts.map((s) => [s.harness, s.ctx.agent.model])).toEqual([
    ["codex", "group-model"],
    ["codex", "group-model"],
  ]);
});

for (const failure of ["third start", "third cut"] as const)
  test(`${failure} failure removes all own worktrees, landing records, and group while closing work items`, async () => {
    const w = await world(
      failure === "third start" ? { failCheck: 3 } : { cutFailure: true },
    );
    const response = await w.start({ times: 3 });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      error: expect.stringContaining(
        failure === "third start" ? "third member" : "third cut",
      ),
    });
    expect(await w.diskGroups()).toEqual([]);
    expect(
      (await git(w.repo, "worktree", "list", "--porcelain")).match(
        /^worktree /gm,
      ),
    ).toHaveLength(1);
    expect(await git(w.repo, "branch", "--list", "run/*")).toBe("");
    expect((await w.landing()).runs).toEqual([]);
    expect((await w.readRuns()).every((r) => r.status !== "working")).toBe(
      true,
    );
    const work: unknown = await (await fetch(w.url("/api/work"))).json();
    expect(work).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ state: "dropped" }),
      ]),
    });
  });

test("group and low priority are present on the first real SSE run event and cost rows", async () => {
  const w = await world();
  const abort = new AbortController();
  const response = await fetch(w.url("/api/events"), { signal: abort.signal });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE absent");
  const first = new Map<string, unknown>();
  let buffered = "";
  const pumping = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffered += new TextDecoder().decode(chunk.value);
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";
        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue;
          const event: unknown = JSON.parse(frame.slice(6));
          if (
            isRecord(event) &&
            event["type"] === "run" &&
            isRecord(event["run"]) &&
            typeof event["run"]["id"] === "string" &&
            !first.has(event["run"]["id"])
          )
            first.set(event["run"]["id"], event["run"]);
        }
      }
    } catch {
      /* reader is cancelled after the assertions */
    }
  })();
  try {
    const group = groupBody(await (await w.start()).json());
    await until(() => first.size === 2, "first events");
    for (const event of first.values())
      expect(event).toMatchObject({
        group: group.id,
        priority: "low",
        branch: { group: group.id },
      });
    await until(() => w.starts.length === 2, "drivers");
    await w.finish(0);
    const report = await until(async () => {
      const value: unknown = await (
        await fetch(w.url("/api/costs?since=0"))
      ).json();
      return isRecord(value) &&
        Array.isArray(value["rows"]) &&
        value["rows"].length
        ? value
        : undefined;
    }, "cost row");
    expect(report).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ group: group.id }),
      ]),
    });
  } finally {
    abort.abort();
    await pumping;
  }
});

test("group members stay sorted and ready without independent queueing; compare waits for checkout and uses safe flow routing", async () => {
  const w = await world({ autoSort: true });
  await w.post("/api/agents/role", {
    role: "flow",
    pick: {
      ...DEFAULT_AGENT,
      model: "sonnet",
      yolo: true,
      extra: "--dangerously-skip-permissions",
    },
  });
  expect(
    (
      await w.post("/api/repos/run?id=app", {
        action: "ask",
        note: "checkout",
        branch: false,
      })
    ).status,
  ).toBe(201);
  await until(() => w.starts.length === 1, "checkout");
  const group = groupBody(await (await w.start()).json());
  await until(() => w.starts.length === 3, "members");
  await w.finish(1);
  await w.finish(2);
  await until(
    async () =>
      (await w.landing()).runs.every((r) => r.review) &&
      (await w.groups()).find((g) => g.id === group.id)?.state === "reviewing",
    "waiting comparison",
  );
  expect((await w.landing()).entries).toEqual([]);
  expect(w.starts).toHaveLength(3);
  await w.finish(0);
  await until(() => w.starts.length === 4, "reviewer");
  const reviewer = w.starts[3];
  if (!reviewer) throw new Error("reviewer absent");
  expect(reviewer.ctx.cwd).toBe(w.repo);
  expect(reviewer.ctx.agent).toMatchObject({
    model: "sonnet",
    yolo: false,
    extra: "",
  });
  expect(reviewer.ctx.spec).toMatchObject({
    maxTurns: 40,
    allowedTools: ACTIONS.compare.allowedTools,
    unattended: ACTIONS.compare.unattended,
  });
  expect(reviewer.message).toContain("git diff");
  expect(reviewer.message).toContain("<<<compare");
  const answer = await reviewer.ctx.ask(
    {
      kind: "question",
      questions: [
        {
          question: "approve?",
          header: "Q",
          options: [{ label: "yes", description: "yes" }],
          multiSelect: false,
        },
      ],
    },
    "unsafe",
  );
  expect(answer.kind).toBe("deny");
  expect(
    (await w.readRuns()).find((r) => r.action === "compare"),
  ).toMatchObject({ group: group.id });
  const branches = (await w.landing()).runs.map((r) => r.branch);
  await w.finish(
    3,
    `<<<compare\n${JSON.stringify({ ranking: branches, why: Object.fromEntries(branches.map((b) => [b, "Good work."])) })}\n>>>`,
  );
  await until(
    async () =>
      (await w.groups()).find((g) => g.id === group.id)?.state === "picked",
    "winner",
  );
  expect((await w.landing()).entries).toEqual([]);
});

test("concurrent groups reserve slots before the second request cuts anything", async () => {
  const w = await world();
  const responses = await Promise.all([w.start(), w.start()]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(w.cutCounts).toEqual([2, 2]);
  expect(await w.diskGroups()).toHaveLength(1);
});

test("a failed group preserves another branch run and its worktree", async () => {
  const w = await world({ failCheck: 3 });
  expect((await w.start({ times: 1 })).status).toBe(201);
  const before = await git(w.repo, "branch", "--list", "run/*");
  expect((await w.start()).status).toBe(400);
  expect(await git(w.repo, "branch", "--list", "run/*")).toBe(before);
  expect(
    (await w.readRuns()).filter((r) => r.status === "working"),
  ).toHaveLength(1);
  expect((await w.landing()).runs).toHaveLength(1);
  expect(await w.diskGroups()).toEqual([]);
});

test("an auto-land group dispatches its picked winner and drops only the loser", async () => {
  const w = await world({ autoSort: true });
  const group = groupBody(await (await w.start({ autoLand: true })).json());
  await until(() => w.starts.length === 2, "members");
  await w.finish(0);
  await w.finish(1);
  await until(() => w.starts.length === 3, "compare");
  const branches = (await w.landing()).runs.map((r) => r.branch);
  await w.finish(
    2,
    `<<<compare\n${JSON.stringify({ ranking: branches, why: Object.fromEntries(branches.map((b) => [b, "Sound work."])) })}\n>>>`,
  );
  await until(
    async () =>
      (await w.groups()).find((g) => g.id === group.id)?.state === "landed",
    "winner lands",
  );
  await until(
    async () => (await w.landing()).runs.length === 0,
    "member cleanup",
  );
  expect(await git(w.repo, "log", "-1", "--format=%s")).toBe("work 0");
  expect(await git(w.repo, "branch", "--list", "run/*")).toBe("");
});

test("PR groups never independently push members and only the picked winner opens a PR", async () => {
  const w = await world({ prs: true });
  const group = groupBody(await (await w.start({ pr: true })).json());
  await until(() => w.starts.length === 2, "members");
  await w.finish(0);
  await w.finish(1);
  await until(() => w.starts.length === 3, "reviewer");
  expect(
    w.ghCalls.filter((args) => args[0] === "pr" && args[1] === "create"),
  ).toEqual([]);
  const branches = (await w.landing()).runs.map((r) => r.branch).reverse();
  await w.finish(
    2,
    `<<<compare\n${JSON.stringify({ ranking: branches, why: Object.fromEntries(branches.map((branch) => [branch, "Good work."])) })}\n>>>`,
  );
  await until(
    () => w.ghCalls.some((args) => args[0] === "pr" && args[1] === "create"),
    "winner PR",
  );
  const calls = w.ghCalls.filter(
    (args) => args[0] === "pr" && args[1] === "create",
  );
  const winner = branches[0];
  if (!winner) throw new Error("missing branch");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain(winner);
  const remoteBranches = await git(
    w.repo,
    "ls-remote",
    "--heads",
    "origin",
    "run/*",
  );
  expect(remoteBranches.split("\n")).toHaveLength(1);
  expect(remoteBranches).toContain(winner);
  expect((await w.groups()).find((g) => g.id === group.id)?.state).toBe(
    "picked",
  );
});

test("the actual caller gate requires operate for group mutations", async () => {
  const w = await world({ enforce: true });
  const forbidden = await fetch(w.url("/api/groups/drop"), {
    method: "POST",
    body: JSON.stringify({ group: "none" }),
    headers: { "X-Canopy-Token": w.limitedToken ?? "" },
  });
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toMatchObject({ need: "operate" });
  expect((await w.post("/api/groups/drop", { group: "none" })).status).toBe(
    404,
  );
});

test("a grouped landing fix preserves both group ids and stays out of the queue until fresh selection", async () => {
  const w = await world({ autoSort: true });
  const group = groupBody(await (await w.start()).json());
  await until(() => w.starts.length === 2, "members");
  await w.finish(0);
  await w.finish(1);
  await until(() => w.starts.length === 3, "reviewer");
  const branches = (await w.landing()).runs.map((r) => r.branch);
  const comparison = `<<<compare\n${JSON.stringify({ ranking: branches, why: Object.fromEntries(branches.map((branch) => [branch, "Good work."])) })}\n>>>`;
  await w.finish(2, comparison);
  await until(
    async () =>
      (await w.groups()).find((g) => g.id === group.id)?.state === "picked",
    "pick",
  );
  const origin = group.members[0]?.origin;
  if (!origin) throw new Error("missing winner");
  const gateFile = join(w.repo, ".canopy", "gates.json");
  await writeFile(
    gateFile,
    JSON.stringify({ gates: [{ name: "test", run: "false" }] }),
  );
  await git(w.repo, "add", "-A");
  await git(w.repo, "commit", "-qm", "red gate");
  expect((await w.post("/api/landing/land", { run: origin })).status).toBe(200);
  await until(
    async () =>
      (await w.landing()).entries.some(
        (e: unknown) => isRecord(e) && e["state"] === "red",
      ),
    "sent back",
  );
  expect((await w.post("/api/landing/fix", { id: origin })).status).toBe(201);
  await until(() => w.starts.length === 4, "fix");
  const fixId = w.starts[3]?.ctx.env["CANOPY_RUN"];
  expect((await w.readRuns()).find((r) => r.id === fixId)).toMatchObject({
    group: group.id,
    priority: "low",
    branch: { group: group.id },
  });
  await writeFile(
    gateFile,
    JSON.stringify({ gates: [{ name: "test", run: "true" }] }),
  );
  await git(w.repo, "add", "-A");
  await git(w.repo, "commit", "-qm", "green gate");
  await w.finish(3);
  await until(() => w.starts.length === 5, "fresh reviewer");
  expect((await w.landing()).entries).toEqual([
    expect.objectContaining({ state: "red" }),
  ]);
  await w.finish(4, comparison);
  await until(
    async () =>
      (await w.groups()).find((g) => g.id === group.id)?.state === "picked",
    "fresh pick",
  );
  expect((await w.landing()).entries).toEqual([
    expect.objectContaining({ state: "red" }),
  ]);
});

test("a workflow gate owns the checkout between runs and the reviewer starts once after it finishes", async () => {
  const w = await world({ flow: true });
  const response = await w.post("/api/repos/flow?id=app", { workflow: "hold" });
  expect(response.status).toBe(201);
  const flow: unknown = await response.json();
  if (!isRecord(flow) || typeof flow["id"] !== "string")
    throw new Error("missing flow");
  const id = flow["id"];
  await until(() => w.starts.length === 1, "flow first step");
  await w.finish(0);
  await until(async () => {
    const flows: unknown = await (await fetch(w.url("/api/flows"))).json();
    return (
      Array.isArray(flows) &&
      flows.some(
        (flow: unknown) =>
          isRecord(flow) && flow["id"] === id && flow["status"] === "gated",
      )
    );
  }, "workflow gate");
  const group = groupBody(await (await w.start()).json());
  await until(() => w.starts.length === 3, "branch members");
  await w.finish(1);
  await w.finish(2);
  await until(
    async () =>
      (await w.groups()).find((g) => g.id === group.id)?.state === "reviewing",
    "waiting comparison",
  );
  expect(w.starts).toHaveLength(3);
  expect(
    (await w.post("/api/flows/resume", { id, choice: "continue" })).status,
  ).toBe(200);
  await until(() => w.starts.length === 4, "flow second step");
  expect(w.starts[3]?.ctx.spec.maxTurns).not.toBe(40);
  await w.finish(3);
  await until(() => w.starts.length === 5, "reviewer after flow");
  expect(w.starts[4]?.ctx.spec.maxTurns).toBe(40);
  expect(
    (await w.readRuns()).filter((run) => run.action === "compare"),
  ).toHaveLength(1);
});

const barrier = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

test("fanout rollback retains every tree and record until an early-result member actually exits", async () => {
  let stopRequested = false;
  const failed = barrier();
  const w = await world({
    failCheck: 3,
    earlyResult: true,
    checkReached: (check) => {
      if (check === 3) failed.release();
    },
    holdExit: (ctx) => {
      if (ctx === w.starts[0]?.ctx) {
        stopRequested = true;
        return true;
      }
      return false;
    },
  });
  let answered = false;
  const response = w.start({ times: 3 }).then((result) => {
    answered = true;
    return result;
  });
  await failed.promise;
  const first = w.starts[0];
  if (!first) throw new Error("first driver absent");
  try {
    await until(
      () => stopRequested || !existsSync(first.ctx.cwd),
      "rollback reaches the lingering process",
    );
    expect(stopRequested).toBe(true);
    expect(answered).toBe(false);
    expect(w.starts.every((start) => existsSync(start.ctx.cwd))).toBe(true);
    expect((await w.landing()).runs).toHaveLength(2);
  } finally {
    first.ctx.exited({ code: 0, stderr: "" });
    await response;
  }
  expect((await w.landing()).runs).toEqual([]);
  expect(await w.diskGroups()).toEqual([]);
  expect(
    (await git(w.repo, "worktree", "list", "--porcelain")).match(
      /^worktree /gm,
    ),
  ).toHaveLength(1);
});

for (const invalidation of ["detach", "drop", "fix"] as const)
  test(`real reviewer preflight cannot start after ${invalidation}`, async () => {
    const entered = barrier();
    const release = barrier();
    let preflights = 0;
    const w = await world({
      autoSort: true,
      reviewerPreflight: async () => {
        if (++preflights === 1) {
          entered.release();
          await release.promise;
        }
      },
    });
    const group = groupBody(await (await w.start()).json());
    await until(() => w.starts.length === 2, "members");
    await w.finish(0);
    await w.finish(1);
    await entered.promise;
    let dropping: Promise<Response> | undefined;
    if (invalidation === "detach") await w.server.stop();
    else if (invalidation === "drop") {
      dropping = w.post("/api/groups/drop", { group: group.id });
      await until(
        async () =>
          (await w.groups()).find((g) => g.id === group.id)?.state ===
          "dropped",
        "drop invalidation",
      );
    } else {
      const origin = group.members[0]?.origin;
      if (!origin) throw new Error("missing member");
      const gateFile = join(w.repo, ".canopy", "gates.json");
      await writeFile(
        gateFile,
        JSON.stringify({ gates: [{ name: "test", run: "false" }] }),
      );
      await git(w.repo, "add", "-A");
      await git(w.repo, "commit", "-qm", "red before fix");
      expect((await w.post("/api/landing/land", { run: origin })).status).toBe(
        200,
      );
      await until(
        async () =>
          (await w.landing()).entries.some(
            (entry: unknown) => isRecord(entry) && entry["state"] === "red",
          ),
        "queue failure",
      );
      expect((await w.post("/api/landing/fix", { id: origin })).status).toBe(
        201,
      );
      await until(() => w.starts.length === 3, "member fix");
      expect((await w.groups()).find((g) => g.id === group.id)?.state).toBe(
        "working",
      );
    }
    release.release();
    if (dropping) expect((await dropping).status).toBe(200);
    await Bun.sleep(20);
    expect(w.starts.filter((start) => start.ctx.spec.maxTurns === 40)).toEqual(
      [],
    );
    if (invalidation !== "detach") {
      const groups: unknown = await (await fetch(w.url("/api/groups"))).json();
      if (!Array.isArray(groups)) throw new Error("missing groups");
      const current = groups.find(
        (value: unknown) => isRecord(value) && value["id"] === group.id,
      );
      expect(current).toBeDefined();
      expect(current).not.toHaveProperty("review");
    }
    if (invalidation === "fix") {
      await writeFile(
        join(w.repo, ".canopy", "gates.json"),
        JSON.stringify({ gates: [{ name: "test", run: "true" }] }),
      );
      await git(w.repo, "add", "-A");
      await git(w.repo, "commit", "-qm", "fixed gate");
      await w.finish(2);
      await until(
        () => w.starts.length === 4,
        "fresh reviewer after invalidation",
      );
      expect(
        w.starts.filter((start) => start.ctx.spec.maxTurns === 40),
      ).toHaveLength(1);
      const groups: unknown = await (await fetch(w.url("/api/groups"))).json();
      expect(groups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: group.id,
            state: "reviewing",
            review: expect.objectContaining({
              run: w.starts[3]?.ctx.env["CANOPY_RUN"],
            }),
          }),
        ]),
      );
    }
  });

test("repo land-all queues a standalone and only a picked non-PR group winner", async () => {
  const w = await world();
  const group = groupBody(await (await w.start()).json());
  const single: unknown = await (await w.start({ times: 1 })).json();
  if (!isRecord(single) || !isRecord(single["branch"]) || typeof single["branch"]["origin"] !== "string") throw new Error("standalone branch missing");
  const standalone = single["branch"]["origin"];
  await w.finish(0);
  await w.finish(1);
  await w.finish(2);
  await until(() => w.starts.length === 4, "group reviewer");
  await until(async () => {
    const info: unknown = await (await fetch(w.url("/api/landing"))).json();
    if (!isRecord(info) || !Array.isArray(info["runs"])) throw new Error("landing runs absent");
    return info["runs"].find((run: unknown) => isRecord(run) && run["id"] === standalone && run["state"] === "ready");
  }, "standalone landing record ready");
  const before = await w.post("/api/landing/land-all", { repo: "app" });
  expect(before.status).toBe(200);
  const unpicked: unknown = await before.json();
  expect(unpicked).toMatchObject({ queued: [standalone], skipped: group.members.map(m => ({ id: m.origin })) });
  const winner = group.members[0];
  const loser = group.members[1];
  if (!winner || !loser) throw new Error("members missing");
  expect((await w.post("/api/groups/pick", { group: group.id, run: winner.origin })).status).toBe(200);
  const picked: unknown = await (await w.post("/api/landing/land-all", { repo: "app" })).json();
  expect(picked).toMatchObject({ queued: [winner.origin], skipped: [{ id: loser.origin }] });
  const entries = (await w.landing()).entries;
  expect(entries).not.toContainEqual(expect.objectContaining({ id: loser.origin }));
});

test("a bulk-picked group winner still runs current command gates and cannot fast-forward red work", async () => {
  const w = await world();
  const group = groupBody(await (await w.start()).json());
  await w.finish(0);
  await w.finish(1);
  await until(() => w.starts.length === 3, "reviewer");
  const winner = group.members[0];
  const loser = group.members[1];
  if (!winner || !loser) throw new Error("members missing");
  expect((await w.post("/api/groups/pick", { group: group.id, run: winner.origin })).status).toBe(200);
  await mkdir(join(w.repo, ".canopy"), { recursive: true });
  await writeFile(join(w.repo, ".canopy", "gates.json"), JSON.stringify({ gates: [{ name: "current-test", run: "false" }] }));
  await git(w.repo, "add", "-A");
  await git(w.repo, "commit", "-qm", "require a failing gate");
  const head = await git(w.repo, "rev-parse", "HEAD");
  expect(await (await w.post("/api/landing/land-all", { repo: "app" })).json()).toMatchObject({ queued: [winner.origin], skipped: [{ id: loser.origin }] });
  await until(async () => (await w.landing()).entries.find(e => isRecord(e) && e["id"] === winner.origin && e["state"] === "red"), "winner's current gate goes red");
  expect(await git(w.repo, "rev-parse", "HEAD")).toBe(head);
});

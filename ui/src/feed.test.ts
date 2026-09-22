import { describe, expect, test } from "bun:test";
import type { Fleet, Flow, Job, Repo, RepoStatus, Run, SourceState } from "../../src/core/types";
import {
  appendFeed,
  clip,
  clock,
  describeEvent,
  filterFeed,
  listNames,
  statusLines,
  type FeedEntry,
  type FeedSnapshot,
} from "./feed";

const status = (over: Partial<RepoStatus> = {}): RepoStatus => ({
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  files: [],
  lastCommit: { hash: "abcdef0123456789", subject: "first", at: 1 },
  user: null,
  ...over,
});

const repo = (over: Partial<Repo> = {}): Repo => ({
  id: "a",
  name: "alpha",
  path: "/r/alpha",
  group: "",
  source: "launch",
  status: status(),
  ...over,
});

function source(over: { id?: string; label?: string; scannedAt?: number; error?: string } = {}): SourceState {
  const s: SourceState = {
    kind: "local",
    path: "/r",
    id: over.id ?? "launch",
    label: over.label ?? "root",
    launch: (over.id ?? "launch") === "launch",
    repos: 1,
    scannedAt: over.scannedAt ?? 10,
  };
  if (over.error !== undefined) s.error = over.error;
  return s;
}

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  repoId: "a",
  action: "commit",
  verb: "commit",
  progress: "committing",
  expectsChange: true,
  chat: false,
  note: "",
  status: "working",
  startedAt: 0,
  steps: [],
  prompt: null,
  ...over,
});

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: "f1",
  repoId: "a",
  workflow: "ship",
  verb: "ship",
  note: "",
  status: "working",
  steps: [{ name: "test", status: "running" }, { name: "push", status: "pending" }],
  current: 0,
  startedAt: 0,
  ...over,
});

const snap = (over: Partial<FeedSnapshot> = {}): FeedSnapshot => ({
  repos: [repo()],
  sources: [source()],
  runs: {},
  flows: {},
  fleets: {},
  workspaces: [],
  ...over,
});

describe("statusLines", () => {
  test("nothing to say when nothing moved", () => {
    expect(statusLines(status(), status())).toEqual([]);
  });
  test("a first reading says the branch", () => {
    expect(statusLines(null, status({ files: [{ path: "x", index: ".", worktree: "M", untracked: false, conflicted: false }] }))).toEqual([
      "on main, 1 changed",
    ]);
  });
  test("branch, commit, and position each get a line", () => {
    const after = status({ branch: "fix", ahead: 2, lastCommit: { hash: "1234567890", subject: "fix it", at: 2 } });
    expect(statusLines(status(), after)).toEqual(["switched to fix from main", "commit 1234567 fix it", "2 ahead"]);
  });
  test("files added, edited, and reverted", () => {
    const f = (path: string, mtime: number) => ({ path, index: ".", worktree: "M", untracked: false, conflicted: false, mtime });
    const before = status({ files: [f("keep", 1), f("gone", 1)] });
    const after = status({ files: [f("keep", 2), f("new", 1)] });
    expect(statusLines(before, after)).toEqual(["changed new", "edited keep", "reverted gone"]);
  });
  test("back to clean", () => {
    const f = { path: "x", index: ".", worktree: "M", untracked: false, conflicted: false };
    expect(statusLines(status({ files: [f] }), status())).toEqual(["clean"]);
  });
  test("in sync once ahead drops to zero", () => {
    expect(statusLines(status({ ahead: 3 }), status())).toEqual(["in sync with upstream"]);
  });
  test("a remote branch moving past the checkout is a line, the same tip again is not", () => {
    const tip = { ref: "origin/claude/tailcat", hash: "0e1d6fd", subject: "tailcat", at: 9 };
    expect(statusLines(status(), status({ tip }))).toEqual(["origin/claude/tailcat pushed 0e1d6fd tailcat"]);
    expect(statusLines(status({ tip }), status({ tip }))).toEqual([]);
    // a fetch that pruned the branch says nothing: the checkout did not change
    expect(statusLines(status({ tip }), status())).toEqual([]);
  });
});

describe("describeEvent", () => {
  test("a repo event with no change is quiet and names the repo", () => {
    const lines = describeEvent({ type: "repo", repo: repo() }, snap(), 5);
    expect(lines).toEqual([
      { at: 5, kind: "git", source: "launch", repoId: "a", repo: "alpha", text: "re-read, no change", quiet: true },
    ]);
  });
  test("a pull request count arriving or changing is a line, the same count or a first zero is quiet", () => {
    const pulls = { open: 2, url: "https://github.com/o/alpha/pulls" };
    const texts = (ev: Repo, prev: Repo) => describeEvent({ type: "repo", repo: ev }, snap({ repos: [prev] }), 5).map((l) => l.text);
    expect(texts(repo({ pulls }), repo())).toEqual(["2 open pull requests"]);
    expect(texts(repo({ pulls: { ...pulls, open: 1 } }), repo({ pulls }))).toEqual(["1 open pull request"]);
    expect(texts(repo({ pulls: { ...pulls, open: 0 } }), repo({ pulls }))).toEqual(["no open pull requests"]);
    expect(texts(repo({ pulls }), repo({ pulls }))).toEqual(["re-read, no change"]);
    expect(texts(repo({ pulls: { ...pulls, open: 0 } }), repo())).toEqual(["re-read, no change"]);
  });
  test("a repo error is one line and not quiet", () => {
    const lines = describeEvent({ type: "repo", repo: repo({ error: "boom" }) }, snap(), 5);
    expect(lines.map((l) => l.text)).toEqual(["error: boom"]);
    expect(lines[0]?.quiet).toBe(false);
  });
  test("a scan reports each source, new and gone repos by name", () => {
    const prev = snap({ repos: [repo(), repo({ id: "b", name: "beta" })] });
    const nas: SourceState = { kind: "ssh", host: "nas", path: "/x", id: "nas", label: "nas", launch: false, repos: 1, scannedAt: 20 };
    const result = {
      root: "/r",
      sources: [source({ scannedAt: 20 }), nas],
      repos: [repo(), repo({ id: "c", name: "gamma" }), repo({ id: "nas:d", name: "delta", source: "nas" })],
      scannedAt: 20,
      backend: { openers: true, sshHost: null },
    };
    const lines = describeEvent({ type: "scan", result }, prev, 5);
    expect(lines.map((l) => [l.source, l.text, l.quiet])).toEqual([
      ["launch", "rescanned, 2 repos; new gamma; gone beta", false],
      ["nas", "source nas added, 1 repo", false],
    ]);
  });
  test("a scan with the same scannedAt says nothing for that source", () => {
    const result = { root: "/r", sources: [source()], repos: [repo()], scannedAt: 10 , backend: { openers: true, sshHost: null } };
    expect(describeEvent({ type: "scan", result }, snap(), 5)).toEqual([]);
  });
  test("a scan failure and its recovery", () => {
    const failed = { root: "/r", sources: [source({ error: "no ssh", scannedAt: 20 })], repos: [repo()], scannedAt: 20 , backend: { openers: true, sshHost: null } };
    expect(describeEvent({ type: "scan", result: failed }, snap(), 5).map((l) => l.text)).toEqual(["scan failed: no ssh"]);
    const back = { root: "/r", sources: [source({ scannedAt: 30 })], repos: [repo()], scannedAt: 30 , backend: { openers: true, sshHost: null } };
    const prev = snap({ sources: [source({ error: "no ssh", scannedAt: 20 })] });
    expect(describeEvent({ type: "scan", result: back }, prev, 5).map((l) => l.text)).toEqual([
      "scan recovered",
      "rescanned, 1 repo",
    ]);
  });
  test("a new run says it started with its note, then each step, then how it ended", () => {
    const first = run({ note: "wip" });
    expect(describeEvent({ type: "run", run: first }, snap(), 5).map((l) => l.text)).toEqual(["commit started: wip"]);
    const stepped = run({
      note: "wip",
      steps: [
        { id: "s1", at: 1, kind: "tool", tool: { name: "Bash", title: "git status", status: "ok" } },
        { id: "s2", at: 2, kind: "text", text: "Looks   clean.\nDone." },
      ],
    });
    const prev = snap({ runs: { r1: first } });
    expect(describeEvent({ type: "run", run: stepped }, prev, 5).map((l) => l.text)).toEqual([
      "Bash: git status",
      "claude: Looks clean. Done.",
    ]);
    const done = run({
      note: "wip",
      steps: stepped.steps,
      status: "done",
      outcome: "changed",
      result: { text: "", costUsd: 0, durationMs: 4200, turns: 1 },
    });
    expect(describeEvent({ type: "run", run: done }, snap({ runs: { r1: stepped } }), 5).map((l) => l.text)).toEqual([
      "commit done, changed in 4s",
    ]);
  });
  test("a permission prompt says what Claude asks for", () => {
    const waiting = run({ status: "waiting", prompt: { id: "p", kind: "permission", tool: "Bash", title: "rm -rf dist", detail: "" } });
    const lines = describeEvent({ type: "run", run: waiting }, snap({ runs: { r1: run() } }), 5);
    expect(lines.map((l) => l.text)).toEqual(["asks to Bash: rm -rf dist"]);
  });
  test("a chat opens, then goes idle when Claude answers", () => {
    const chat = run({ chat: true, status: "idle" });
    expect(describeEvent({ type: "run", run: chat }, snap(), 5).map((l) => l.text)).toEqual(["chat opened"]);
    const idle = run({ chat: true, status: "idle" });
    const prev = snap({ runs: { r1: run({ chat: true, status: "working" }) } });
    expect(describeEvent({ type: "run", run: idle }, prev, 5).map((l) => l.text)).toEqual(["claude answered, chat idle"]);
  });
  test("run-gone names the run it knew", () => {
    const lines = describeEvent({ type: "run-gone", id: "r1" }, snap({ runs: { r1: run() } }), 5);
    expect(lines).toEqual([{ at: 5, kind: "run", source: "launch", repoId: "a", repo: "alpha", text: "commit dismissed", quiet: true }]);
  });
  test("a flow reports its start, step changes, and end", () => {
    const first = flow();
    expect(describeEvent({ type: "flow", flow: first }, snap(), 5).map((l) => l.text)).toEqual([
      "workflow ship started",
      "step test running",
    ]);
    const gated = flow({ status: "gated", steps: [{ name: "test", status: "gated", reason: "tests failed" }, { name: "push", status: "pending" }] });
    expect(describeEvent({ type: "flow", flow: gated }, snap({ flows: { f1: first } }), 5).map((l) => l.text)).toEqual([
      "step test gated: tests failed",
    ]);
    const done = flow({ status: "done", outcome: "changed", steps: [{ name: "test", status: "passed" }, { name: "push", status: "passed" }] });
    expect(describeEvent({ type: "flow", flow: done }, snap({ flows: { f1: gated } }), 5).map((l) => l.text)).toEqual([
      "step test passed",
      "step push passed",
      "workflow ship done, changed",
    ]);
  });
  test("a fleet starts, skips, and ends", () => {
    const fleet: Fleet = { id: "x", workflow: "ship", verb: "ship", note: "", repos: [{ repoId: "a" }, { repoId: "b" }], status: "working", startedAt: 0 };
    expect(describeEvent({ type: "fleet", fleet }, snap(), 5).map((l) => [l.source, l.text])).toEqual([["", "fleet ship over 2 repos"]]);
    const skipped: Fleet = { ...fleet, repos: [{ repoId: "a", skipped: "clean" }, { repoId: "b" }] };
    expect(describeEvent({ type: "fleet", fleet: skipped }, snap({ fleets: { x: fleet } }), 5).map((l) => [l.repo, l.text])).toEqual([
      ["alpha", "skipped: clean"],
    ]);
    const done: Fleet = { ...skipped, status: "done" };
    expect(describeEvent({ type: "fleet", fleet: done }, snap({ fleets: { x: skipped } }), 5).map((l) => l.text)).toEqual(["fleet ship done"]);
  });
  test("workspaces and agents diff by name and path", () => {
    const ws = describeEvent({ type: "workspaces", workspaces: [{ name: "w", repos: ["/r/alpha"] }] }, snap(), 5);
    expect(ws.map((l) => l.text)).toEqual(["workspace w created with 1 repo"]);
    const ag = describeEvent({ type: "agents", agents: { "/r/alpha": { model: "opus" } as never } }, snap(), 5, {});
    expect(ag.map((l) => [l.repo, l.text])).toEqual([["alpha", "agent settings changed"]]);
    const reset = describeEvent({ type: "agents", agents: {} }, snap(), 5, { "/r/alpha": { model: "opus" } });
    expect(reset.map((l) => l.text)).toEqual(["agent settings reset"]);
  });

  test("jobs: start, end, dismissal; builds and launch settings", () => {
    const job: Job = {
      id: "j1",
      repoId: "a",
      kind: "install",
      build: "release:v1.0",
      title: "install v1.0",
      status: "working",
      startedAt: 1000,
      lines: [],
    };
    const started = describeEvent({ type: "job", job }, snap(), 5);
    expect(started.map((l) => [l.kind, l.repo, l.text])).toEqual([["launch", "alpha", "install v1.0 started"]]);
    // the same job again, still working: nothing new to say
    expect(describeEvent({ type: "job", job }, snap({ jobs: { j1: job } }), 5)).toEqual([]);
    const done = describeEvent(
      { type: "job", job: { ...job, status: "done", endedAt: 4000 } },
      snap({ jobs: { j1: job } }),
      5,
    );
    expect(done.map((l) => l.text)).toEqual(["install v1.0 done in 3s"]);
    const failed = describeEvent(
      { type: "job", job: { ...job, status: "failed", error: "download failed: 404" } },
      snap({ jobs: { j1: job } }),
      5,
    );
    expect(failed.map((l) => l.text)).toEqual(["install v1.0 failed: download failed: 404"]);
    const gone = describeEvent({ type: "job-gone", id: "j1" }, snap({ jobs: { j1: job } }), 5);
    expect(gone.map((l) => [l.text, l.quiet])).toEqual([["install v1.0 dismissed", true]]);

    const launched = describeEvent({ type: "builds", repoId: "a", what: "launched", build: "pr:12" }, snap(), 5);
    expect(launched.map((l) => [l.repo, l.text, l.quiet])).toEqual([["alpha", "launched PR #12", false]]);
    const exited = describeEvent({ type: "builds", repoId: "a", what: "exited", build: "local" }, snap(), 5);
    expect(exited.map((l) => [l.text, l.quiet])).toEqual([["this checkout exited", true]]);
    const removed = describeEvent({ type: "builds", repoId: "a", what: "removed", build: "release:v1.0" }, snap(), 5);
    expect(removed.map((l) => l.text)).toEqual(["removed v1.0"]);

    const set = describeEvent(
      { type: "launchers", launchers: { "/r/alpha": { asset: "", build: "make", run: "", launch: "" } } },
      snap(),
      5,
    );
    expect(set.map((l) => [l.repo, l.text])).toEqual([["alpha", "launch settings changed"]]);
    const same = describeEvent(
      { type: "launchers", launchers: { "/r/alpha": { asset: "", build: "make", run: "", launch: "" } } },
      snap({ launchers: { "/r/alpha": { asset: "", build: "make", run: "", launch: "" } } }),
      5,
    );
    expect(same).toEqual([]);
  });
});

describe("appendFeed and filterFeed", () => {
  const line = (text: string, source = "launch", quiet = false) => ({ at: 0, kind: "git" as const, source, text, quiet });
  test("numbers entries from seq and drops the oldest past the cap", () => {
    const one = appendFeed([], [line("a"), line("b")], 1);
    expect(one.feed.map((e) => e.id)).toEqual([1, 2]);
    expect(one.seq).toBe(3);
    const two = appendFeed(one.feed, [line("c")], one.seq, 2);
    expect(two.feed.map((e) => e.text)).toEqual(["b", "c"]);
  });
  test("an empty append returns the same list", () => {
    const feed: FeedEntry[] = [];
    expect(appendFeed(feed, [], 1).feed).toBe(feed);
  });
  test("filters by source, keeps sourceless entries, hides quiet ones unless asked", () => {
    const feed = appendFeed([], [line("a"), line("b", "nas"), line("c", ""), line("d", "launch", true)], 1).feed;
    expect(filterFeed(feed, "launch", false).map((e) => e.text)).toEqual(["a", "c"]);
    expect(filterFeed(feed, "launch", true).map((e) => e.text)).toEqual(["a", "c", "d"]);
    expect(filterFeed(feed, null, false).map((e) => e.text)).toEqual(["a", "b", "c"]);
  });
});

describe("words", () => {
  test("listNames stops at three", () => {
    expect(listNames(["a", "b", "c", "d", "e"])).toBe("a, b, c +2 more");
    expect(listNames(["a"])).toBe("a");
  });
  test("clip flattens whitespace and ends with an ellipsis", () => {
    expect(clip("a\n  b")).toBe("a b");
    expect(clip("x".repeat(10), 5)).toBe("xxxx…");
  });
  test("clock is HH:MM:SS local", () => {
    expect(clock(new Date(2026, 0, 1, 9, 5, 7).getTime())).toBe("09:05:07");
  });
});

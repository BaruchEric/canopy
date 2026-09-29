import { describe, expect, test } from "bun:test";
import { qualify, split, type Reg } from "./backends";
import {
  mergeHistory,
  qDevice,
  qEvent,
  qFleet,
  qFlow,
  qGrep,
  qHistory,
  qJob,
  qKept,
  qRepo,
  qRun,
  qScan,
  qTask,
  qTerm,
} from "./qualify";
import type {
  Device,
  Fleet,
  TaskInfo,
  Flow,
  HistoryOverview,
  Job,
  KeptShell,
  Repo,
  RepoHistory,
  Run,
  ScanResult,
  ServerEvent,
  TermInfo,
} from "../../src/core/types";

const reg: Reg = { home: "mini", names: ["mini", "mac"] };
const q = (id: string) => qualify(reg, "mac", id);
const back = (id: string) => split(reg, id);

const repo = { id: "a/b", name: "b", path: "/x/a/b", group: "a", source: "launch", status: null } as Repo;
const run = { id: "r1", repoId: "a/b" } as Run;
const flow = { id: "f1", repoId: "a/b", fleetId: "fl1", steps: [{ name: "s", status: "passed", runId: "r1" }, { name: "t", status: "pending" }] } as Flow;
const fleet = { id: "fl1", repos: [{ repoId: "a/b", flowId: "f1" }, { repoId: "c", skipped: "clean" }] } as Fleet;
const job = { id: "j1", repoId: "a/b" } as Job;
const term = { id: "0123456789abcdef0123456789abcdef", repoId: "a/b" } as TermInfo;
const kept = { id: "0123456789abcdef0123456789abcdef", repoId: "a/b" } as KeptShell;
const device = { id: "00ff00ff00ff00ff", name: "phone" } as Device;

describe("shapes", () => {
  test("a repo, its source and a forge clone's id", () => {
    const out = qRepo(q, { ...repo, forge: { clonedAs: "a/c" } } as Repo);
    expect(out.id).toBe("mac|a/b");
    expect(out.source).toBe("mac|launch");
    expect(out.forge?.clonedAs).toBe("mac|a/c");
    expect(back(out.id)).toEqual(["mac", "a/b"]);
    expect(repo.id).toBe("a/b");
  });
  test("a scan's repos and sources", () => {
    const scan = { root: "/x", repos: [repo], sources: [{ id: "launch", label: "x" }], scannedAt: 1, backend: { openers: false, sshHost: null } } as unknown as ScanResult;
    const out = qScan(q, scan);
    expect(out.repos[0]?.id).toBe("mac|a/b");
    expect(out.sources[0]?.id).toBe("mac|launch");
    expect(out.root).toBe("/x");
  });
  test("runs, flows, fleets, jobs, shells, kept shells, devices", () => {
    expect(qRun(q, run)).toMatchObject({ id: "mac|r1", repoId: "mac|a/b" });
    const f = qFlow(q, flow);
    expect(f).toMatchObject({ id: "mac|f1", repoId: "mac|a/b", fleetId: "mac|fl1" });
    expect(f.steps[0]?.runId).toBe("mac|r1");
    expect(f.steps[1]?.runId).toBeUndefined();
    const fl = qFleet(q, fleet);
    expect(fl.id).toBe("mac|fl1");
    expect(fl.repos).toEqual([{ repoId: "mac|a/b", flowId: "mac|f1" }, { repoId: "mac|c", skipped: "clean" }]);
    expect(qJob(q, job)).toMatchObject({ id: "mac|j1", repoId: "mac|a/b" });
    expect(qTerm(q, term)).toMatchObject({ id: `mac|${term.id}`, repoId: "mac|a/b" });
    expect(qKept(q, kept)).toMatchObject({ id: `mac|${kept.id}`, repoId: "mac|a/b" });
    expect(qDevice(q, device).id).toBe("mac|00ff00ff00ff00ff");
  });
  test("history keys and grep rows", () => {
    const h = { available: true, days: [], maxDay: 0, fetchedAt: 1, repos: { "a/b": {} as RepoHistory } } as HistoryOverview;
    const out = qHistory(q, h);
    expect(out.available && Object.keys(out.repos)).toEqual(["mac|a/b"]);
    const off: HistoryOverview = { available: false, reason: "x", fetchedAt: 1 };
    expect(qHistory(q, off)).toBe(off);
    expect(qGrep(q, { repo: "a/b", hits: [], truncated: false }).repo).toBe("mac|a/b");
  });
});

describe("qEvent", () => {
  test("every event that carries an id comes out qualified", () => {
    const cases: [ServerEvent, (e: ServerEvent) => string[]][] = [
      [{ type: "repo", repo }, (e) => (e.type === "repo" ? [e.repo.id] : [])],
      [{ type: "run", run }, (e) => (e.type === "run" ? [e.run.id, e.run.repoId] : [])],
      [{ type: "run-gone", id: "r1" }, (e) => (e.type === "run-gone" ? [e.id] : [])],
      [{ type: "flow", flow }, (e) => (e.type === "flow" ? [e.flow.id, e.flow.repoId] : [])],
      [{ type: "flow-gone", id: "f1" }, (e) => (e.type === "flow-gone" ? [e.id] : [])],
      [{ type: "fleet", fleet }, (e) => (e.type === "fleet" ? [e.fleet.id, ...e.fleet.repos.map((r) => r.repoId)] : [])],
      [{ type: "fleet-gone", id: "fl1" }, (e) => (e.type === "fleet-gone" ? [e.id] : [])],
      [{ type: "job", job }, (e) => (e.type === "job" ? [e.job.id, e.job.repoId] : [])],
      [{ type: "job-gone", id: "j1" }, (e) => (e.type === "job-gone" ? [e.id] : [])],
      [{ type: "builds", repoId: "a/b", what: "built", build: "local" }, (e) => (e.type === "builds" ? [e.repoId] : [])],
      [{ type: "terms", terms: [term] }, (e) => (e.type === "terms" ? e.terms.flatMap((t) => [t.id, t.repoId]) : [])],
      [{ type: "devices", devices: [device] }, (e) => (e.type === "devices" ? e.devices.map((d) => d.id) : [])],
      [{ type: "kept", kept: [kept] }, (e) => (e.type === "kept" ? e.kept.flatMap((k) => [k.id, k.repoId]) : [])],
    ];
    for (const [ev, ids] of cases) {
      const out = ids(qEvent(q, ev));
      expect(out.length).toBeGreaterThan(0);
      for (const id of out) expect(back(id)[0]).toBe("mac");
    }
  });
  test("a scan event qualifies its repos", () => {
    const scan = { root: "/x", repos: [repo], sources: [], scannedAt: 1, backend: { openers: false, sshHost: null } } as unknown as ScanResult;
    const out = qEvent(q, { type: "scan", result: scan });
    expect(out.type === "scan" && out.result.repos[0]?.id).toBe("mac|a/b");
  });
  test("events keyed by path or by name pass through", () => {
    for (const ev of [
      { type: "agents", agents: {} },
      { type: "launchers", launchers: {} },
      { type: "workspaces", workspaces: [] },
      { type: "helpers", helpers: [] },
      { type: "peers", seen: [] },
    ] as ServerEvent[]) {
      expect(qEvent(q, ev)).toBe(ev);
    }
  });
});

describe("mergeHistory", () => {
  const h = (days: number[]): RepoHistory => ({
    project: "p",
    sessions: 1,
    costUsd: 0,
    tokens: 0,
    commits: 0,
    first: null,
    last: null,
    days,
    daySessions: days,
  });
  const home: HistoryOverview = { available: true, days: ["2026-09-24", "2026-09-25", "2026-09-26"], maxDay: 5, fetchedAt: 1, repos: { a: h([1, 2, 3]) } };
  const mac: HistoryOverview = { available: true, days: ["2026-09-25", "2026-09-26", "2026-09-27"], maxDay: 9, fetchedAt: 2, repos: { "mac|a": h([7, 8, 9]) } };
  test("lines the others up on the first one's days", () => {
    const out = mergeHistory([home, mac]);
    expect(out?.available).toBe(true);
    if (!out?.available) return;
    expect(out.days).toEqual(home.days);
    expect(out.repos["a"]?.days).toEqual([1, 2, 3]);
    expect(out.repos["mac|a"]?.days).toEqual([0, 7, 8]);
    expect(out.repos["mac|a"]?.daySessions).toEqual([0, 7, 8]);
    expect(out.maxDay).toBe(9);
  });
  test("one overview is itself, none is null, unavailable ones step aside", () => {
    expect(mergeHistory([home])).toBe(home);
    expect(mergeHistory([])).toBeNull();
    const off: HistoryOverview = { available: false, reason: "x", fetchedAt: 1 };
    expect(mergeHistory([off])).toBe(off);
    expect(mergeHistory([off, mac])?.available).toBe(true);
  });
});

test("a task's repo and session ids are qualified", () => {
  const q = (id: string) => `mini|${id}`;
  const info: TaskInfo = { name: "dev", cmd: "x", repoId: "app", source: "detected", termId: "a".repeat(32), status: "idle", live: false, restarts: 0, viewers: [] };
  expect(qTask(q, info)).toMatchObject({ repoId: "mini|app", termId: `mini|${"a".repeat(32)}` });
  expect(qEvent(q, { type: "tasks", repoId: "app", tasks: [info] })).toMatchObject({ repoId: "mini|app", tasks: [{ repoId: "mini|app" }] });
});

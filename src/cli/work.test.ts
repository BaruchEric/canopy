import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import type { WorkItem } from "../core/work";
import { listLines, showLines, workCommand } from "./work";

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: "w-test2345",
  title: "Add a test",
  repos: ["dev-tools/canopy"],
  state: "review",
  from: { kind: "note" },
  runs: ["r1", "fix1"],
  branches: ["b1"],
  prs: [{ number: 7, url: "https://github.com/o/r/pull/7" }],
  events: [],
  notes: [
    { at: Date.UTC(2026, 9, 26, 10, 0), by: "canopy", text: "branch ready, lands on its own" },
    { at: Date.UTC(2026, 9, 26, 10, 5), by: "canopy", text: "PR #7 opened" },
  ],
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

test("listLines", () => {
  expect(listLines([item()])).toEqual(["w-test2345  review   dev-tools/canopy   Add a test  · canopy: PR #7 opened"]);
  expect(listLines([item({ notes: [], state: "open" })], "mini")).toEqual(["mini", "w-test2345  open     dev-tools/canopy   Add a test"]);
  expect(listLines([])).toEqual([]);
});

test("showLines", () => {
  expect(showLines(item())).toEqual([
    "w-test2345  Add a test",
    "state: review   repos: dev-tools/canopy   from: a note",
    "branches: b1   runs: r1, fix1   PRs: #7 https://github.com/o/r/pull/7   events: none",
    "notes:",
    "  2026-10-26 10:00  canopy  branch ready, lands on its own",
    "  2026-10-26 10:05  canopy  PR #7 opened",
  ]);
  expect(showLines(item({ notes: [], prs: [], runs: [], branches: [], from: { kind: "trigger", event: "e1" } })).slice(1)).toEqual([
    "state: review   repos: dev-tools/canopy   from: trigger event e1",
    "branches: none   runs: none   PRs: none   events: none",
    "notes:",
    "  (none yet)",
  ]);
});

test("workCommand sends notes and closes to the selected backend", async () => {
  const seen: { method: string; path: string; body?: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname + new URL(req.url).search;
      seen.push({ method: req.method, path, ...(req.method === "POST" ? { body: await req.json() } : {}) });
      return Response.json(item());
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => { lines.push(line); };
  const run = (argv: string[]) => workCommand([...argv, "--backend", base], { fail: (message) => { throw new Error(message); } });
  try {
    await run(["show", "w-test2345"]);
    expect(lines).toEqual(showLines(item()));
    lines.length = 0;

    await run(["note", "w-test2345", "check the run"]);
    expect(lines).toEqual(["noted on w-test2345"]);
    lines.length = 0;

    await run(["close", "w-test2345", "--dropped", "-m", "not needed"]);
    expect(lines).toEqual(["w-test2345 closed as dropped"]);
    expect(seen).toEqual([
      { method: "GET", path: "/api/work/one?id=w-test2345" },
      { method: "POST", path: "/api/work/note", body: { id: "w-test2345", text: "check the run" } },
      { method: "POST", path: "/api/work/close", body: { id: "w-test2345", state: "dropped", reason: "not needed" } },
    ]);
  } finally {
    console.log = log;
    server.stop(true);
  }
});

test("workCommand lists every backend with its filters", async () => {
  const secondItem = item({ id: "w-test2346", title: "Another item" });
  let peer: ReturnType<typeof Bun.serve>;
  peer = Bun.serve({ port: 0, fetch: () => Response.json({ items: [secondItem], archived: 0 }) });
  const peerBase = `http://127.0.0.1:${peer.port}`;
  const home = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/backends") return Response.json({ self: "home", backends: [{ name: "mini", tailnet: peerBase }] });
      return Response.json({ items: [item()], archived: 0 });
    },
  });
  const homeBase = `http://127.0.0.1:${home.port}`;
  const oldApi = process.env["CANOPY_API"];
  process.env["CANOPY_API"] = homeBase;
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    await workCommand(["list", "--repo", "dev-tools/canopy", "--state", "review"], { fail: (message) => { throw new Error(message); } });
    expect(lines).toEqual([
      "home",
      "w-test2345  review   dev-tools/canopy   Add a test  · canopy: PR #7 opened",
      "mini",
      "w-test2346  review   dev-tools/canopy   Another item  · canopy: PR #7 opened",
    ]);
  } finally {
    console.log = log;
    if (oldApi === undefined) delete process.env["CANOPY_API"];
    else process.env["CANOPY_API"] = oldApi;
    home.stop(true);
    peer.stop(true);
  }
});

test("note reads the work id from the current run branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canopy-work-cli-"));
  const previous = process.cwd();
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.json());
      return Response.json(item());
    },
  });
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    await exec(["git", "init", "-q", "-b", "main", dir]);
    await exec(["git", "-C", dir, "checkout", "-q", "-b", "run/w-test2345-the-task"]);
    process.chdir(dir);
    await workCommand(["note", "remember the setup", "--backend", `http://127.0.0.1:${server.port}`], { fail: (message) => { throw new Error(message); } });
    expect(bodies).toEqual([{ id: "w-test2345", text: "remember the setup" }]);
    expect(lines).toEqual(["noted on w-test2345"]);
  } finally {
    process.chdir(previous);
    console.log = log;
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

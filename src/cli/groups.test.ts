import { expect, test } from "bun:test";
import type { LandingInfo } from "../core/types";
import type { RunGroup } from "../core/group";
import { setHomeBase, setTokenFlag } from "./api";
import { main } from "./index";

function resetCliApiState(): void {
  setHomeBase(undefined);
  setTokenFlag(undefined);
}

const group: RunGroup = {
  id: "g-1234abcd",
  repoId: "app",
  repoPath: "/work/app",
  action: "ask",
  note: "add a file",
  expectedMembers: 1,
  members: [{ run: "run-1", origin: "origin-1", profile: null }],
  state: "working",
  autoLand: false,
  startedAt: 1,
};

const landing: LandingInfo = {
  runs: [{
    id: "origin-1",
    group: group.id,
    runId: "run-1",
    repoId: "app",
    repoPath: "/work/app",
    branch: "feature/add-a-file",
    target: "main",
    base: "abc123",
    dir: "/work/app/.worktrees/run-1",
    note: "add a file",
    verb: "ask",
    harness: "codex",
    state: "working",
    startedAt: 1,
  }],
  entries: [],
  orphans: [],
  groups: [group],
};

test("canopy groups dispatch lists each group with its member branch and state", async () => {
  resetCliApiState();
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.pathname}${url.search}`);
      return Response.json(landing);
    },
  });
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    await main(["groups", "app", "--backend", `http://127.0.0.1:${server.port}`]);
  } finally {
    resetCliApiState();
    console.log = oldLog;
    server.stop(true);
  }

  expect(seen).toEqual(["GET /api/landing"]);
  expect(lines).toEqual([
    "g-1234abcd  working  app",
    "  feature/add-a-file  working",
  ]);
});

test("canopy groups pick routes a foreign group ID to the backend that owns it", async () => {
  resetCliApiState();
  const homeCalls: string[] = [];
  const peerCalls: { path: string; body?: unknown }[] = [];
  const peer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      peerCalls.push({ path: `${url.pathname}${url.search}`, ...(body !== undefined ? { body } : {}) });
      if (url.pathname === "/api/groups") return Response.json([group]);
      return Response.json(group);
    },
  });
  const home = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      homeCalls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/backends") {
        return Response.json({ self: "mac", backends: [{ name: "mini", tailnet: `http://127.0.0.1:${peer.port}` }] });
      }
      return Response.json([]);
    },
  });
  const oldApi = process.env["CANOPY_API"];
  process.env["CANOPY_API"] = `http://127.0.0.1:${home.port}`;
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    await main(["groups", "pick", group.id, "run-1"]);
  } finally {
    resetCliApiState();
    console.log = oldLog;
    if (oldApi === undefined) delete process.env["CANOPY_API"];
    else process.env["CANOPY_API"] = oldApi;
    peer.stop(true);
    home.stop(true);
  }

  expect(homeCalls).toEqual(["GET /api/backends", "GET /api/groups"]);
  expect(peerCalls).toEqual([
    { path: "/api/groups" },
    { path: "/api/groups/pick", body: { group: group.id, run: "run-1" } },
  ]);
  expect(lines).toEqual(["picked run-1 in g-1234abcd on mini"]);
});

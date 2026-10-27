import { expect, test } from "bun:test";
import { main } from "./index";
import { dispatchRunCommand, parseRunArgs } from "./run";

test("parseRunArgs reads a grouped branch run and its flags", () => {
  expect(parseRunArgs(["app", "ask", "-m", "add a file", "--times", "3", "--auto-land", "--pr"])).toEqual({
    repo: "app",
    action: "ask",
    note: "add a file",
    times: 3,
    explicitTimes: true,
    autoLand: true,
    pr: true,
  });
});

test("parseRunArgs keeps a single branch run as the default and rejects invalid times", () => {
  expect(parseRunArgs(["app", "ask"])).toEqual({
    repo: "app",
    action: "ask",
    note: "",
    times: 1,
    explicitTimes: false,
    autoLand: false,
    pr: false,
  });
  expect(parseRunArgs(["app", "ask", "--times", "4"])).toBe("--times must be 1, 2, or 3");
  expect(parseRunArgs(["app", "ask", "--times"])).toBe("--times needs a value");
});

test("run dispatch hands transcript subcommands to the supplied handler", async () => {
  const called: string[][] = [];
  const transcript = async (args: string[]) => {
    called.push(args);
  };
  const fail = (message: string): never => {
    throw new Error(message);
  };

  for (const args of [["show", "run-1"], ["export", "run-2"], ["prune"], []]) {
    await dispatchRunCommand(args, { fail, transcripts: transcript });
  }

  expect(called).toEqual([["show", "run-1"], ["export", "run-2"], ["prune"], []]);
});

test("canopy run dispatch sends the group body to the selected backend", async () => {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: `${url.pathname}${url.search}`, ...(body !== undefined ? { body } : {}) });
      return Response.json({
        id: "g-1234abcd",
        repoId: "app",
        repoPath: "/work/app",
        action: "ask",
        note: "add a file",
        expectedMembers: 3,
        members: [],
        state: "working",
        autoLand: true,
        startedAt: 1,
      }, { status: 201 });
    },
  });
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    await main(["run", "app", "ask", "-m", "add a file", "--times", "3", "--auto-land", "--pr", "--backend", `http://127.0.0.1:${server.port}`]);
  } finally {
    console.log = oldLog;
    server.stop(true);
  }

  expect(requests).toEqual([{
    method: "POST",
    path: "/api/repos/run?id=app",
    body: { action: "ask", note: "add a file", branch: true, times: 3, autoLand: true, pr: true },
  }]);
  expect(lines).toEqual(["g-1234abcd working"]);
});

test("canopy run without --times keeps the single branch-run request", async () => {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ method: request.method, path: `${url.pathname}${url.search}`, ...(body !== undefined ? { body } : {}) });
      return Response.json({ id: "run-1", status: "working" }, { status: 201 });
    },
  });
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    await main(["run", "app", "ask", "--backend", `http://127.0.0.1:${server.port}`]);
  } finally {
    console.log = oldLog;
    server.stop(true);
  }

  expect(requests).toEqual([{
    method: "POST",
    path: "/api/repos/run?id=app",
    body: { action: "ask", note: "", branch: true },
  }]);
  expect(lines).toEqual(["run-1 working"]);
});

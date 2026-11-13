import { expect, test } from "bun:test";
import { setHomeBase, setTokenFlag } from "./api";
import { main } from "./index";
import { dispatchRunCommand, parseChildArgs, parseRunArgs, RUNS_USAGE } from "./run";

function resetCliApiState(): void {
  setHomeBase(undefined);
  setTokenFlag(undefined);
}

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

test("parseRunArgs reads --priority and refuses a word it does not know (FR-036)", () => {
  expect(parseRunArgs(["app", "ask", "--priority", "low"])).toMatchObject({ repo: "app", action: "ask", priority: "low" });
  expect(parseRunArgs(["app", "ask", "--priority", "urgent"])).toBe("--priority must be interactive, normal or low");
  expect(parseRunArgs(["app", "ask", "--priority"])).toBe("--priority must be interactive, normal or low");
  expect(parseRunArgs(["app", "ask"])).not.toHaveProperty("priority");
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
  resetCliApiState();
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
    resetCliApiState();
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
  resetCliApiState();
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
    resetCliApiState();
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

test("parseRunArgs reads a profile per member, an empty name being the job route", () => {
  expect(parseRunArgs(["app", "ask", "--times", "3", "--profiles", "fast,,deep", "--reviewers", "2"])).toMatchObject({ profiles: ["fast", null, "deep"], reviewers: 2 });
  expect(parseRunArgs(["app", "ask", "--times", "3", "--profiles", "fast"])).toMatchObject({ profiles: ["fast"] });
});

test("parseRunArgs keeps --reviewers 1 off the body", () => {
  const parsed = parseRunArgs(["app", "ask", "--times", "2", "--reviewers", "1"]);
  if (typeof parsed === "string") throw new Error(parsed);
  expect(parsed.reviewers).toBeUndefined();
});

test("parseRunArgs refuses group flags without a group, and bad values", () => {
  expect(parseRunArgs(["app", "ask", "--profiles", "fast"])).toBe("--profiles requires --times 2 or 3");
  expect(parseRunArgs(["app", "ask", "--reviewers", "2"])).toBe("--reviewers requires --times 2 or 3");
  expect(parseRunArgs(["app", "ask", "--times", "2", "--reviewers", "3"])).toBe("--reviewers must be 1 or 2");
  expect(parseRunArgs(["app", "ask", "--times", "2", "--profiles"])).toBe("--profiles needs a list of names");
  expect(parseRunArgs(["app", "ask", "--times", "2", "--profiles", "a,b,c"])).toBe("--profiles names 3 members; --times says 2");
});

test("run dispatch skips the new flags' values when it looks for a subcommand", async () => {
  const seen: string[][] = [];
  const fail = (message: string): never => { throw new Error(message); };
  await dispatchRunCommand(["--profiles", "show", "--reviewers", "2"], { fail, transcripts: (argv) => { seen.push(argv); } });
  expect(seen).toEqual([["--profiles", "show", "--reviewers", "2"]]);
});

test("canopy run sends each member's profile and the reviewers in the body", async () => {
  resetCliApiState();
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(await request.json());
      return Response.json({ id: "g-1234abcd", repoId: "app", repoPath: "/work/app", action: "ask", note: "n", expectedMembers: 2, members: [], state: "working", autoLand: false, startedAt: 1 }, { status: 201 });
    },
  });
  const oldLog = console.log;
  console.log = () => {};
  try {
    await main(["run", "app", "ask", "-m", "n", "--times", "2", "--profiles", ",fast", "--reviewers", "2", "--backend", `http://127.0.0.1:${server.port}`]);
  } finally {
    resetCliApiState();
    console.log = oldLog;
    server.stop(true);
  }
  expect(bodies).toEqual([{ action: "ask", note: "n", branch: true, times: 2, profiles: [null, "fast"], reviewers: 2 }]);
});

test("parseRunArgs reads --tools and --no-tools, and leaves the settings alone without either (FR-038)", () => {
  expect(parseRunArgs(["app", "ask", "--tools"])).toMatchObject({ canopyTools: true });
  expect(parseRunArgs(["app", "ask", "--no-tools"])).toMatchObject({ canopyTools: false });
  expect("canopyTools" in (parseRunArgs(["app", "ask"]) as object)).toBe(false);
  expect(parseRunArgs(["app", "ask", "--tools", "--no-tools"])).toBe("use either --tools or --no-tools");
});

test("parseChildArgs wants a repo, a note and a parent", () => {
  expect(parseChildArgs(["child", "app", "--note", "a part", "--parent", "abcd1234"])).toEqual({ repo: "app", note: "a part", parent: "abcd1234" });
  expect(parseChildArgs(["child", "app", "--note", "x", "--parent", "p", "--action", "propose", "--on", "mini"])).toMatchObject({ action: "propose", on: "mini" });
  for (const bad of [[], ["child"], ["child", "app"], ["child", "app", "--note", "x"], ["child", "app", "--note", " ", "--parent", "p"], ["other", "app", "--note", "x", "--parent", "p"]]) {
    expect(parseChildArgs(bad)).toBe(RUNS_USAGE);
  }
});

test("--loadout names the run's loadout", () => {
  expect(parseRunArgs(["canopy", "ask", "--loadout", "docs"])).toMatchObject({ loadout: "docs" });
});

test.each([
  [["canopy", "ask", "--loadout"], "--loadout needs a name"],
  [["canopy", "ask", "--loadout", "docs", "--times", "2"], "--loadout starts one run; use --profiles for a group"],
])("%j is refused", (argv, why) => expect(parseRunArgs(argv)).toBe(why));

/** a backend that answers GET /api/loadouts with `loadouts` (a status, or a
 *  list) and a start with `run`, keeping each request */
async function loadoutBackend(loadouts: number | { loadouts: { name: string }[] }, run: Record<string, unknown>, argv: string[]) {
  resetCliApiState();
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/loadouts") return typeof loadouts === "number" ? Response.json({ error: "not found" }, { status: loadouts }) : Response.json({ base: [], errors: [], ...loadouts });
      return Response.json(run, { status: 201 });
    },
  });
  const backend = `http://127.0.0.1:${server.port}`;
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (line: string) => { lines.push(line); };
  const fail = (message: string): never => { throw new Error(message); };
  try {
    const failed = await dispatchRunCommand([...argv, "--backend", backend], { fail }).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
    return { requests, lines, failed, backend };
  } finally {
    resetCliApiState();
    console.log = oldLog;
    server.stop(true);
  }
}

test("--loadout against a backend that predates loadouts refuses before anything starts", async () => {
  const got = await loadoutBackend(404, { id: "run-1", status: "working" }, ["app", "ask", "--loadout", "docs"]);
  expect(got.failed).toBe(`${got.backend} predates loadouts; redeploy it`);
  expect(got.requests).toEqual(["GET /api/loadouts"]);
});

test("--loadout fails loudly when the started run came back without its equip", async () => {
  const got = await loadoutBackend({ loadouts: [{ name: "docs" }] }, { id: "run-1", status: "working" }, ["app", "ask", "--loadout", "docs"]);
  expect(got.requests).toEqual(["GET /api/loadouts", "POST /api/repos/run"]);
  expect(got.failed).toBe(`run run-1 started on ${got.backend} without loadout docs; stop it and redeploy ${got.backend}`);
  expect(got.lines).toEqual([]);
});

test("--loadout prints the run when it came back with its equip", async () => {
  const equip = { loadout: "docs", model: "haiku", effort: "low", skills: [], mcp: [], off: 3 };
  const got = await loadoutBackend({ loadouts: [{ name: "docs" }] }, { id: "run-1", status: "working", equip }, ["app", "ask", "--loadout", "docs"]);
  expect(got.failed).toBeNull();
  expect(got.lines).toEqual(["run-1 working"]);
});

test("a run without --loadout never asks for the loadouts", async () => {
  const got = await loadoutBackend(404, { id: "run-1", status: "working" }, ["app", "ask"]);
  expect(got.failed).toBeNull();
  expect(got.requests).toEqual(["POST /api/repos/run"]);
});

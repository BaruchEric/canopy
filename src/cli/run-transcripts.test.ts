import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeptRunHead, Run } from "../core/types";
import { askText } from "./health";
import { RUN_USAGE, runCommand } from "./run";
import { keptLines, liveLines, replayLines, showLines } from "./run-transcripts";

const now = Date.UTC(2026, 9, 26, 12);
const H = 3_600_000;
const head = (over: Partial<KeptRunHead> = {}): KeptRunHead => ({
  id: "ab12cd34",
  repo: "dev-tools/canopy",
  action: "build",
  verb: "Build",
  harness: "claude",
  status: "done",
  started: now - 3 * H,
  ended: now - 2 * H,
  cost: 0.42,
  ...over,
});

const run: Run = {
  id: "ab12cd34",
  repoId: "dev-tools/canopy",
  action: "build",
  verb: "Build",
  progress: "",
  expectsChange: true,
  chat: false,
  harness: "claude",
  note: "",
  status: "done",
  startedAt: now - 3 * H,
  endedAt: now - 2 * H,
  steps: [
    { id: "1", at: Date.UTC(2026, 9, 26, 9, 0, 1), kind: "text", text: "Looking." },
    { id: "2", at: Date.UTC(2026, 9, 26, 9, 0, 2), kind: "tool", tool: { name: "Bash", title: "git status", status: "ok" } },
    { id: "3", at: Date.UTC(2026, 9, 26, 9, 0, 3), kind: "text", text: "Found.", parent: "2" },
  ],
  prompt: null,
  result: { text: "ok", costUsd: 0.42, durationMs: H, turns: 1 },
  kept: true,
};

const fail = (message: string): never => { throw new Error(message); };

test("replayLines shows the head, where the steps came from, and the replay's steps", () => {
  const steps = [
    { id: "w1", at: Date.UTC(2026, 9, 26, 9, 0, 1), kind: "tool" as const, tool: { name: "Bash", title: "git push", status: "ok" as const } },
    { id: "ask1", at: Date.UTC(2026, 9, 26, 9, 0, 2), kind: "note" as const, text: "asked: git push" },
  ];
  const lines = replayLines({ ...run, steps: [] }, { source: "wire", steps, asks: ["ask1"], cut: true });
  expect(lines.slice(0, 2)).toEqual(["Build in dev-tools/canopy (kept)", "run: ab12cd34"]);
  expect(lines.slice(-4)).toEqual([
    "steps: rebuilt from the wire, without canopy's own notes",
    "the wire was cut at its size limit, so the steps stop short",
    "  09:00:01  tool  Bash: git push (ok)",
    "  09:00:02  note  asked: git push",
  ]);
  expect(replayLines(run, { source: "record", steps: run.steps, asks: [], cut: false })).toEqual([
    ...showLines(run).slice(0, -run.steps.length), "steps: the record's, with the prompts its wire shows", ...showLines(run).slice(-run.steps.length),
  ]);
});

test("keptLines sorts newest first and formats the age, repo, status, and cost", () => {
  expect(keptLines([head({ id: "older", ended: now - 50 * H, cost: null, status: "failed" }), head()], now)).toEqual([
    "ab12cd34  2h   dev-tools/canopy          Build  done    $0.42",
    "older     2d   dev-tools/canopy          Build  failed  -",
  ]);
});

test("showLines prints the run head and indents a subagent's timeline step", () => {
  const lines = showLines(run);
  expect(lines.slice(0, 2)).toEqual(["Build in dev-tools/canopy (kept)", "run: ab12cd34"]);
  expect(lines.slice(-3)).toEqual([
    "  09:00:01  text  Looking.",
    "  09:00:02  tool  Bash: git status (ok)",
    "    09:00:03  text  Found.",
  ]);
});

test("askText retries a sign-in gate and returns the next backend's text unchanged", async () => {
  const gate = Bun.serve({ port: 0, fetch: () => Response.json({ error: "sign in" }, { status: 401 }) });
  const exportText = "# Build\n\nredacted: <redacted:CANOPY_TOKEN>\n";
  let fallbackCalls = 0;
  const backend = Bun.serve({
    port: 0,
    fetch: () => {
      fallbackCalls += 1;
      return new Response(exportText, { headers: { "content-type": "text/markdown" } });
    },
  });
  try {
    expect(await askText({ name: "home", urls: [`http://127.0.0.1:${gate.port}`, `http://127.0.0.1:${backend.port}`] }, "/export")).toBe(exportText);
    expect(fallbackCalls).toBe(1);
  } finally {
    gate.stop(true);
    backend.stop(true);
  }
});

test("askText keeps Canopy's JSON need refusal on 401 and 403", async () => {
  for (const status of [401, 403]) {
    let fallbackCalls = 0;
    const refused = Bun.serve({ port: 0, fetch: () => Response.json({ need: "run" }, { status }) });
    const fallback = Bun.serve({ port: 0, fetch: () => { fallbackCalls += 1; return new Response("unexpected"); } });
    try {
      await expect(askText({ name: "home", urls: [`http://127.0.0.1:${refused.port}`, `http://127.0.0.1:${fallback.port}`] }, "/export")).rejects.toThrow("home refused: it needs the run right");
      expect(fallbackCalls).toBe(0);
    } finally {
      refused.stop(true);
      fallback.stop(true);
    }
  }
});

test("askText surfaces a text error body", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("transcript is unavailable", { status: 503 }) });
  try {
    await expect(askText({ name: "home", urls: [`http://127.0.0.1:${server.port}`] }, "/export")).rejects.toThrow("transcript is unavailable");
  } finally {
    server.stop(true);
  }
});

test("runCommand lists, shows, exports verbatim, writes an export, and prunes", async () => {
  const exportText = "# Build in canopy\n\nsecret <redacted:CANOPY_TOKEN>\n";
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}${url.search}`;
      requests.push(route);
      if (route === "GET /api/runs?kept=1") return Response.json([head()]);
      if (route === "GET /api/runs/ab12cd34") return Response.json(run);
      if (route === "GET /api/runs/ab12cd34/replay") return Response.json({ source: "record", steps: run.steps, asks: [], cut: false });
      if (route === "GET /api/runs/ab12cd34/export") return new Response(exportText, { headers: { "content-type": "text/markdown" } });
      if (route === "POST /api/runs/prune") return Response.json({ removed: ["old1", "old2"], kept: 1 });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    },
  });
  const logs: string[] = [];
  const oldLog = console.log;
  const dir = await mkdtemp(join(tmpdir(), "canopy-run-cli-"));
  const out = join(dir, "run.md");
  console.log = (line: string) => { logs.push(line); };
  try {
    await runCommand(["--backend", `http://127.0.0.1:${server.port}`], { fail });
    await runCommand(["show", "ab12cd34", "--backend", `http://127.0.0.1:${server.port}`], { fail });
    const shown = logs.length;
    await runCommand(["show", "ab12cd34", "--wire", "--backend", `http://127.0.0.1:${server.port}`], { fail });
    expect(logs.slice(shown)).toContain("steps: the record's, with the prompts its wire shows");
    logs.splice(shown);
    const writes: string[] = [];
    const oldWrite = process.stdout.write;
    Object.defineProperty(process.stdout, "write", {
      configurable: true,
      writable: true,
      value: (chunk: string | Uint8Array) => { writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); return true; },
    });
    try {
      await runCommand(["export", "ab12cd34", "--backend", `http://127.0.0.1:${server.port}`], { fail });
    } finally {
      Object.defineProperty(process.stdout, "write", { configurable: true, writable: true, value: oldWrite });
    }
    await runCommand(["export", "ab12cd34", "--out", out, "--backend", `http://127.0.0.1:${server.port}`], { fail });
    await runCommand(["prune", "--backend", `http://127.0.0.1:${server.port}`], { fail });

    expect(logs[0]).toBe(keptLines([head()])[0]);
    expect(logs.slice(1, 3)).toEqual(["Build in dev-tools/canopy (kept)", "run: ab12cd34"]);
    expect(writes).toEqual([exportText]);
    expect(await readFile(out, "utf8")).toBe(exportText);
    expect(logs.slice(-2)).toEqual([`wrote ${out}`, "removed 2 transcripts, 1 kept"]);
    expect(requests).toEqual([
      "GET /api/runs?kept=1",
      "GET /api/runs/ab12cd34",
      "GET /api/runs/ab12cd34",
      "GET /api/runs/ab12cd34/replay",
      "GET /api/runs/ab12cd34/export",
      "GET /api/runs/ab12cd34/export",
      "POST /api/runs/prune",
    ]);
  } finally {
    console.log = oldLog;
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCommand forks a run at a step, with a profile and a note, and says how it forked (FR-043 plan 3)", async () => {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/api/runs/fork") return Response.json({ error: "unexpected route" }, { status: 404 });
      const body: unknown = await request.json();
      bodies.push(body);
      const at = typeof body === "object" && body !== null && "step" in body && typeof body.step === "number" ? body.step : 3;
      return Response.json({ ...run, id: "ef56ab78", status: "working", kept: undefined, forkOf: { run: "ab12cd34", ...(at < 3 ? { step: String(at) } : {}), at, how: at < 3 ? "cut" : "whole" } }, { status: 201 });
    },
  });
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (line: string) => { logs.push(line); };
  try {
    const backend = ["--backend", `http://127.0.0.1:${server.port}`];
    await runCommand(["fork", "ab12cd34", "--at", "2", "--profile", "deep", "-m", "try grep", ...backend], { fail });
    await runCommand(["fork", "ab12cd34", ...backend], { fail });
    expect(bodies).toEqual([{ run: "ab12cd34", step: 2, profile: "deep", note: "try grep" }, { run: "ab12cd34" }]);
    expect(logs).toEqual([
      "ef56ab78 working",
      "forked from run ab12cd34 at step 2, the transcript cut there and resumed",
      "ef56ab78 working",
      "forked from run ab12cd34 at its end (3 steps), the whole session resumed, the cut said in words",
    ]);
    await expect(runCommand(["fork", "ab12cd34", "--at", "zero", ...backend], { fail })).rejects.toThrow("--at needs a step's number");
    await expect(runCommand(["fork", "ab12cd34", "--profile", ...backend], { fail })).rejects.toThrow("--profile needs");
    await expect(runCommand(["fork", "ab12cd34", "extra", ...backend], { fail })).rejects.toThrow(RUN_USAGE);
    await expect(runCommand(["fork", "x/y", ...backend], { fail })).rejects.toThrow("invalid run id");
    await expect(runCommand(["fork"], { fail })).rejects.toThrow(RUN_USAGE);
    expect(bodies).toHaveLength(2);
  } finally {
    console.log = oldLog;
    server.stop(true);
  }
});

test("runCommand says when there are no kept runs", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json([]) });
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (line: string) => { logs.push(line); };
  try {
    await runCommand(["--backend", `http://127.0.0.1:${server.port}`], { fail });
    expect(logs).toEqual(["no kept runs"]);
  } finally {
    console.log = oldLog;
    server.stop(true);
  }
});

test("runCommand uses the shared usage for an incomplete transcript form", async () => {
  await expect(runCommand(["show"], { fail })).rejects.toThrow(RUN_USAGE);
});


test("transcript IDs fail locally before any HTTP read", async () => {
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return Response.json({}); } });
  try {
    for (const sub of ["show", "export"]) {
      for (const id of [".", "..", "x/y", "x?query", "a".repeat(65)]) {
        await expect(runCommand([sub, id, "--backend", `http://127.0.0.1:${server.port}`], { fail })).rejects.toThrow("invalid run id");
      }
    }
    expect(requests).toBe(0);
  } finally { server.stop(true); }
});


test("missing or flag-like output filenames fail locally before any HTTP read", async () => {
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return new Response("export"); } });
  try {
    for (const filename of [undefined, "", "--bad"]) {
      await expect(runCommand(["export", "ab12cd34", "--backend", `http://127.0.0.1:${server.port}`, "--out", ...(filename === undefined ? [] : [filename])], { fail })).rejects.toThrow("--out needs a file");
    }
    expect(requests).toBe(0);
  } finally { server.stop(true); }
});

test("runCommand says words into a live run and interrupts its turn, the server's refusal its own (FR-066)", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body: unknown = await request.json();
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/api/runs/interrupt" && typeof body === "object" && body !== null && !("text" in body)) {
        return Response.json({ error: "a job stops its turn only for a message to go on with; stop ends the run" }, { status: 409 });
      }
      if (url.pathname === "/api/runs/say" || url.pathname === "/api/runs/interrupt") return Response.json({ ...run, kept: undefined, status: "working" });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    },
  });
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (line: string) => { logs.push(line); };
  try {
    const backend = ["--backend", `http://127.0.0.1:${server.port}`];
    await runCommand(["say", "ab12cd34", "use", "bun", "here", ...backend], { fail });
    await runCommand(["interrupt", "ab12cd34", "do", "this", "instead", ...backend], { fail });
    await expect(runCommand(["interrupt", "ab12cd34", ...backend], { fail })).rejects.toThrow("a job stops its turn only for a message");
    expect(calls).toEqual([
      { path: "/api/runs/say", body: { id: "ab12cd34", text: "use bun here" } },
      { path: "/api/runs/interrupt", body: { id: "ab12cd34", text: "do this instead" } },
      { path: "/api/runs/interrupt", body: { id: "ab12cd34" } },
    ]);
    expect(logs).toEqual(["ab12cd34 working", "ab12cd34 working"]);
    await expect(runCommand(["say", "ab12cd34", ...backend], { fail })).rejects.toThrow("needs the words");
    await expect(runCommand(["say", "x/y", "hi", ...backend], { fail })).rejects.toThrow("invalid run id");
    expect(calls).toHaveLength(3);
  } finally {
    console.log = oldLog;
    server.stop(true);
  }
});

test("liveLines lists the runs still going, oldest first, each with its name (FR-073)", () => {
  const live = (over: Partial<Run>): Run => ({ ...run, kept: undefined, endedAt: undefined, result: undefined, steps: [], status: "working", ...over }) as Run;
  expect(liveLines([
    live({ id: "22222222", status: "idle", chat: true, verb: "chat", name: "peer sync", startedAt: now - 2 * H }),
    live({ id: "11111111", verb: "ask", note: "look at the build\nand more", startedAt: now - 5 * H }),
    live({ id: "33333333", verb: "propose", name: "top bar", startedAt: now - H, branch: { name: "run/top-bar", target: "main", base: "b", dir: "/w", origin: "o", state: "working" } }),
    live({ id: "44444444", status: "done" }),
    live({ id: "55555555", verb: "chat", chat: true, status: "idle", startedAt: now }),
  ], now)).toEqual([
    "11111111  5h   dev-tools/canopy          working  ask  look at the build",
    "22222222  2h   dev-tools/canopy          idle     chat  peer sync",
    "33333333  1h   dev-tools/canopy          working  propose on run/top-bar  top bar",
    "55555555  0m   dev-tools/canopy          idle     chat",
  ]);
});

test("a kept run's line and head carry its name", () => {
  expect(keptLines([head({ name: "peer sync" })], now)[0]?.endsWith("$0.42  peer sync")).toBe(true);
  expect(showLines({ ...run, name: "peer sync" }).slice(0, 3)).toEqual(["Build in dev-tools/canopy (kept)", "run: ab12cd34", "name: peer sync"]);
});

test("runCommand lists, names and stops live runs (FR-073)", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const going = { ...run, kept: undefined, endedAt: undefined, status: "working", name: "slow build" };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/runs") return Response.json([going, { ...going, id: "ffffffff", status: "done" }]);
      const body = (await request.json()) as { id?: string; name?: string };
      calls.push({ path: url.pathname, body });
      // "eeeeeeee" stands for a backend from before run names: the route is not there
      if (url.pathname === "/api/runs/name" && body.id === "eeeeeeee") return Response.json({ error: "not found" }, { status: 404 });
      if (url.pathname === "/api/runs/name") return body.id === "00000000" ? Response.json({ error: "no such run" }, { status: 404 }) : Response.json({ ...going, name: body.name });
      if (url.pathname === "/api/runs/stop") return Response.json({ ...going, status: "stopped" });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    },
  });
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (line: string) => { logs.push(line); };
  try {
    const backend = ["--backend", `http://127.0.0.1:${server.port}`];
    await runCommand(["ls", ...backend], { fail });
    expect(logs).toEqual(liveLines([going as Run]));
    expect(logs[0]?.endsWith("Build  slow build")).toBe(true);
    await runCommand(["name", "ab12cd34", "the", "landing", "queue", ...backend], { fail });
    await runCommand(["stop", "ab12cd34", ...backend], { fail });
    expect(calls).toEqual([
      { path: "/api/runs/name", body: { id: "ab12cd34", name: "the landing queue" } },
      { path: "/api/runs/stop", body: { id: "ab12cd34" } },
    ]);
    expect(logs.slice(1)).toEqual(["ab12cd34 the landing queue", "ab12cd34 stopped"]);
    await expect(runCommand(["name", "00000000", "x", ...backend], { fail })).rejects.toThrow("no such run");
    await expect(runCommand(["name", "eeeeeeee", "x", ...backend], { fail })).rejects.toThrow("runs a canopy from before run names; deploy the current one");
    await expect(runCommand(["name", "ab12cd34", ...backend], { fail })).rejects.toThrow("needs the name");
    await expect(runCommand(["name", "x/y", "hi", ...backend], { fail })).rejects.toThrow("invalid run id");
    await expect(runCommand(["stop", "ab12cd34", "extra", ...backend], { fail })).rejects.toThrow(RUN_USAGE);
    await expect(runCommand(["ls", "extra", ...backend], { fail })).rejects.toThrow(RUN_USAGE);
  } finally {
    console.log = oldLog;
    server.stop(true);
  }
});

test("runCommand asks a side question beside a run and sets its model (FR-077)", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const side = { ...run, id: "5ide0001", kept: undefined, endedAt: undefined, action: "chat", verb: "chat", chat: true, status: "working", sideOf: { run: "ab12cd34", title: "slow build" }, agentSettings: { harness: "claude", model: "default", effort: "default" } };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = (await request.json()) as { id?: string; model?: string };
      calls.push({ path: url.pathname, body });
      // "eeeeeeee" stands for a backend from before side questions: the route is not there
      if (body.id === "eeeeeeee") return Response.json({ error: "not found" }, { status: 404 });
      if (url.pathname === "/api/runs/side") return body.id === "00000000" ? Response.json({ error: "the run has no session to fork yet: ask once it has begun" }, { status: 409 }) : Response.json(side, { status: 201 });
      if (url.pathname === "/api/runs/model") return Response.json({ ...side, agentSettings: { ...side.agentSettings, model: body.model } });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    },
  });
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (line: string) => { logs.push(line); };
  try {
    const backend = ["--backend", `http://127.0.0.1:${server.port}`];
    await runCommand(["side", "ab12cd34", "what", "does", "retryBackoff", "default", "to?", ...backend], { fail });
    await runCommand(["side", "ab12cd34", "and the port?", "--model", "haiku", ...backend], { fail });
    // the flag may sit among the words
    await runCommand(["side", "ab12cd34", "--model", "haiku", "and", "the", "host?", ...backend], { fail });
    await runCommand(["model", "5ide0001", "sonnet", ...backend], { fail });
    expect(calls).toEqual([
      { path: "/api/runs/side", body: { id: "ab12cd34", text: "what does retryBackoff default to?" } },
      { path: "/api/runs/side", body: { id: "ab12cd34", text: "and the port?", model: "haiku" } },
      { path: "/api/runs/side", body: { id: "ab12cd34", text: "and the host?", model: "haiku" } },
      { path: "/api/runs/model", body: { id: "5ide0001", model: "sonnet" } },
    ]);
    expect(logs.slice(0, 2)).toEqual([
      "5ide0001 working",
      "a side question beside run ab12cd34, which works on; read it with canopy run show 5ide0001, go on with canopy run say 5ide0001 <words…>",
    ]);
    expect(logs.at(-1)).toBe("5ide0001 sonnet");
    await expect(runCommand(["side", "00000000", "hi", ...backend], { fail })).rejects.toThrow("no session to fork yet");
    await expect(runCommand(["side", "eeeeeeee", "hi", ...backend], { fail })).rejects.toThrow("runs a canopy from before side questions; deploy the current one");
    await expect(runCommand(["model", "eeeeeeee", "sonnet", ...backend], { fail })).rejects.toThrow("runs a canopy from before side questions");
    await expect(runCommand(["side", "ab12cd34", ...backend], { fail })).rejects.toThrow("needs the question");
    await expect(runCommand(["side", "x/y", "hi", ...backend], { fail })).rejects.toThrow("invalid run id");
    await expect(runCommand(["side", "ab12cd34", "hi", "--model", ...backend], { fail })).rejects.toThrow("--model needs a model's name");
    await expect(runCommand(["model", "5ide0001", ...backend], { fail })).rejects.toThrow(RUN_USAGE);
    await expect(runCommand(["model", "5ide0001", "sonnet", "extra", ...backend], { fail })).rejects.toThrow(RUN_USAGE);
    expect(calls).toHaveLength(7);
  } finally {
    console.log = oldLog;
    server.stop(true);
  }
});

test("a side question's lines say which run it sits beside", () => {
  const side: Run = { ...run, id: "5ide0001", action: "chat", verb: "chat", chat: true, status: "idle", name: "retry default", startedAt: now - H, sideOf: { run: "ab12cd34", title: "slow build" } };
  const { kept: _kept, endedAt: _ended, result: _result, ...going } = side;
  expect(liveLines([going], now)).toEqual(["5ide0001  1h   dev-tools/canopy          idle     chat beside ab12cd34  retry default"]);
  expect(showLines(side).slice(0, 4)).toEqual(["chat in dev-tools/canopy (kept)", "run: 5ide0001", "name: retry default", "side question of: ab12cd34 (slow build)"]);
});

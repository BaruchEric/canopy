import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeptRunHead, Run } from "../core/types";
import { askText } from "./health";
import { RUN_USAGE, runCommand } from "./run";
import { keptLines, showLines } from "./run-transcripts";

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

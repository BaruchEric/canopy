import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveAgent } from "../core/driver";
import { DEFAULT_AGENT, type Harness } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let server: Awaited<ReturnType<typeof startServer>>;
const seen: { harness: Harness; agent: DriveAgent }[] = [];
const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", body: JSON.stringify(body) });
const chosen = { ...DEFAULT_AGENT, harness: "codex", model: "gpt-test", effort: "high", provider: "work" };

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-scopes-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  const repo = join(root, "app");
  const workflows = join(repo, ".canopy", "workflows");
  await mkdir(workflows, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", repo]);
  await Bun.write(join(workflows, "route-check.md"), "---\nblurb: Check routing.\n---\n\n## Work\n\nDo the work.\n");
  await Bun.write(join(workflows, "step-check.md"), "---\nblurb: Check explicit routing.\n---\n\n## Work\nagent: default\n\nDo the work.\n");
  server = await startServer({
    root, port: 0, chan: null, harnesses: ["claude", "codex"],
    // Replace only the paid agent process. HTTP, config, resolution, runner
    // and flow engine all run normally.
    runner: { driver: (harness) => ({
      harness, label: "test agent", check: () => null,
      start(ctx) {
        seen.push({ harness, agent: ctx.agent });
        queueMicrotask(() => {
          ctx.result({
            text: "done", durationMs: 1, turns: 1,
            model: `${harness}-reported-model`, provider: harness === "codex" ? "reported-work" : "anthropic",
            tokens: { input: 100, cachedInput: 20, output: 50, reasoning: 10, total: 150 },
            ...(harness === "claude" ? { costUsd: 0.02 } : {}),
          }, null);
          ctx.exited({ code: 0, stderr: "" });
        });
      },
      say() {}, stop() {},
    }) },
  });
});

afterAll(async () => {
  await server.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

async function settled(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const runs: unknown = await (await fetch(`http://127.0.0.1:${server.port}/api/runs`)).json();
    const flows: unknown = await (await fetch(`http://127.0.0.1:${server.port}/api/flows`)).json();
    const finished = (entry: unknown) => typeof entry === "object" && entry !== null && "status" in entry && (entry.status === "done" || entry.status === "failed" || entry.status === "stopped");
    if (Array.isArray(runs) && runs.every(finished) && Array.isArray(flows) && flows.every(finished)) return;
    await Bun.sleep(10);
  }
  throw new Error("runs did not settle");
}

test("a task's saved route reaches the actual runner with model, effort and provider", async () => {
  expect((await post("/api/agents/scope", { kind: "task", name: "ask", pick: chosen })).status).toBe(200);
  const response = await post("/api/repos/run?id=app", { action: "ask", note: "check", branch: false });
  expect(response.status).toBe(201);
  const run: unknown = await response.json();
  expect(run).toMatchObject({ agentSettings: { harness: "codex", model: "gpt-test", provider: "work", effort: "high" } });
  if (typeof run !== "object" || run === null || !("id" in run) || typeof run.id !== "string") throw new Error("missing run ID");
  expect(seen.at(-1)).toMatchObject({ harness: "codex", agent: { model: "gpt-test", effort: "high", provider: "work" } });
  await settled();
  // Later settings edits must not change the run's accounting attribution.
  await post("/api/agents/scope", { kind: "task", name: "ask", pick: null });
  for (let i = 0; i < 100; i++) {
    const report: unknown = await (await fetch(`http://127.0.0.1:${server.port}/api/costs?since=0`)).json();
    if (typeof report === "object" && report !== null && "rows" in report && Array.isArray(report.rows)) {
      const row: unknown = report.rows.find((r: unknown) => typeof r === "object" && r !== null && "run" in r && r.run === run.id);
      if (row) {
        expect(row).toMatchObject({
          provider: "reported-work", model: "codex-reported-model", action: "ask",
          agentSettings: { provider: "work", effort: "high", model: "gpt-test" },
          tokens: { input: 100, cachedInput: 20, output: 50, reasoning: 10, total: 150 },
        });
        expect(row).not.toHaveProperty("agentSettings.extra");
        return;
      }
    }
    await Bun.sleep(10);
  }
  throw new Error("routed usage was not written to the ledger");
});

test("workflow defaults reach the step runner and explicit step profiles win", async () => {
  await post("/api/agents/scope", { kind: "workflow", name: "route-check", pick: chosen });
  expect((await post("/api/repos/flow?id=app", { workflow: "route-check", note: "check" })).status).toBe(201);
  expect(seen.at(-1)).toMatchObject({ harness: "codex", agent: { provider: "work", model: "gpt-test" } });
  await settled();
  await post("/api/agents/scope", { kind: "workflow", name: "step-check", pick: chosen });
  expect((await post("/api/repos/flow?id=app", { workflow: "step-check", note: "check" })).status).toBe(201);
  expect(seen.at(-1)).toMatchObject({ harness: "claude", agent: { model: "default" } });
  await settled();
});

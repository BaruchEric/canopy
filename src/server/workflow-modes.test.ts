/** Real HTTP, git HEAD mode reads, flow/fleet/trigger wiring; only the agent process is replaced. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import type { FlowFile } from "../core/flowstore";
import { parseWorkflow } from "../core/workflow";
import { writeWorkItem } from "../core/workstore";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
const starts: string[] = [];

const call = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${server?.port ?? 0}${path}`, body === undefined ? {} : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const json = async (response: Response): Promise<unknown> => response.json();
function idOf(value: unknown): string {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") throw new Error("response has no id");
  return value.id;
}
async function done(id: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const flows = await json(await call("/api/flows"));
    if (Array.isArray(flows) && flows.some((item: unknown) => typeof item === "object" && item !== null && "id" in item && item.id === id && "status" in item && item.status === "done")) return;
    await Bun.sleep(10);
  }
  throw new Error(`flow ${id} did not finish`);
}
async function git(path: string, ...args: string[]): Promise<void> {
  const result = await exec(["git", "-C", path, ...args]);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-workflow-modes-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  const config = join(scratch, "config");
  process.env["CANOPY_CONFIG_DIR"] = config;
  await mkdir(join(config, "workflows"), { recursive: true });
  await mkdir(join(scratch, "root"), { recursive: true });
  const root = await realpath(join(scratch, "root"));
  for (const [name, mode] of [["graph-modes", "auto"], ["file-manual", "manual"]]) {
    await writeFile(join(config, "workflows", `${name}.md`), `---\nblurb: test\n---\n\n## Work\nmode: ${mode}\ntools: read\n\nDo the work.\n`);
  }
  for (const name of ["held", "auto", "broken"]) {
    const path = join(root, name);
    await mkdir(join(path, ".canopy"), { recursive: true });
    await git(path, "init", "-q", "-b", "main");
    const modes = name === "broken" ? "[]" : JSON.stringify({ modes: {
      "graph-modes": { Work: name === "held" ? "manual" : "auto" },
      "file-manual": { Work: "auto" },
    } });
    await writeFile(join(path, ".canopy", "workflows.json"), modes);
    await git(path, "add", ".");
    await git(path, "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "initial modes");
    // Uncommitted content attempts to reverse the committed decision both ways.
    if (name !== "broken") await writeFile(join(path, ".canopy", "workflows.json"), JSON.stringify({ modes: { "graph-modes": { Work: name === "held" ? "auto" : "manual" } } }));
  }
  await writeFile(join(config, "triggers.json"), JSON.stringify({ rules: [
    { name: "held-rule", repo: "held", workflow: "graph-modes", secretEnv: "CANOPY_TRIGGER_TEST_SECRET" },
    { name: "auto-rule", repo: "auto", workflow: "file-manual", secretEnv: "CANOPY_TRIGGER_TEST_SECRET" },
  ] }));
  const parsed = parseWorkflow("---\nblurb: held work\n---\n\n## Work\nmode: manual\n\nWork.\n", { name: "held-work", source: "user", file: "/held-work.md" });
  if (!parsed.ok) throw new Error(parsed.error);
  const held: FlowFile = {
    v: 1, before: "", savedAt: 1, root, repoPath: join(root, "held"), workflow: parsed.workflow,
    flow: {
      id: "abcdef42", repoId: "held", workflow: "held-work", verb: "held work", note: "", status: "gated",
      steps: [{ name: "Work", status: "held", reason: "Work waits for your go" }], current: 0, startedAt: 1,
      branch: { name: "run/held-work", target: "main", base: "abc123", dir: join(root, "held"), state: "working", origin: "abcdef42", work: "w-test2345" },
    },
  };
  await mkdir(join(config, "flows"), { recursive: true });
  await writeFile(join(config, "flows", "abcdef42.json"), JSON.stringify(held));
  await writeWorkItem(join(config, "work"), {
    id: "w-test2345", title: "Held branch work", repos: ["held"], state: "open", from: { kind: "note" },
    runs: [], branches: [], prs: [], events: [], notes: [], createdAt: 1, updatedAt: 1,
  });
  server = await startServer({
    root, port: 0, chan: null, harnesses: ["claude"],
    incubator: { autostart: false, transcribe: null, notes: null, ship: null, stage: null },
    runner: { driver: (harness) => ({
      harness, label: "test agent", check: () => null,
      start(ctx) {
        starts.push(ctx.cwd);
        queueMicrotask(() => {
          ctx.result({ text: "done", durationMs: 1, turns: 1, costUsd: 0 }, null);
          ctx.exited({ code: 0, stderr: "" });
        });
      },
      say() {}, stop() {},
    }) },
  });
});

afterAll(async () => {
  await server?.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("flow mode uses committed HEAD and cannot be loosened by dirty working-tree content", async () => {
  const response = await call("/api/repos/flow?id=held", { workflow: "graph-modes" });
  expect(response.status).toBe(201);
  expect(await json(response)).toMatchObject({ status: "gated", steps: [{ name: "Work", status: "held", reason: "Work waits for your go" }] });
  expect(starts).toHaveLength(0);
});

test("committed auto beats a dirty manual edit, and an invalid committed file returns 400", async () => {
  const response = await call("/api/repos/flow?id=auto", { workflow: "graph-modes" });
  expect(response.status).toBe(201);
  const flow = await json(response);
  await done(idOf(flow));
  expect(starts).toHaveLength(1);
  const broken = await call("/api/repos/flow?id=broken", { workflow: "graph-modes" });
  expect(broken.status).toBe(400);
  expect(await json(broken)).toEqual({ error: ".canopy/workflows.json must be an object" });
});

test("fleet modes resolve per repo before refusal and broken files skip only their repo", async () => {
  const response = await call("/api/fleet", { workflow: "graph-modes", ids: ["held", "auto", "broken"] });
  expect(response.status).toBe(201);
  expect(await json(response)).toMatchObject({ repos: [
    { repoId: "held", skipped: "graph-modes's Work step waits for a go, made manual by the repo's .canopy/workflows.json, and no one gives one in a fleet's run" },
    { repoId: "auto", flowId: expect.any(String) },
    { repoId: "broken", skipped: ".canopy/workflows.json must be an object" },
  ] });
});

test("trigger validation applies repo modes before accepting or refusing the workflow", async () => {
  const response = await call("/api/triggers");
  expect(response.status).toBe(200);
  const body = await json(response);
  expect(body).toMatchObject({ rules: [
    { name: "held-rule", problem: "graph-modes's Work step waits for a go, made manual by the repo's .canopy/workflows.json, and no one gives one in a trigger's run" },
    { name: "auto-rule" },
  ] });
  if (typeof body !== "object" || body === null || !("rules" in body) || !Array.isArray(body.rules)) throw new Error("missing rules");
  const automatic: unknown = body.rules[1];
  expect(automatic).not.toHaveProperty("problem");
});

test("an active held branch owns its work before any Run exists and refuses manual close", async () => {
  const response = await call("/api/work/one?id=w-test2345");
  expect(response.status).toBe(200);
  expect(await json(response)).toMatchObject({ id: "w-test2345", state: "working", runs: [] });
  const runs = await json(await call("/api/runs"));
  if (!Array.isArray(runs)) throw new Error("missing runs");
  expect(runs.filter((entry: unknown) => typeof entry === "object" && entry !== null && "branch" in entry && typeof entry.branch === "object" && entry.branch !== null && "work" in entry.branch && entry.branch.work === "w-test2345")).toHaveLength(0);
  const close = await call("/api/work/close", { id: "w-test2345", state: "dropped" });
  expect(close.status).toBe(409);
  expect(await json(close)).toEqual({ error: "a run on it is still going" });
});

test("a malformed repo policy marks only its trigger rule and refuses firing without hiding healthy rules", async () => {
  await writeFile(join(scratch, "config", "triggers.json"), JSON.stringify({ rules: [
    { name: "healthy-rule", repo: "auto", workflow: "file-manual", secretEnv: "CANOPY_TRIGGER_TEST_SECRET" },
    { name: "broken-rule", repo: "broken", workflow: "graph-modes", secretEnv: "CANOPY_TRIGGER_TEST_SECRET" },
  ] }));
  const before = starts.length;
  const listing = await call("/api/triggers");
  const body = await json(listing);
  const rejected = await call("/api/triggers/fire", { rule: "broken-rule", title: "Broken modes must refuse this run" });
  const rejection = await json(rejected);
  expect({ listing: listing.status, fire: rejected.status, starts: starts.length - before }).toEqual({ listing: 200, fire: 400, starts: 0 });
  expect(rejection).toEqual({ error: ".canopy/workflows.json must be an object" });
  expect(body).toMatchObject({ rules: [
    { name: "healthy-rule" },
    { name: "broken-rule", problem: ".canopy/workflows.json must be an object" },
  ] });
  if (typeof body !== "object" || body === null || !("rules" in body) || !Array.isArray(body.rules)) throw new Error("missing rules");
  const healthy: unknown = body.rules[0];
  expect(healthy).not.toHaveProperty("problem");
  const accepted = await call("/api/triggers/fire", { rule: "healthy-rule", title: "Healthy modes still start work" });
  expect(accepted.status).toBe(201);
  expect(await json(accepted)).toMatchObject({ kind: "started" });
  const deadline = Date.now() + 5000;
  while (starts.length === before && Date.now() < deadline) await Bun.sleep(10);
  expect(starts.length).toBe(before + 1);
});

test("wildcard schedule fire validates each committed mode and starts healthy queue and PR flows", async () => {
  await writeFile(join(scratch, "config", "workflows", "graph-modes.md"), "---\nblurb: schedule flow\n---\n\n## Work\nmode: auto\ntools: read\n\nDo the work.\n\n## Docs\nmode: auto\ntools: read\n\nRead the docs.\n");
  await writeFile(join(scratch, "config", "triggers.json"), JSON.stringify({ rules: [
    { name: "schedule-queue", source: "schedule", cron: "0 5 * * 1", repo: "*", workflow: "graph-modes" },
    { name: "schedule-pr", source: "schedule", cron: "0 5 * * 1", repo: "*", workflow: "graph-modes", land: "pr" },
  ] }));
  for (const [rule, land, pr] of [["schedule-queue", "queue", false], ["schedule-pr", "pr", true]] as const) {
    const response = await call("/api/triggers/fire", { rule });
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body).toMatchObject({ kind: "fired", events: [{ repoId: "auto", service: "schedule", source: "manual", land }], skipped: expect.arrayContaining([
      expect.objectContaining({ repo: "held", why: expect.stringContaining("waits for a go") }),
      expect.objectContaining({ repo: "broken", why: ".canopy/workflows.json must be an object" }),
    ]) });
    if (typeof body !== "object" || body === null || !("events" in body) || !Array.isArray(body.events)) throw new Error("missing events");
    const event: unknown = body.events[0];
    if (typeof event !== "object" || event === null || !("flowId" in event) || typeof event.flowId !== "string") throw new Error("missing flow id");
    await done(event.flowId);
    const flows = await json(await call("/api/flows"));
    if (!Array.isArray(flows)) throw new Error("missing flows");
    const flow: unknown = flows.find((candidate: unknown) => typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === event.flowId);
    expect(flow).toMatchObject({ id: event.flowId, status: "done", branch: expect.any(Object) });
    if (pr) expect(flow).toMatchObject({ branch: { openPr: true } });
    else if (typeof flow === "object" && flow !== null && "branch" in flow) expect(flow.branch).not.toHaveProperty("openPr");
  }
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveCtx, RunDriver } from "../core/driver";
import type { FlowFile } from "../core/flowstore";
import type { Harness } from "../core/types";
import type { WorkItem } from "../core/work";
import { writeWorkItem } from "../core/workstore";
import { parseWorkflow } from "../core/workflow";
import { startServer } from "./index";

const parsed = parseWorkflow(`---\nname: resume\nverb: resume work\nblurb: resume work\n---\n\n## Build\n\nContinue the branch work.\n`, {
  name: "resume",
  source: "bundled",
  file: "/resume.md",
});
if (!parsed.ok) throw new Error(parsed.error);

const WORK_ID = "w-test2345";
const FLOW_ID = "abcdef07";
const started: string[] = [];

class HoldingDriver implements RunDriver {
  readonly label = "Claude Code";

  constructor(readonly harness: Harness) {}

  check(): string | null {
    return null;
  }

  start(_ctx: DriveCtx, message: string): void {
    started.push(message);
  }

  say(): void {}
  stop(): void {}
}

let scratch: string;
let root: string;
let previousConfigDir: string | undefined;
let server: { port: number; stop: () => void };

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-work-restore-"));
  previousConfigDir = process.env["CANOPY_CONFIG_DIR"];
  const config = join(scratch, "config");
  process.env["CANOPY_CONFIG_DIR"] = config;
  root = join(scratch, "root");
  await mkdir(root, { recursive: true });
  root = await realpath(root);
  await mkdir(join(root, "app"), { recursive: true });
  await Bun.$`git -C ${join(root, "app")} init -q`.quiet();

  const flow: FlowFile = {
    v: 1,
    before: "",
    savedAt: 1,
    root,
    repoPath: join(root, "app"),
    workflow: parsed.workflow,
    flow: {
      id: FLOW_ID,
      repoId: "app",
      workflow: "resume",
      verb: "resume work",
      note: "continue the saved branch",
      status: "working",
      steps: [{ name: "Build", status: "running" }],
      current: 0,
      startedAt: 1,
      branch: {
        name: `run/${WORK_ID}-resume-work`,
        target: "main",
        base: "abc123",
        dir: join(config, "worktrees", "app", FLOW_ID),
        state: "working",
        origin: FLOW_ID,
        work: WORK_ID,
      },
    },
  };
  await mkdir(join(config, "flows"), { recursive: true });
  await writeFile(join(config, "flows", `${FLOW_ID}.json`), JSON.stringify(flow));
  const item: WorkItem = {
    id: WORK_ID,
    title: "Resume branch work",
    repos: ["app"],
    state: "open",
    from: { kind: "note" },
    runs: [],
    branches: [],
    prs: [],
    events: [],
    notes: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await writeWorkItem(join(config, "work"), item);

  server = await startServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    incubator: { autostart: false, transcribe: null, notes: null, ship: null, stage: null },
    runner: { driver: (harness) => new HoldingDriver(harness) },
  });
});

afterAll(async () => {
  server.stop();
  await Bun.sleep(100);
  if (previousConfigDir === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previousConfigDir;
  await rm(scratch, { recursive: true, force: true });
});

test("startup adopts work before restoring a branch flow and refuses closing its active run", async () => {
  const [workResponse, runsResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${server.port}/api/work/one?id=${WORK_ID}`),
    fetch(`http://127.0.0.1:${server.port}/api/runs`),
  ]);
  const work = (await workResponse.json()) as WorkItem;
  const runs = (await runsResponse.json()) as { id: string; status: string; branch?: { work?: string } }[];
  const activeRun = runs.find((run) => run.branch?.work === WORK_ID && run.status === "working");
  const closeResponse = await fetch(`http://127.0.0.1:${server.port}/api/work/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: WORK_ID, state: "dropped" }),
  });

  expect({
    started: started.length,
    linkedRun: activeRun ? work.runs.includes(activeRun.id) : false,
    closeStatus: closeResponse.status,
  }).toEqual({ started: 1, linkedRun: true, closeStatus: 409 });
});

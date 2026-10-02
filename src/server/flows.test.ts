/**
 * Flows outlive the server: a gated flow on disk comes back gated, one whose
 * repo left the scan comes back failed and its record says so, dismissing
 * drops the record, and stopping the server leaves a gated record gated.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowRecord } from "../core/flow";
import { killServer, tmuxBase } from "../core/tmux";
import type { Flow } from "../core/types";
import { parseWorkflow } from "../core/workflow";
import { startServer } from "./index";

const e = parseWorkflow(`---\nname: two\nverb: do two\nblurb: b\n---\n\n## First\ngate: ask\n\nOne.\n\n## Second\n\nTwo.\n`, {
  name: "two",
  source: "bundled",
  file: "/two.md",
});
if (!e.ok) throw new Error(e.error);
const TWO = e.workflow;

const rec = (id: string, repoId: string, status: "gated" | "working"): FlowRecord => ({
  v: 1,
  before: "",
  savedAt: 0,
  workflow: TWO,
  flow: {
    id,
    repoId,
    workflow: "two",
    verb: "do two",
    note: "",
    status,
    steps: [
      status === "gated" ? { name: "First", status: "gated", reason: "this step asks before the next one starts" } : { name: "First", status: "running" },
      { name: "Second", status: "pending" },
    ],
    current: 0,
    startedAt: 0,
  },
});

let scratch: string;
let previous: string | undefined;
let server: { port: number; stop: () => void } | null = null;
let flowsDir: string;

const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server?.port ?? 0}${path}`, init);
const onDisk = async (id: string): Promise<FlowRecord | null> => {
  const text = await readFile(join(flowsDir, `${id}.json`), "utf8").catch(() => null);
  return text === null ? null : (JSON.parse(text) as FlowRecord);
};
async function until(pred: () => Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-flows-srv-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  flowsDir = join(scratch, "config", "flows");
  await mkdir(flowsDir, { recursive: true });
  for (const r of [rec("abcdef01", "app", "gated"), rec("abcdef02", "gone", "working"), rec("abcdef03", "app2", "gated")]) {
    await writeFile(join(flowsDir, `${r.flow.id}.json`), JSON.stringify(r));
  }
  const root = join(scratch, "root");
  for (const name of ["app", "app2"]) {
    await mkdir(join(root, name), { recursive: true });
    await Bun.$`git -C ${join(root, name)} init -q`.quiet();
  }
  server = await startServer({ root, port: 0, harnesses: ["claude"] });
});

afterAll(async () => {
  server?.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("a gated flow comes back gated; one whose repo is gone comes back failed, on disk too", async () => {
  const flows = (await (await api("/api/flows")).json()) as Flow[];
  expect(flows.find((f) => f.id === "abcdef01")?.status).toBe("gated");
  const gone = flows.find((f) => f.id === "abcdef02");
  expect(gone?.status).toBe("failed");
  expect(gone?.error).toBe("the repo is not in the scan any more");
  await until(async () => (await onDisk("abcdef02"))?.flow.status === "failed", "the failed record");
});

test("stopping and dismissing a flow drops its record", async () => {
  const res = await api("/api/flows/resume", { method: "POST", body: JSON.stringify({ id: "abcdef01", choice: "stop" }) });
  expect(((await res.json()) as Flow).status).toBe("stopped");
  expect((await api("/api/flows?id=abcdef01", { method: "DELETE" })).status).toBe(200);
  await until(async () => (await onDisk("abcdef01")) === null, "the record to go");
});

test("stopping the server leaves a gated record gated", async () => {
  server?.stop();
  server = null;
  await Bun.sleep(100);
  expect((await onDisk("abcdef03"))?.flow.status).toBe("gated");
});

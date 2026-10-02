/**
 * Flows outlive the server: a gated flow on disk comes back gated, one whose
 * repo left the scan comes back failed and its record says so, a repo is
 * found by its path, a record written for another root is left alone, a
 * malformed one is skipped, dismissing drops the record, and stopping the server leaves a gated
 * record gated. The flows folder's lock a dead server left is taken over.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowFile } from "../core/flowstore";
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

const rec = (id: string, root: string, repoId: string, status: "gated" | "working", repoPath = join(root, repoId)): FlowFile => ({
  v: 1,
  before: "",
  savedAt: 0,
  workflow: TWO,
  repoPath,
  root,
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
let theirs: string;

const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server?.port ?? 0}${path}`, init);
const onDisk = async (id: string): Promise<FlowFile | null> => {
  const text = await readFile(join(flowsDir, `${id}.json`), "utf8").catch(() => null);
  return text === null ? null : (JSON.parse(text) as FlowFile);
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
  await mkdir(join(scratch, "root"));
  // the server's root is the real path (on a Mac the temp dir is a symlink)
  const root = await realpath(join(scratch, "root"));
  for (const name of ["app", "app2", "app3"]) {
    await mkdir(join(root, name), { recursive: true });
    await Bun.$`git -C ${join(root, name)} init -q`.quiet();
  }
  const other = rec("abcdef04", "/another/root", "app", "gated");
  theirs = JSON.stringify(other);
  for (const r of [
    rec("abcdef01", root, "app", "gated"),
    rec("abcdef02", root, "gone", "working"),
    rec("abcdef03", root, "app2", "gated"),
    rec("abcdef05", root, "an-id-from-before", "gated", join(root, "app3")),
  ]) {
    await writeFile(join(flowsDir, `${r.flow.id}.json`), JSON.stringify(r));
  }
  await writeFile(join(flowsDir, "abcdef04.json"), theirs);
  // steps that are no objects: skipped, and the server still starts
  const bad = rec("abcdef06", root, "app", "working");
  await writeFile(join(flowsDir, "abcdef06.json"), JSON.stringify({ ...bad, flow: { ...bad.flow, steps: ["x", "y"] } }));
  // the lock a server that is gone left behind
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  await writeFile(join(flowsDir, "owner.lock"), JSON.stringify({ pid: dead.pid, token: "gone" }));
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

test("a repo is found by its path, and a record written for another root is left alone", async () => {
  const flows = (await (await api("/api/flows")).json()) as Flow[];
  expect(flows.find((f) => f.id === "abcdef05")).toMatchObject({ status: "gated", repoId: "app3" });
  expect(flows.find((f) => f.id === "abcdef04")).toBeUndefined();
  expect(await readFile(join(flowsDir, "abcdef04.json"), "utf8")).toBe(theirs);
});

test("a record with a malformed step is skipped and does not stop the server", async () => {
  const flows = (await (await api("/api/flows")).json()) as Flow[];
  expect(flows.find((f) => f.id === "abcdef06")).toBeUndefined();
});

test("stopping and dismissing a flow drops its record", async () => {
  const res = await api("/api/flows/resume", { method: "POST", body: JSON.stringify({ id: "abcdef01", choice: "stop" }) });
  expect(((await res.json()) as Flow).status).toBe("stopped");
  expect((await api("/api/flows?id=abcdef01", { method: "DELETE" })).status).toBe(200);
  await until(async () => (await onDisk("abcdef01")) === null, "the record to go");
});

test("stopping the server leaves a gated record gated", async () => {
  const flows = (await (await api("/api/flows")).json()) as Flow[];
  expect(flows.find((f) => f.id === "abcdef03")?.status).toBe("gated");
  server?.stop();
  server = null;
  await Bun.sleep(100);
  expect((await onDisk("abcdef03"))?.flow.status).toBe("gated");
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowFiles, loadFlowRecords, parseFlowRecord } from "./flowstore";
import { parseWorkflow } from "./workflow";
import type { FlowRecord } from "./flow";

const e = parseWorkflow(`---\nblurb: b\n---\n\n## One\n\nx\n`, { name: "t", source: "bundled", file: "/t.md" });
if (!e.ok) throw new Error(e.error);
const workflow = e.workflow;

const rec = (id: string, status: "gated" | "done" = "gated"): FlowRecord => ({
  v: 1,
  before: "",
  savedAt: 0,
  workflow,
  flow: { id, repoId: "app", workflow: "t", verb: "t", note: "", status, steps: [{ name: "One", status: "gated" }], current: 0, startedAt: 0 },
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-flows-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseFlowRecord", () => {
  test("takes a well-formed record", () => {
    expect(parseFlowRecord(JSON.stringify(rec("abcdef01")))?.flow.id).toBe("abcdef01");
  });
  test.each<[string, string]>([
    ["truncated JSON", JSON.stringify(rec("abcdef01")).slice(0, 40)],
    ["another version", JSON.stringify({ ...rec("abcdef01"), v: 2 })],
    ["an id that is no flow id", JSON.stringify(rec("../../x"))],
    ["steps that do not match the workflow", JSON.stringify({ ...rec("abcdef01"), flow: { ...rec("abcdef01").flow, steps: [] } })],
    ["a current step out of range", JSON.stringify({ ...rec("abcdef01"), flow: { ...rec("abcdef01").flow, current: 3 } })],
  ])("refuses %s", (_what, text) => {
    expect(parseFlowRecord(text)).toBeNull();
  });
});

describe("FlowFiles", () => {
  test("keeps the last save, private to the user, and forgets on request", async () => {
    const files = new FlowFiles(dir);
    const a = rec("abcdef01");
    files.save(a);
    files.save({ ...a, flow: { ...a.flow, note: "second" } });
    await files.idle();
    const path = join(dir, "abcdef01.json");
    expect(parseFlowRecord(await readFile(path, "utf8"))?.flow.note).toBe("second");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    files.forget("abcdef01");
    await files.idle();
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

describe("loadFlowRecords", () => {
  test("reads every good record and skips a broken one or one under the wrong name", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "abcdef01.json"), JSON.stringify(rec("abcdef01")));
    await writeFile(join(dir, "abcdef02.json"), JSON.stringify(rec("abcdef02", "done")));
    await writeFile(join(dir, "abcdef03.json"), "{\"v\":1,\"flow\":");
    await writeFile(join(dir, "abcdef04.json"), JSON.stringify(rec("abcdef05")));
    await writeFile(join(dir, "notes.txt"), "not a record");
    const ids = (await loadFlowRecords(dir)).map((r) => r.flow.id);
    expect(ids).toEqual(["abcdef01", "abcdef02"]);
  });
  test("a missing folder is no records", async () => {
    expect(await loadFlowRecords(join(dir, "nope"))).toEqual([]);
  });
  test("removes a stray temp file a crash left, but not one a save may be writing", async () => {
    const old = join(dir, "abcdef01.json.tmp");
    const fresh = join(dir, "abcdef02.json.tmp");
    await writeFile(old, "half");
    await writeFile(fresh, "half");
    const past = new Date(Date.now() - 120_000);
    await utimes(old, past, past);
    await loadFlowRecords(dir);
    expect(await Bun.file(old).exists()).toBe(false);
    expect(await Bun.file(fresh).exists()).toBe(true);
  });
});

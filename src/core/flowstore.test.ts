import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowFiles, loadFlowRecords, lockFlows, parseFlowRecord, type FlowFile } from "./flowstore";
import { parseWorkflow } from "./workflow";

const e = parseWorkflow(`---\nblurb: b\n---\n\n## One\n\nx\n`, { name: "t", source: "bundled", file: "/t.md" });
if (!e.ok) throw new Error(e.error);
const workflow = e.workflow;

const ROOT = "/work";

const rec = (id: string, status: "gated" | "done" = "gated", root = ROOT): FlowFile => ({
  v: 1,
  before: "",
  savedAt: 0,
  workflow,
  repoPath: "/work/app",
  root,
  flow: { id, repoId: "app", workflow: "t", verb: "t", note: "", status, steps: [{ name: "One", status: "gated" }], current: 0, startedAt: 0 },
});

/** a pid no process has any more: one that has just exited */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}

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
    ["a step that is no object", JSON.stringify({ ...rec("abcdef01"), flow: { ...rec("abcdef01").flow, steps: ["x"] } })],
    ["a step with no status", JSON.stringify({ ...rec("abcdef01"), flow: { ...rec("abcdef01").flow, steps: [{ name: "One" }] } })],
    ["a step with no name", JSON.stringify({ ...rec("abcdef01"), flow: { ...rec("abcdef01").flow, steps: [{ status: "gated" }] } })],
    ["no repo path", JSON.stringify({ ...rec("abcdef01"), repoPath: undefined })],
    ["no launch root", JSON.stringify({ ...rec("abcdef01"), root: undefined })],
  ])("refuses %s", (_what, text) => {
    expect(parseFlowRecord(text)).toBeNull();
  });
});

describe("FlowFiles", () => {
  test("keeps the last save, private to the user, and forgets on request", async () => {
    const files = new FlowFiles(ROOT, dir);
    const a = rec("abcdef01");
    files.save(a);
    files.save({ ...a, flow: { ...a.flow, note: "second" } });
    await files.idle();
    const path = join(dir, "abcdef01.json");
    expect(parseFlowRecord(await readFile(path, "utf8"))?.flow.note).toBe("second");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    files.save(rec("abcdef01", "gated", "/some/other/root"));
    await files.idle();
    expect(parseFlowRecord(await readFile(path, "utf8"))?.root).toBe(ROOT);
    files.forget("abcdef01");
    await files.idle();
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("a failed write does not lose the newer save queued behind it, and idle waits for it", async () => {
    const files = new FlowFiles(ROOT, dir);
    // a folder where the temp file goes fails the first write; the failure's
    // log line clears it, so the newer save that queued meanwhile can land
    const blocker = join(dir, "abcdef01.json.tmp");
    await mkdir(join(blocker, "x"), { recursive: true });
    const logged: string[] = [];
    const log = spyOn(console, "error").mockImplementation((line: string) => {
      logged.push(line);
      rmSync(blocker, { recursive: true, force: true });
    });
    try {
      const a = rec("abcdef01");
      files.save(a);
      files.save({ ...a, flow: { ...a.flow, note: "newer" } });
      await files.idle();
    } finally {
      log.mockRestore();
    }
    expect(logged.length).toBe(1);
    const text = await readFile(join(dir, "abcdef01.json"), "utf8").catch(() => null);
    expect(text === null ? null : parseFlowRecord(text)?.flow.note).toBe("newer");
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
    const ids = (await loadFlowRecords(ROOT, dir)).map((r) => r.flow.id);
    expect(ids).toEqual(["abcdef01", "abcdef02"]);
  });
  test("a record written for another launch root is left on disk as it is and not loaded", async () => {
    const theirs = JSON.stringify(rec("abcdef02", "gated", "/another/root"));
    await writeFile(join(dir, "abcdef01.json"), JSON.stringify(rec("abcdef01")));
    await writeFile(join(dir, "abcdef02.json"), theirs);
    const ids = (await loadFlowRecords(ROOT, dir)).map((r) => r.flow.id);
    expect(ids).toEqual(["abcdef01"]);
    expect(await readFile(join(dir, "abcdef02.json"), "utf8")).toBe(theirs);
  });
  test("a missing folder is no records", async () => {
    expect(await loadFlowRecords(ROOT, join(dir, "nope"))).toEqual([]);
  });
  test("removes a stray temp file a crash left, but not one a save may be writing", async () => {
    const old = join(dir, "abcdef01.json.tmp");
    const fresh = join(dir, "abcdef02.json.tmp");
    await writeFile(old, "half");
    await writeFile(fresh, "half");
    const past = new Date(Date.now() - 120_000);
    await utimes(old, past, past);
    await loadFlowRecords(ROOT, dir);
    expect(await Bun.file(old).exists()).toBe(false);
    expect(await Bun.file(fresh).exists()).toBe(true);
  });
});

describe("lockFlows", () => {
  test("one holder at a time, in this process too, until it lets go", async () => {
    const first = await lockFlows(dir);
    expect(first.owner).toBe(true);
    const second = await lockFlows(dir);
    expect(second).toEqual({ owner: false, holder: process.pid });
    if (first.owner) first.release();
    const third = await lockFlows(dir);
    expect(third.owner).toBe(true);
    if (third.owner) third.release();
    expect(await Bun.file(join(dir, "owner.lock")).exists()).toBe(false);
  });

  test("a lock held by a live process is left alone", async () => {
    // pid 1 is always up, and signalling it is refused, which still says alive
    await writeFile(join(dir, "owner.lock"), JSON.stringify({ pid: 1, token: "theirs" }));
    expect(await lockFlows(dir)).toEqual({ owner: false, holder: 1 });
  });

  test("a lock a dead process left is taken over", async () => {
    await writeFile(join(dir, "owner.lock"), JSON.stringify({ pid: await deadPid(), token: "gone" }));
    const lock = await lockFlows(dir);
    expect(lock.owner).toBe(true);
    if (lock.owner) lock.release();
  });

  test("a lock under this pid that this process never took is a stale one from before", async () => {
    // a restarted container can hand canopy the pid its last run had
    await writeFile(join(dir, "owner.lock"), JSON.stringify({ pid: process.pid, token: "from-before" }));
    const lock = await lockFlows(dir);
    expect(lock.owner).toBe(true);
    if (lock.owner) lock.release();
  });

  test("a lock from before the machine booted is taken over, whoever has its pid now", async () => {
    // pid 1 is up, but the lock is older than the boot, so not its
    const path = join(dir, "owner.lock");
    await writeFile(path, JSON.stringify({ pid: 1, token: "last-boot" }));
    const old = new Date(Date.now() - 3_600_000);
    await utimes(path, old, old);
    const lock = await lockFlows(dir, Date.now() - 60_000);
    expect(lock.owner).toBe(true);
    if (lock.owner) lock.release();
  });

  test("a live holder's lock from this boot is left alone", async () => {
    await writeFile(join(dir, "owner.lock"), JSON.stringify({ pid: 1, token: "theirs" }));
    expect(await lockFlows(dir, Date.now() - 3_600_000)).toEqual({ owner: false, holder: 1 });
  });

  test("letting go leaves a lock someone else took since alone", async () => {
    const lock = await lockFlows(dir);
    const path = join(dir, "owner.lock");
    await writeFile(path, JSON.stringify({ pid: 1, token: "theirs" }));
    if (lock.owner) lock.release();
    expect(await Bun.file(path).exists()).toBe(true);
  });
});

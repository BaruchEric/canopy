import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeOpen, DiskRunLogger, dropKept, headOf, INDEX, listKept, pruneKept, readKeptRun, rebuildIndex, RUN_FILE, RUN_ID, RUN_LOG_MAX, RunLog, WIRE, WIRE_GZ } from "./runlog";
import type { Run } from "./types";

let root = "";
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "canopy-runlog-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const token = `cnp_coordinator_${"a".repeat(43)}`;
const run = (over: Partial<Run> = {}): Run => ({
  id: "ab12cd34", repoId: "repo", action: "ask", verb: "Ask", progress: "", expectsChange: false, chat: false,
  harness: "claude", note: "note", status: "done", startedAt: 1000, endedAt: 5000, steps: [], prompt: null,
  result: { text: "done", costUsd: 0.42, durationMs: 4000, turns: 1 }, ...over,
});
const mode = async (path: string) => (await stat(path)).mode & 0o777;
const wire = async (folder: string): Promise<unknown[]> => new TextDecoder().decode(Bun.gunzipSync(await Bun.file(join(folder, WIRE_GZ)).bytes())).split("\n").filter(Boolean).map((line): unknown => JSON.parse(line));
const open = (dir: string, value = run(), over: Partial<ConstructorParameters<typeof RunLog>[0]> = {}) => new RunLog({ dir, run: value, argv: [], secrets: [], onError: (why) => { throw new Error(why); }, ...over });

test("wire directions are ordered and redacted before writing, then settle is once-only", async () => {
  const dir = join(root, "ordered");
  let now = 10;
  const log = open(dir, run(), { argv: ["claude", "--mcp-config=/private/config"], secrets: [{ name: "CANOPY_TOKEN", value: token }], now: () => now++ });
  log.wire("out", JSON.stringify({ token }));
  log.wire("in", 'hello');
  const value = run({ note: token, session: "session" });
  await Promise.all([log.settle(value), log.settle(run({ status: "failed" }))]);
  expect(await wire(log.folder)).toEqual([
    { canopy: "start", at: 10, run: value.id, repo: "repo", action: "ask", harness: "claude", argv: ["claude", "--mcp-config=<redacted:mcp-config>"] },
    { token: "<redacted:CANOPY_TOKEN>" }, { canopy: "in", at: 11, line: "hello" }, { canopy: "end", at: 12, status: "done" },
  ]);
  expect(await readKeptRun(dir, value.id)).toMatchObject({ kept: true, note: "<redacted:CANOPY_TOKEN>", session: "session", status: "done" });
  expect(await listKept(dir)).toEqual([headOf(value)]);
  expect(existsSync(join(log.folder, WIRE))).toBe(false);
});

test("existing folders and files become private and every output is private", async () => {
  const dir = join(root, "modes");
  const folder = join(dir, "r1");
  await mkdir(folder, { recursive: true });
  await chmod(dir, 0o755); await chmod(folder, 0o755);
  await writeFile(join(folder, WIRE), "", { mode: 0o666 }); await chmod(join(folder, WIRE), 0o666);
  const log = open(dir, run({ id: "r1" }));
  expect(await mode(dir)).toBe(0o700); expect(await mode(folder)).toBe(0o700); expect(await mode(join(folder, WIRE))).toBe(0o600);
  await log.settle(run({ id: "r1" }));
  for (const path of [join(folder, WIRE_GZ), join(folder, RUN_FILE), join(dir, INDEX)]) expect(await mode(path)).toBe(0o600);
});

test("cut closes wire at the configured byte boundary but still settles snapshot and gzip", async () => {
  expect(RUN_LOG_MAX).toBe(50 * 1024 * 1024);
  const dir = join(root, "cut");
  const log = open(dir, run(), { max: 300 });
  for (let i = 0; i < 20; i++) log.wire("out", JSON.stringify({ i, pad: "x".repeat(60) }));
  await log.settle(run());
  const lines = await wire(log.folder);
  expect(lines.at(-1)).toMatchObject({ canopy: "cut", bytes: expect.any(Number) });
  expect(lines.some((line) => typeof line === "object" && line !== null && "canopy" in line && line.canopy === "end")).toBe(false);
  expect(lines.length).toBeLessThan(20);
  expect(await readKeptRun(dir, run().id)).toMatchObject({ status: "done" });
});

test("concurrent settles retain every index entry and preserve limited status and branch origin", async () => {
  const dir = join(root, "concurrent");
  const values = Array.from({ length: 12 }, (_, i) => run({ id: `r${i}`, status: i === 0 ? "limited" : "done", ...(i === 0 ? { branch: { name: "run/work", target: "main", base: "base", dir: "/owned", state: "ready", origin: "origin" } } : {}) }));
  await Promise.all(values.map((value) => open(dir, value).settle(value)));
  expect((await listKept(dir)).map((head) => head.id).sort()).toEqual(values.map((value) => value.id).sort());
  expect(await readKeptRun(dir, "r0")).toMatchObject({ status: "limited" });
  expect((await listKept(dir)).find((head) => head.id === "r0")).toMatchObject({ status: "limited", origin: "origin" });
});

test("open and later snapshot write failures report once without changing the run or rejecting settle", async () => {
  const bad = join(root, "not-dir"); await writeFile(bad, "file");
  const errors: string[] = [];
  const logger = new DiskRunLogger({ dir: bad, env: () => ({}), appliedFile: join(root, "absent-applied") });
  expect(logger.open(run(), [], {}, (why) => errors.push(why))).toBeNull();
  expect(errors).toHaveLength(1);
  const dir = join(root, "write-failure");
  const log = open(dir, run(), { onError: (why) => errors.push(why) });
  await mkdir(join(log.folder, RUN_FILE));
  const value = run();
  await expect(log.settle(value)).resolves.toBeUndefined();
  await log.settle(value); log.wire("out", "later");
  expect(errors).toHaveLength(2); expect(value.status).toBe("done");
});

test("applied names refresh between opens and environment values are read from fake sources", async () => {
  const dir = join(root, "applied"); const file = join(root, "fake-applied.json");
  await writeFile(file, JSON.stringify({ sink: { FIRST: "stamp" } }));
  const logger = new DiskRunLogger({ dir, appliedFile: file, env: () => ({ FIRST: "first-secret", SECOND: "second-secret" }) });
  await logger.refresh();
  const a = logger.open(run({ id: "a" }), [], {}, () => {}); if (!a) throw new Error("missing first log");
  a.wire("out", JSON.stringify({ value: "first-secret" })); await a.settle(run({ id: "a" }));
  await writeFile(file, JSON.stringify({ sink: { SECOND: "stamp" } })); await logger.refresh();
  const b = logger.open(run({ id: "b" }), [], {}, () => {}); if (!b) throw new Error("missing refreshed log");
  b.wire("out", JSON.stringify({ value: "second-secret" })); await b.settle(run({ id: "b" }));
  expect((await wire(a.folder))[1]).toEqual({ value: "<redacted:FIRST>" });
  expect((await wire(b.folder))[1]).toEqual({ value: "<redacted:SECOND>" });
});

test("invalid IDs are refused before paths and torn or structurally invalid snapshots read null", async () => {
  const dir = join(root, "invalid");
  for (const id of ["../escape", "a/b", "a b", "", "a".repeat(65)]) {
    expect(RUN_ID.test(id)).toBe(false); expect(await readKeptRun(dir, id)).toBeNull(); expect(await dropKept(dir, id)).toBe(false);
    expect(() => open(dir, run({ id }))).toThrow();
  }
  await mkdir(join(dir, "torn"), { recursive: true });
  for (const text of ["{", JSON.stringify({ id: "torn", status: "done" }), JSON.stringify(run({ id: "other" })), JSON.stringify(run({ id: "torn", steps: [] })).replace('"steps":[]', '"steps":[{"kind":"tool","tool":1}]')]) {
    await writeFile(join(dir, "torn", RUN_FILE), text); expect(await readKeptRun(dir, "torn")).toBeNull();
  }
});

test("listing repairs missing, malformed and stale indexes from safe folders", async () => {
  const dir = join(root, "index");
  for (const id of ["one", "two"]) await open(dir, run({ id })).settle(run({ id }));
  await writeFile(join(dir, INDEX), "not JSON"); expect((await listKept(dir)).map((head) => head.id).sort()).toEqual(["one", "two"]);
  await rm(join(dir, "two"), { recursive: true }); expect((await listKept(dir)).map((head) => head.id)).toEqual(["one"]);
  await rm(join(dir, INDEX)); expect((await rebuildIndex(dir)).map((head) => head.id)).toEqual(["one"]);
});

test("symlink roots, folders and data files never expose or mutate unrelated data", async () => {
  const outside = join(root, "outside"); await mkdir(outside);
  const snapshot = JSON.stringify(run({ id: "linked" })); await writeFile(join(outside, RUN_FILE), snapshot);
  const dir = join(root, "links"); await mkdir(dir);
  await symlink(outside, join(dir, "linked"));
  expect(await readKeptRun(dir, "linked")).toBeNull(); expect(await dropKept(dir, "linked")).toBe(false);
  expect(await listKept(dir)).toEqual([]); expect(await closeOpen(dir, () => undefined, { secrets: [], credentials: [] })).toEqual([]);
  expect(() => open(dir, run({ id: "linked" }))).toThrow();
  await mkdir(join(dir, "filelink")); await symlink(join(outside, RUN_FILE), join(dir, "filelink", RUN_FILE));
  expect(await readKeptRun(dir, "filelink")).toBeNull();
  await symlink(outside, join(root, "rootlink")); expect(await listKept(join(root, "rootlink"))).toEqual([]);
  expect(await readFile(join(outside, RUN_FILE), "utf8")).toBe(snapshot);
});

test("pruning protects live run IDs and origins and keeps the exact retention boundary", async () => {
  const dir = join(root, "prune"); const now = 10000; const keep = 1000;
  for (const [id, endedAt, origin] of [["old", 8999, ""], ["boundary", 9000, ""], ["live", 1, ""], ["branch", 1, "origin"]] satisfies [string, number, string][]) {
    const value = run({ id, endedAt, ...(origin ? { branch: { name: "run/work", target: "main", base: "b", dir: "/owned", state: "ready", origin } } : {}) });
    await open(dir, value).settle(value);
  }
  expect(await pruneKept(dir, keep, new Set(["live", "origin"]), now)).toEqual({ removed: ["old"], kept: 3 });
  expect(await dropKept(dir, "boundary")).toBe(true); expect(await dropKept(dir, "boundary")).toBe(false);
});

test("restart closes unfinished wires head-only, preserves settled snapshots and respects a cut", async () => {
  const dir = join(root, "restart");
  const start = (id: string) => JSON.stringify({ canopy: "start", at: 5, run: id, repo: "repo", action: "ask", harness: "codex", argv: [] });
  for (const id of ["head", "cut", "settled"]) {
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, WIRE), start(id) + "\n" + (id === "cut" ? '{"canopy":"cut","at":6,"bytes":10}\n' : '{"method":"notice"}\n'));
  }
  await writeFile(join(dir, "settled", RUN_FILE), JSON.stringify(run({ id: "settled", status: "limited" })));
  expect((await closeOpen(dir, (id) => id === "head" ? { verb: "Ask", note: "recovered" } : undefined, { secrets: [], credentials: [] }, 77)).sort()).toEqual(["cut", "head", "settled"]);
  expect(await readKeptRun(dir, "head")).toMatchObject({ id: "head", status: "stopped", startedAt: 5, endedAt: 77, note: "recovered", kept: true });
  expect(await readKeptRun(dir, "settled")).toMatchObject({ status: "limited", endedAt: 5000 });
  expect((await wire(join(dir, "head"))).at(-1)).toEqual({ canopy: "end", at: 77, status: "stopped" });
  expect((await wire(join(dir, "cut"))).at(-1)).toMatchObject({ canopy: "cut" });
  expect(await closeOpen(dir, () => undefined, { secrets: [], credentials: [] }, 78)).toEqual([]);
});

test("typed routing and fixed metadata survive short, numeric and quote context values while payloads redact", async () => {
  for (const [id, value] of [["letter", "a"], ["digit", "1"], ["quote", '"']] satisfies [string, string][]) {
    const dir = join(root, id); const current = run({ id, note: `${id} ${value}`, result: { text: value, durationMs: 1, turns: 1 } });
    const logger = new DiskRunLogger({ dir, env: () => ({}), appliedFile: join(root, "no-applied"), now: () => 10 });
    const log = logger.open(current, [], { CANOPY_RUN: id, CANOPY_REPO: "repo", CANOPY_SHORT: value }, () => {});
    if (!log) throw new Error("context values must not disable recording");
    log.wire("out", JSON.stringify({ [value]: value })); await log.settle(current);
    const kept = await readKeptRun(dir, id);
    expect(kept).toMatchObject({ id, repoId: "repo", harness: "claude", status: "done", startedAt: 1000, result: { text: "<redacted:CANOPY_SHORT>", durationMs: 1, turns: 1 } });
    expect(kept?.note).toBe("<redacted:CANOPY_RUN> <redacted:CANOPY_SHORT>");
    expect((await wire(log.folder))[1]).toEqual({ "<redacted:CANOPY_SHORT>": "<redacted:CANOPY_SHORT>" });
  }
});

test("credential collisions in required routing and numeric facts fail closed once", async () => {
  const dir = join(root, "credential-collision"); const errors: string[] = [];
  const logger = new DiskRunLogger({ dir, env: () => ({ CANOPY_TOKEN: "identity" }), appliedFile: join(root, "no-applied"), now: () => 7 });
  expect(logger.open(run({ id: "identity" }), [], {}, (why) => errors.push(why))).toBeNull();
  expect(existsSync(join(dir, "identity"))).toBe(false); expect(errors).toHaveLength(1);
  const log = open(dir, run({ id: "numeric" }), { secrets: [{ name: "VERCEL_TOKEN", value: "1" }], now: () => 7, onError: (why) => errors.push(why) });
  await log.settle(run({ id: "numeric" })); await log.settle(run({ id: "numeric" }));
  expect(errors).toHaveLength(2); expect(existsSync(join(log.folder, RUN_FILE))).toBe(false);
  expect(await listKept(dir)).toEqual([]);
});

test("recovery sanitizes hints with explicitly supplied current secrets", async () => {
  const dir = join(root, "hint-privacy"); const folder = join(dir, "recovered"); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, WIRE), JSON.stringify({ canopy: "start", at: 5, run: "recovered", repo: "repo", action: "ask", harness: "codex", argv: [] }) + "\n");
  const secrets = [{ name: "CANOPY_TOKEN", value: token }];
  await closeOpen(dir, () => ({ note: token, verb: token, session: token }), { secrets, credentials: secrets }, 77);
  expect(await readKeptRun(dir, "recovered")).toMatchObject({ note: "<redacted:CANOPY_TOKEN>", verb: "<redacted:CANOPY_TOKEN>", session: "<redacted:CANOPY_TOKEN>" });
});

test("rebuild includes head-only wires and ignores a symlink index target", async () => {
  const dir = join(root, "head-index"); await mkdir(join(dir, "head"), { recursive: true });
  await writeFile(join(dir, "head", WIRE), JSON.stringify({ canopy: "start", at: 5, run: "head", repo: "repo", action: "ask", harness: "codex", argv: [] }) + "\n");
  const target = join(root, "untouched-index"); await writeFile(target, "untouched"); await symlink(target, join(dir, INDEX));
  expect(await listKept(dir)).toMatchObject([{ id: "head", status: "stopped", started: 5 }]);
  expect(await readFile(target, "utf8")).toBe("untouched");
});

test("a synchronous open sees names applied since the last refresh", async () => {
  const file = join(root, "new-applied.json"); await writeFile(file, "{}");
  const logger = new DiskRunLogger({ dir: join(root, "new-applied"), env: () => ({ NEW_KEY: "fresh-secret" }), appliedFile: file });
  await logger.refresh();
  await writeFile(file, JSON.stringify({ sink: { NEW_KEY: "stamp" } }));
  const log = logger.open(run(), [], {}, () => {}); if (!log) throw new Error("no log");
  log.wire("out", '{"value":"fresh-secret"}'); await log.settle(run());
  expect((await wire(log.folder))[1]).toEqual({ value: "<redacted:NEW_KEY>" });
});

test("the byte ceiling also cuts an oversized end without appending an end after it", async () => {
  const dir = join(root, "end-cut"); const log = open(dir, run(), { max: 250 });
  await log.settle(run({ error: "error ".repeat(100) }));
  expect((await wire(log.folder)).at(-1)).toMatchObject({ canopy: "cut" });
  expect(await readKeptRun(dir, run().id)).toMatchObject({ error: "error ".repeat(100) });
});

test("a gzip write failure reports once and does not reject or change the run", async () => {
  const dir = join(root, "gzip-failure"); const errors: string[] = [];
  const log = open(dir, run(), { onError: (why) => errors.push(why) });
  await mkdir(join(log.folder, WIRE_GZ));
  const value = run(); await log.settle(value); await log.settle(value);
  expect(errors).toHaveLength(1); expect(value.status).toBe("done");
  expect(await readKeptRun(dir, value.id)).toMatchObject({ status: "done" });
  expect(existsSync(join(log.folder, WIRE))).toBe(true);
});

test("an actual wire write failure disables later writes and reports once", async () => {
  const errors: string[] = []; const log = open(join(root, "wire-failure"), run(), { onError: (why) => errors.push(why) });
  const broken = spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("synthetic ENOSPC"); });
  try { log.wire("out", "first"); log.wire("out", "second"); } finally { broken.mockRestore(); }
  await log.settle(run());
  expect(errors).toEqual(["synthetic ENOSPC"]);
  expect(existsSync(join(log.folder, RUN_FILE))).toBe(false);
});

test("head-only index fallback has a stable retention time", async () => {
  const dir = join(root, "head-retention"); const folder = join(dir, "oldhead"); await mkdir(folder, { recursive: true });
  const path = join(folder, WIRE);
  await writeFile(path, JSON.stringify({ canopy: "start", at: 5, run: "oldhead", repo: "repo", action: "ask", harness: "codex", argv: [] }) + "\n");
  await utimes(path, new Date(1000), new Date(1000));
  expect(await pruneKept(dir, 1000, new Set(), 2001)).toEqual({ removed: ["oldhead"], kept: 0 });
});

test("recovery redacts echoed routing values in hints and rejects an absent sanitizer", async () => {
  const dir = join(root, "routing-hint"); const folder = join(dir, "head"); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, WIRE), JSON.stringify({ canopy: "start", at: 5, run: "head", repo: "repo", action: "ask", harness: "codex", argv: [] }) + "\n");
  await expect(Reflect.apply(closeOpen, null, [dir, () => ({ note: token })])).rejects.toThrow("requires current");
  await closeOpen(dir, () => ({ note: "head repo" }), { secrets: [], credentials: [] }, 77);
  expect(await readKeptRun(dir, "head")).toMatchObject({ id: "head", repoId: "repo", note: "<redacted:CANOPY_RUN> <redacted:CANOPY_REPO>" });
});

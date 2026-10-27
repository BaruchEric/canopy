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

test("arbitrary boolean and null protocol scalars redact in both directions", async () => {
  for (const value of [true, false, null]) {
    const spelling = String(value); const dir = join(root, `scalar-${spelling}`);
    const secrets = [{ name: "CANOPY_CONTEXT", value: spelling }];
    const log = open(dir, run(), { secrets });
    log.wire("out", JSON.stringify({ value })); log.wire("in", JSON.stringify({ value }));
    await log.settle(run());
    const lines = await wire(log.folder);
    expect(lines[1]).toEqual({ value: "<redacted:CANOPY_CONTEXT>" });
    expect(lines[2]).toMatchObject({ canopy: "in", line: '{"value":"<redacted:CANOPY_CONTEXT>"}' });
  }
  const log = open(join(root, "scalar-plain"));
  log.wire("out", '[true,false,null]'); await log.settle(run());
  expect((await wire(log.folder))[1]).toEqual([true, false, null]);
});

test("credential-rejected recovery folders cannot reappear through head-only or snapshot listing", async () => {
  for (const [id, repoId, snapshot, origin] of [["identity", "repo", false, ""], ["snapshot", "identity", true, ""], ["branch", "repo", true, "identity"]] satisfies [string, string, boolean, string][]) {
    const dir = join(root, `reject-${id}`); const folder = join(dir, id); await mkdir(folder, { recursive: true });
    await writeFile(join(folder, WIRE), JSON.stringify({ canopy: "start", at: 5, run: id, repo: repoId, action: "ask", harness: "codex", argv: [] }) + "\n");
    if (snapshot) await writeFile(join(folder, RUN_FILE), JSON.stringify(run({ id, repoId, ...(origin ? { branch: { name: "run/work", target: "main", base: "base", dir: "/owned", state: "ready", origin } } : {}) })));
    const secrets = [{ name: "CANOPY_TOKEN", value: "identity" }];
    expect(await closeOpen(dir, () => undefined, { secrets, credentials: secrets }, 77)).toEqual([]);
    expect(await listKept(dir)).toEqual([]); expect(await rebuildIndex(dir)).toEqual([]);
    expect(await readKeptRun(dir, id)).toBeNull();
    expect(await readFile(join(dir, INDEX), "utf8")).not.toContain("identity");
  }
});

test("malformed, unreadable and vanished applied sources fail closed until repaired", async () => {
  for (const broken of ["json", "shape", "directory", "missing"]) {
    const dir = join(root, `bad-applied-${broken}`); const file = join(root, `bad-applied-${broken}.json`);
    const valid = JSON.stringify({ sink: { PROVIDER_KEY: "stamp" } }); await writeFile(file, valid);
    const logger = new DiskRunLogger({ dir, appliedFile: file, env: () => ({ PROVIDER_KEY: "provider-secret" }) });
    await logger.refresh();
    if (broken === "json") await writeFile(file, "{");
    if (broken === "shape") await writeFile(file, JSON.stringify({ sink: { PROVIDER_KEY: 1 } }));
    if (broken === "directory" || broken === "missing") await rm(file);
    if (broken === "directory") await mkdir(file);
    const errors: string[] = [];
    expect(logger.open(run(), [], {}, (why) => errors.push(why))).toBeNull(); expect(errors).toHaveLength(1);
    expect(() => logger.currentSecrets()).toThrow("applied");
    expect(await listKept(dir)).toEqual([]);
    if (broken === "directory") await rm(file, { recursive: true });
    await writeFile(file, valid); await logger.refresh();
    const log = logger.open(run(), [], {}, () => {}); if (!log) throw new Error("repair must restore logging");
    log.wire("out", '{"value":"provider-secret"}'); await log.settle(run());
    expect((await wire(log.folder))[1]).toEqual({ value: "<redacted:PROVIDER_KEY>" });
  }
});

test("an initially absent applied source is allowed but an initially malformed source is refused", async () => {
  const dir = join(root, "initial-applied"); const file = join(root, "initial-applied.json");
  const logger = new DiskRunLogger({ dir, appliedFile: file, env: () => ({}) });
  const log = logger.open(run(), [], {}, () => {}); expect(log).not.toBeNull(); await log?.settle(run());
  await writeFile(file, "[]"); const other = new DiskRunLogger({ dir, appliedFile: file, env: () => ({}) });
  const errors: string[] = []; expect(other.open(run({ id: "bad" }), [], {}, (why) => errors.push(why))).toBeNull(); expect(errors).toHaveLength(1);
});

test("oversized start records cut before argv bytes and retain a recoverable private head", async () => {
  for (const settle of [true, false]) {
    const dir = join(root, `big-header-${settle}`); const value = run({ id: "header" });
    const log = open(dir, value, { max: 100, argv: ["claude", "large-argument-".repeat(10000)], now: () => 5 });
    expect((await stat(join(log.folder, WIRE))).size).toBeLessThanOrEqual(100);
    expect(await readFile(join(log.folder, WIRE), "utf8")).not.toContain("large-argument");
    expect(await readKeptRun(dir, "header")).toMatchObject({ id: "header", status: "stopped", repoId: "repo" });
    if (settle) await log.settle(run({ id: "header", status: "limited" }));
    else expect(await closeOpen(dir, () => undefined, { secrets: [], credentials: [] }, 77)).toEqual(["header"]);
    expect(await wire(log.folder)).toEqual([{ canopy: "cut", at: 5, bytes: 0 }]);
    expect(await readKeptRun(dir, "header")).toMatchObject({ status: settle ? "limited" : "stopped" });
  }
});

test("private boolean and null scalar values redact without relying on context-name classification", async () => {
  for (const value of [true, false, null]) {
    const spelling = String(value); const dir = join(root, `private-scalar-${spelling}`);
    const secrets = [{ name: "VERCEL_TOKEN", value: spelling }];
    const current = run({ expectsChange: value === false, chat: value === false, ...(value === null ? { prompt: { id: "p", kind: "proposal", plan: "", auto: false } } : {}) });
    const log = open(dir, current, { secrets });
    log.wire("out", JSON.stringify({ value })); log.wire("in", JSON.stringify({ value })); await log.settle(current);
    const lines = await wire(log.folder);
    expect(lines[1]).toEqual({ value: "<redacted:VERCEL_TOKEN>" });
    expect(lines[2]).toMatchObject({ canopy: "in", line: '{"value":"<redacted:VERCEL_TOKEN>"}' });
  }
});

test("a credential colliding with a typed null fact fails closed", async () => {
  const errors: string[] = []; const dir = join(root, "null-fact");
  const log = open(dir, run(), { secrets: [{ name: "VERCEL_TOKEN", value: "null" }], onError: (why) => errors.push(why) });
  await log.settle(run()); expect(errors).toHaveLength(1); expect(await listKept(dir)).toEqual([]);
});

test("a rejected recovery record stays excluded when its folder cannot be removed", async () => {
  const dir = join(root, "reject-undeletable"); const folder = join(dir, "identity"); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, WIRE), JSON.stringify({ canopy: "start", at: 5, run: "identity", repo: "repo", action: "ask", harness: "codex", argv: [] }) + "\n");
  const actualRm = fs.rmSync;
  const blocked = spyOn(fs, "rmSync").mockImplementation((path, opts) => {
    if (path === folder) throw new Error("synthetic removal failure");
    actualRm(path, opts);
  });
  const secrets = [{ name: "CANOPY_TOKEN", value: "identity" }];
  try { expect(await closeOpen(dir, () => undefined, { secrets, credentials: secrets }, 77)).toEqual([]); }
  finally { blocked.mockRestore(); }
  expect(existsSync(folder)).toBe(true);
  expect(await listKept(dir)).toEqual([]); expect(await rebuildIndex(dir)).toEqual([]);
  expect(await readKeptRun(dir, "identity")).toBeNull();
});

test("a RunLog credential rejection attempts removal even when its marker cannot be written", async () => {
  const dir = join(root, "marker-failed-runlog"); const errors: string[] = [];
  const log = open(dir, run({ id: "numeric" }), { secrets: [{ name: "VERCEL_TOKEN", value: "1" }], now: () => 7, onError: (why) => errors.push(why) });
  const actualOpen = fs.openSync;
  const failed = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
    if (typeof path === "string" && path.includes(".privacy-rejected.tmp")) throw new Error("synthetic marker creation failure");
    return actualOpen(path, flags, mode);
  });
  try { await log.settle(run({ id: "numeric" })); } finally { failed.mockRestore(); }
  expect(errors).toHaveLength(1); expect(existsSync(log.folder)).toBe(false);
  expect(await listKept(dir)).toEqual([]); expect(await readKeptRun(dir, "numeric")).toBeNull();
});

test("recovery continues and removes a rejected record when marker creation fails", async () => {
  const dir = join(root, "marker-failed-recovery");
  for (const id of ["identity", "healthy"]) {
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, WIRE), JSON.stringify({ canopy: "start", at: 5, run: id, repo: "repo", action: "ask", harness: "codex", argv: [] }) + "\n");
  }
  const actualOpen = fs.openSync;
  const failed = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
    if (typeof path === "string" && path.includes(".privacy-rejected.tmp")) throw new Error("synthetic marker creation failure");
    return actualOpen(path, flags, mode);
  });
  const secrets = [{ name: "CANOPY_TOKEN", value: "identity" }];
  try { expect(await closeOpen(dir, () => undefined, { secrets, credentials: secrets }, 77)).toEqual(["healthy"]); }
  finally { failed.mockRestore(); }
  expect(existsSync(join(dir, "identity"))).toBe(false);
  expect((await listKept(dir)).map((head) => head.id)).toEqual(["healthy"]);
  expect(await readFile(join(dir, INDEX), "utf8")).not.toContain("identity");
});

test("an unmarked undeletable rejection stays quarantined until durable exclusion succeeds", async () => {
  const dir = join(root, "marker-and-remove-failed"); const folder = join(dir, "identity"); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, WIRE), JSON.stringify({ canopy: "start", at: 5, run: "identity", repo: "repo", action: "ask", harness: "codex", argv: [] }) + "\n");
  const actualOpen = fs.openSync; const actualRm = fs.rmSync; let removalAttempts = 0;
  const failedMarker = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
    if (typeof path === "string" && path.includes(".privacy-rejected.tmp")) throw new Error("synthetic marker creation failure");
    return actualOpen(path, flags, mode);
  });
  const failedRemoval = spyOn(fs, "rmSync").mockImplementation((path, opts) => {
    if (path === folder) { removalAttempts++; throw new Error("synthetic removal failure"); }
    actualRm(path, opts);
  });
  const secrets = [{ name: "CANOPY_TOKEN", value: "identity" }];
  try {
    expect(await closeOpen(dir, () => undefined, { secrets, credentials: secrets }, 77)).toEqual([]);
    expect(removalAttempts).toBeGreaterThan(0);
    expect(existsSync(folder)).toBe(true); expect(existsSync(join(folder, ".privacy-rejected"))).toBe(false);
    expect(await listKept(dir)).toEqual([]); expect(await rebuildIndex(dir)).toEqual([]);
    expect(await readKeptRun(dir, "identity")).toBeNull();
    expect(await readFile(join(dir, INDEX), "utf8")).not.toContain("identity");
    failedMarker.mockRestore();
    expect(await listKept(dir)).toEqual([]);
    expect(existsSync(join(folder, ".privacy-rejected"))).toBe(true);
  } finally { failedMarker.mockRestore(); failedRemoval.mockRestore(); }
  expect(await listKept(dir)).toEqual([]); expect(await readKeptRun(dir, "identity")).toBeNull();
});

test("partial removal that erases the rejection marker cannot revive a surviving record", async () => {
  const dir = join(root, "partial-rejection-remove"); const folder = join(dir, "identity"); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, WIRE), JSON.stringify({ canopy: "start", at: 5, run: "identity", repo: "repo", action: "ask", harness: "codex", argv: [] }) + "\n");
  await writeFile(join(folder, RUN_FILE), JSON.stringify(run({ id: "identity" })));
  const actualRm = fs.rmSync; let partialAttempts = 0;
  const partial = spyOn(fs, "rmSync").mockImplementation((path, opts) => {
    if (path === folder) {
      partialAttempts++; actualRm(join(folder, ".privacy-rejected"), { force: true });
      throw new Error("synthetic partial removal after marker unlink");
    }
    actualRm(path, opts);
  });
  const secrets = [{ name: "CANOPY_TOKEN", value: "identity" }];
  try {
    expect(await closeOpen(dir, () => undefined, { secrets, credentials: secrets }, 77)).toEqual([]);
    for (let i = 0; i < 3; i++) {
      expect(await listKept(dir)).toEqual([]); expect(await rebuildIndex(dir)).toEqual([]);
      expect(await readKeptRun(dir, "identity")).toBeNull();
      expect(existsSync(join(folder, WIRE))).toBe(true); expect(existsSync(join(folder, RUN_FILE))).toBe(true);
      expect(existsSync(join(folder, ".privacy-rejected"))).toBe(false);
      expect(await readFile(join(dir, INDEX), "utf8")).not.toContain("identity");
    }
    expect(partialAttempts).toBeGreaterThan(1);
  } finally { partial.mockRestore(); }
  expect(await listKept(dir)).toEqual([]); expect(existsSync(folder)).toBe(false);
  expect(await readKeptRun(dir, "identity")).toBeNull();
});


test("merged group routing and priority enum survive a real snapshot with ordinary CANOPY collisions", async () => {
  const dir = join(root, "merged-attribution");
  const value = run({ group: "batch-route", priority: "low", branch: { name: "run/work", target: "main", base: "base", dir: "/owned", state: "ready", origin: "origin", group: "batch-route" }, note: "batch-route low" });
  const log = open(dir, value, { secrets: [{ name: "CANOPY_GROUP", value: "batch-route" }, { name: "CANOPY_PRIORITY", value: "low" }] });
  await log.settle(value);
  expect(await readKeptRun(dir, value.id)).toMatchObject({ group: "batch-route", priority: "low", branch: { group: "batch-route" }, note: "<redacted:CANOPY_GROUP> <redacted:CANOPY_PRIORITY>" });
});

test("merged attribution never exempts private credential collisions", async () => {
  for (const [field, value] of [["group", "batch-route"], ["priority", "low"]] as const) {
    const dir = join(root, `merged-credential-${field}`); const errors: string[] = [];
    const valueRun = run({ [field]: value });
    const log = open(dir, valueRun, { secrets: [{ name: "CANOPY_TOKEN", value }], onError: (why) => errors.push(why) });
    await log.settle(valueRun);
    expect(errors).toHaveLength(1);
    expect(await readKeptRun(dir, valueRun.id)).toBeNull();
  }
});


test("kept snapshots reject malformed merged group and priority fields", async () => {
  const dir = join(root, "merged-invalid"); const value = run();
  const log = open(dir, value); await log.settle(value);
  for (const invalid of [{ group: 42 }, { priority: "urgent" }]) {
    await writeFile(join(log.folder, RUN_FILE), JSON.stringify({ ...value, ...invalid }));
    expect(await readKeptRun(dir, value.id)).toBeNull();
  }
});

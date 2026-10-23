import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SWEPT_DAYS } from "./keep";
import { addSweptChat, appendLog, readAsk, readLastFire, readLog, readSweptChats, sweepDir, takeSweptChat, writeAsk, writeLastFire } from "./sweepstore";
import type { SweepItem, SweepLogEntry, SweptChat } from "./types";

/* The sweep's small store: chats it stopped (so a resume can start from the
 * session) and a short log of its passes. */

let dir = "";
let prev: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-sweepstore-"));
  prev = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = dir;
});

afterEach(async () => {
  if (prev === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = prev;
  await rm(dir, { recursive: true, force: true });
});

const chat = (runId: string, sweptAt = Date.now()): SweptChat => ({
  runId,
  repoId: "r",
  harness: "claude",
  session: `s-${runId}`,
  title: `chat ${runId}`,
  sweptAt,
});

const entry = (at: number): SweepLogEntry => ({ at, by: "eric", outcomes: [], items: [] });

test("a swept chat is stored, listed and taken once", async () => {
  await addSweptChat(chat("a"));
  await addSweptChat(chat("b"));
  expect((await readSweptChats()).map((c) => c.runId)).toEqual(["a", "b"]);
  expect((await takeSweptChat("a"))?.session).toBe("s-a");
  expect(await takeSweptChat("a")).toBeNull();
  expect((await readSweptChats()).map((c) => c.runId)).toEqual(["b"]);
});

test("records older than 14 days are dropped on read", async () => {
  expect(SWEPT_DAYS).toBe(14);
  const day = 24 * 60 * 60 * 1000;
  await addSweptChat(chat("old", Date.now() - (SWEPT_DAYS + 1) * day));
  await addSweptChat(chat("new", Date.now() - (SWEPT_DAYS - 1) * day));
  expect((await readSweptChats()).map((c) => c.runId)).toEqual(["new"]);
});

test("the log keeps the newest 50", async () => {
  for (let i = 1; i <= 55; i++) await appendLog(entry(i));
  const log = await readLog();
  expect(log).toHaveLength(50);
  expect(log[0]?.at).toBe(6);
  expect(log[49]?.at).toBe(55);
});

const put = async (name: string, data: unknown) => {
  await mkdir(sweepDir(), { recursive: true });
  await writeFile(join(sweepDir(), name), typeof data === "string" ? data : JSON.stringify(data));
};

test("a malformed swept chat is dropped on read; the good ones stay and can be taken", async () => {
  const good = chat("ok");
  await put("chats.json", [null, 7, "x", { ...chat("nosession"), session: 3 }, { ...chat("badharness"), harness: "gpt" }, { ...chat("nan"), sweptAt: "soon" }, good]);
  expect(await readSweptChats()).toEqual([good]);
  expect((await takeSweptChat("ok"))?.session).toBe("s-ok");
  await addSweptChat(chat("next"));
  expect((await readSweptChats()).map((c) => c.runId)).toEqual(["next"]);
});

test("a chats file that is not a list reads as none", async () => {
  await put("chats.json", { runId: "a" });
  expect(await readSweptChats()).toEqual([]);
});

test("a log entry without outcomes or items is dropped; a bad outcome or item inside a good entry is left out", async () => {
  const item = { key: "shell:t", kind: "shell", id: "t", repoId: "r", where: "r", title: "shell", idleSince: 1, why: "w", closable: true, checked: true, handOnly: false, auto: true };
  await put("log.json", [
    null,
    { at: 1, by: "eric", items: [] },
    { at: 2, by: "eric", outcomes: "closed", items: [] },
    { at: 3, by: "someone", outcomes: [], items: [] },
    { at: 4, by: "schedule", outcomes: [{ key: "shell:t", result: "closed" }, { key: 5, result: "closed" }, { key: "run:r", result: "exploded" }, null], items: [item, { key: "x" }, null] },
  ]);
  expect(await readLog()).toEqual([{ at: 4, by: "schedule", outcomes: [{ key: "shell:t", result: "closed" }], items: [item] } as SweepLogEntry]);
  await appendLog(entry(5));
  expect((await readLog()).map((e) => e.at)).toEqual([4, 5]);
});

const askItem = (id: string): SweepItem => ({ key: `shell:${id}`, kind: "shell", id, repoId: "r", where: "r", title: "shell", idleSince: 1, why: "running vim, no input or output for 30h", closable: true, checked: false, handOnly: true, auto: false });

test("the ask is stored, read back and cleared", async () => {
  expect(await readAsk()).toBeNull();
  await writeAsk([askItem("a"), askItem("b")]);
  expect(await readAsk()).toEqual([askItem("a"), askItem("b")]);
  await writeAsk(null);
  expect(await readAsk()).toBeNull();
});

test("an item written before handOnly reads as not held; a handOnly that is not a boolean is dropped", async () => {
  const { handOnly: _gone, ...old } = askItem("old");
  await put("ask.json", [old, { ...askItem("bad"), handOnly: "yes" }]);
  expect(await readAsk()).toEqual([{ ...askItem("old"), handOnly: false }]);
});

test("a malformed ask entry is dropped; an ask with none left, or not a list, reads as none", async () => {
  await put("ask.json", [null, { key: "x" }, { ...askItem("bad"), closable: "yes" }, askItem("ok")]);
  expect(await readAsk()).toEqual([askItem("ok")]);
  await put("ask.json", [null, 3]);
  expect(await readAsk()).toBeNull();
  await put("ask.json", { key: "shell:a" });
  expect(await readAsk()).toBeNull();
  await put("ask.json", "not json");
  expect(await readAsk()).toBeNull();
});

test("the last fire is stored and read back; a state file that does not read has none", async () => {
  expect(await readLastFire()).toBeNull();
  await writeLastFire(1234);
  expect(await readLastFire()).toBe(1234);
  for (const bad of [null, [], { lastFire: "soon" }, { lastFire: Number.NaN }, "{"]) {
    await put("state.json", bad === null ? "null" : bad);
    expect(await readLastFire()).toBeNull();
  }
});

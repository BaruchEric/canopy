import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SWEPT_DAYS } from "./keep";
import { addSweptChat, appendLog, readLog, readSweptChats, takeSweptChat } from "./sweepstore";
import type { SweepLogEntry, SweptChat } from "./types";

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

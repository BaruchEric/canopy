import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readApplied, writeApplied } from "../core/applied";
import { Audit } from "./audit";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-audit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the audit log appends at 0600 and reads newest first", async () => {
  let t = Date.parse("2026-10-14T12:00:00.000Z");
  const a = new Audit(join(dir, "audit.jsonl"), () => (t += 1000));
  await a.add({ action: "add", name: "cf_token", ok: true, by: "phone", detail: null });
  await a.add({ action: "reveal", name: "cf_token", ok: false, by: null, detail: "no session" });
  expect((await stat(join(dir, "audit.jsonl"))).mode & 0o777).toBe(0o600);
  const last = await a.last(10);
  expect(last.map((e) => e.action)).toEqual(["reveal", "add"]);
  expect(last[0]?.at).toBe("2026-10-14T12:00:02.000Z");
});

test("a missing audit log reads as empty", async () => {
  expect(await new Audit(join(dir, "none.jsonl")).last(5)).toEqual([]);
});

test("applied stamps round-trip and a missing file is empty", async () => {
  const p = join(dir, "applied.json");
  expect(await readApplied(p)).toEqual({});
  await writeApplied(p, { dns: { CF_TOKEN: "2026-10-14T12:00:00.000Z" } });
  expect(await readApplied(p)).toEqual({ dns: { CF_TOKEN: "2026-10-14T12:00:00.000Z" } });
  expect((await stat(p)).mode & 0o777).toBe(0o600);
});

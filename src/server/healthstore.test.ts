import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_MAX } from "../core/health";
import type { HealthCheck, HealthEvent } from "../core/types";
import { HealthHub, type CheckDef } from "./health";
import { HealthRecords, parseRecords, SETTLE } from "./healthstore";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev = (at: number, state: HealthEvent["state"], why: string | null = null): HealthEvent => ({ at, state, why });

let dirs: string[] = [];
let hubs: HealthHub[] = [];
afterEach(() => {
  for (const h of hubs) h.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  hubs = [];
  dirs = [];
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "canopy-healthstore-"));
  dirs.push(d);
  return join(d, "config", "health-history.json");
}

const check = (id: string, history: HealthEvent[], over: Partial<HealthCheck> = {}): HealthCheck => ({
  id,
  label: id,
  scope: { kind: "canopy" },
  state: history[history.length - 1]?.state ?? "unknown",
  why: null,
  since: history[history.length - 1]?.at ?? 0,
  lastOk: null,
  heal: "none",
  fails: 0,
  nextHeal: null,
  button: false,
  history,
  ...over,
});

function hub(records: HealthRecords) {
  const h = new HealthHub({ broadcast: () => {}, debounce: 5, records });
  hubs.push(h);
  return h;
}

const def = (id: string): CheckDef => ({ id, label: id, scope: { kind: "canopy" }, heal: "none" });

describe("parseRecords", () => {
  test("junk reads as nothing kept", () => {
    expect(parseRecords("not json").size).toBe(0);
    expect(parseRecords("[]").size).toBe(0);
    expect(parseRecords(JSON.stringify({ checks: { a: { history: "x" } } })).size).toBe(0);
  });

  test("a bad event is left out, the rest sorted and cut to the cap", () => {
    const history = [ev(30, "ok"), { at: "x", state: "ok", why: null }, ev(10, "down", "w"), { at: 20, state: "lost", why: null }, { at: 25, state: "ok", why: 4 }];
    const r = parseRecords(JSON.stringify({ checks: { a: { lastOk: 30, history } } })).get("a");
    expect(r).toEqual({ lastOk: 30, history: [ev(10, "down", "w"), ev(30, "ok")] });
    const long = Array.from({ length: HISTORY_MAX + 3 }, (_, i) => ev(i, i % 2 ? "ok" : "down"));
    expect(parseRecords(JSON.stringify({ checks: { a: { lastOk: null, history: long } } })).get("a")?.history).toHaveLength(HISTORY_MAX);
  });
});

describe("HealthRecords", () => {
  test("a save comes back in a new store, the file 0600", async () => {
    const file = scratch();
    await new HealthRecords(file).save([check("a", [ev(10, "ok")], { lastOk: 10 })]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new HealthRecords(file).restore("a")).toEqual({ lastOk: 10, history: [ev(10, "ok")] });
  });

  test("nothing is written while every record stays the same", async () => {
    const file = scratch();
    const store = new HealthRecords(file);
    await store.save([check("a", [ev(10, "ok")])]);
    rmSync(file);
    // a new detail or why changes the broadcast, not the record
    await store.save([check("a", [ev(10, "ok")], { detail: "in 42ms" })]);
    expect(existsSync(file)).toBe(false);
    await store.save([check("a", [ev(10, "ok"), ev(20, "down", "x")])]);
    expect(existsSync(file)).toBe(true);
  });

  test("a check with no record yet writes none", async () => {
    const file = scratch();
    await new HealthRecords(file).save([check("a", [])]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ checks: {} });
  });

  test("a check not added yet keeps its record until the hub settles, then goes", async () => {
    const file = scratch();
    await new HealthRecords(file).save([check("a", [ev(1, "ok")]), check("b", [ev(2, "down", "w")])]);
    let now = 1_000_000;
    const store = new HealthRecords(file, () => now);
    await store.save([check("a", [ev(1, "ok"), ev(3, "down", "x")])]);
    expect(new HealthRecords(file).restore("b")?.history).toEqual([ev(2, "down", "w")]);
    now += SETTLE;
    await store.save([check("a", [ev(1, "ok"), ev(3, "down", "x"), ev(4, "ok")])]);
    expect(new HealthRecords(file).restore("b")).toBeUndefined();
  });
});

describe("the hub over a restart", () => {
  test("a repo's check added after the first write still gets its record back", async () => {
    const file = scratch();
    await new HealthRecords(file).save([check("canopy:a", [ev(1, "ok")]), check("repo:b", [ev(2, "down", "refused")], { lastOk: 1 })]);

    const h = hub(new HealthRecords(file));
    h.add(def("canopy:a"));
    h.report("canopy:a", { state: "down", why: "gone" });
    await sleep(30);
    // the scan brings the repo's check only now
    h.add(def("repo:b"));
    const b = h.get("repo:b");
    expect(b?.state).toBe("unknown");
    expect(b?.lastOk).toBe(1);
    expect(b?.history).toEqual([ev(2, "down", "refused")]);
    h.report("repo:b", { state: "down", why: "refused" });
    expect(h.get("repo:b")?.since).toBe(2);
    expect(h.get("repo:b")?.history).toHaveLength(1);
  });

  test("changes before a stop are there after a start", async () => {
    const file = scratch();
    const first = hub(new HealthRecords(file));
    first.add(def("canopy:a"));
    first.report("canopy:a", { state: "ok" });
    first.report("canopy:a", { state: "down", why: "refused" });
    await sleep(30);
    first.stop();

    const second = hub(new HealthRecords(file));
    second.add(def("canopy:a"));
    expect(second.get("canopy:a")?.history.map((e) => e.state)).toEqual(["ok", "down"]);
    second.report("canopy:a", { state: "ok" });
    expect(second.get("canopy:a")?.history.map((e) => e.state)).toEqual(["ok", "down", "ok"]);
  });

  test("a hub with no store keeps nothing and writes nothing", async () => {
    const file = scratch();
    const h = new HealthHub({ broadcast: () => {}, debounce: 5 });
    hubs.push(h);
    h.add(def("canopy:a"));
    h.report("canopy:a", { state: "ok" });
    await sleep(30);
    expect(existsSync(file)).toBe(false);
  });
});

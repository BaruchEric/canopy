import { afterEach, describe, expect, test } from "bun:test";
import { HEAL_MAX, type HealthTimings, type ProbeResult } from "../core/health";
import type { HealthCheck, ServerEvent } from "../core/types";
import { HealthHub, rangerResult, type CheckDef } from "./health";

const T: HealthTimings = { base: 5, cap: 20, resetAfter: 300_000, healMax: HEAL_MAX };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const canopy = { kind: "canopy" } as const;

let hubs: HealthHub[] = [];
afterEach(() => {
  for (const h of hubs) h.stop();
  hubs = [];
});

function hub(extra: { onGaveUp?: (c: HealthCheck) => void } = {}) {
  const events: ServerEvent[] = [];
  const h = new HealthHub({ broadcast: (ev) => events.push(ev), timings: T, debounce: 5, ...extra });
  hubs.push(h);
  return { h, events };
}

const def = (over: Partial<CheckDef> = {}): CheckDef => ({ id: "canopy:x", label: "x", scope: canopy, heal: "none", ...over });

describe("fed checks", () => {
  test("a report shows in the list", () => {
    const { h } = hub();
    h.add(def());
    h.report("canopy:x", { state: "ok" });
    expect(h.list()).toHaveLength(1);
    expect(h.get("canopy:x")?.state).toBe("ok");
  });

  test("a report for an unknown id is ignored", () => {
    const { h } = hub();
    h.report("nope", { state: "ok" });
    expect(h.list()).toEqual([]);
  });

  test("the event goes out once for two identical reports", async () => {
    const { h, events } = hub();
    h.add(def());
    h.report("canopy:x", { state: "ok" });
    await sleep(20);
    h.report("canopy:x", { state: "ok" });
    await sleep(20);
    expect(events.filter((e) => e.type === "health")).toHaveLength(1);
  });

  test("a heal on a fed check waits for the next report", async () => {
    let heals = 0;
    const { h } = hub();
    h.add(def({ heal: "auto", doHeal: async () => void heals++ }));
    h.report("canopy:x", { state: "down", why: "gone" });
    await sleep(20);
    expect(heals).toBe(1);
    h.report("canopy:x", { state: "down", why: "still" });
    expect(h.get("canopy:x")?.fails).toBe(1);
    await sleep(30);
    expect(heals).toBe(2);
    h.report("canopy:x", { state: "ok" });
    expect(h.get("canopy:x")?.state).toBe("ok");
  });
});

describe("polled checks", () => {
  test("probes at once and then every interval, never two at a time", async () => {
    let calls = 0;
    let running = 0;
    let most = 0;
    const { h } = hub();
    h.add(
      def({
        every: 10,
        probe: async () => {
          calls++;
          running++;
          most = Math.max(most, running);
          await sleep(35);
          running--;
          return { state: "ok" };
        },
      }),
    );
    await sleep(5);
    expect(calls).toBe(1);
    await sleep(100);
    expect(most).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(3);
  });

  test("a hanging probe fails at its timeout, and the next tick still runs", async () => {
    let calls = 0;
    const { h } = hub();
    h.add(
      def({
        every: 30,
        timeout: 10,
        probe: () => {
          calls++;
          return new Promise<ProbeResult>(() => {});
        },
      }),
    );
    await sleep(20);
    expect(h.get("canopy:x")).toMatchObject({ state: "down", why: "timed out" });
    await sleep(40);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("a probe that throws fails with its words", async () => {
    const { h } = hub();
    h.add(
      def({
        every: 1000,
        probe: async () => {
          throw new Error("boom");
        },
      }),
    );
    await sleep(5);
    expect(h.get("canopy:x")).toMatchObject({ state: "down", why: "boom" });
  });
});

describe("healing", () => {
  test("an auto check heals, and comes back", async () => {
    let up = false;
    const { h } = hub();
    h.add(
      def({
        heal: "auto",
        every: 1000,
        probe: async () => (up ? { state: "ok" } : { state: "down", why: "gone" }),
        doHeal: async () => {
          up = true;
        },
      }),
    );
    await sleep(5);
    expect(h.get("canopy:x")?.state).toBe("healing");
    await sleep(30);
    expect(h.get("canopy:x")?.state).toBe("ok");
  });

  test("gives up after HEAL_MAX failed heals and tells once", async () => {
    let heals = 0;
    const told: HealthCheck[] = [];
    const { h } = hub({ onGaveUp: (c) => told.push(c) });
    h.add(
      def({
        heal: "auto",
        every: 10_000,
        probe: async () => ({ state: "down", why: "gone" }),
        doHeal: async () => void heals++,
      }),
    );
    await sleep(200);
    expect(h.get("canopy:x")?.state).toBe("gave-up");
    expect(heals).toBe(HEAL_MAX);
    expect(told).toHaveLength(1);
    await sleep(60);
    expect(heals).toBe(HEAL_MAX);
  });

  test("a heal that throws counts as a failed heal", async () => {
    const { h } = hub();
    h.add(
      def({
        heal: "auto",
        every: 10_000,
        probe: async () => ({ state: "down", why: "gone" }),
        doHeal: async () => {
          throw new Error("no luck");
        },
      }),
    );
    await sleep(15);
    const c = h.get("canopy:x");
    expect(c?.fails).toBeGreaterThanOrEqual(1);
    expect(c?.why).toContain("no luck");
  });

  test("the button heals a check that gave up", async () => {
    let up = false;
    const { h } = hub();
    h.add(def({ heal: "button", every: 10_000, probe: async () => (up ? { state: "ok" } : { state: "down", why: "gone" }), doHeal: async () => void (up = true) }));
    await sleep(5);
    expect(h.get("canopy:x")?.state).toBe("down");
    const after = await h.heal("canopy:x");
    expect(after.state).toBe("ok");
  });

  test("the button refuses an unknown check and one with no heal", async () => {
    const { h } = hub();
    h.add(def({ heal: "self" }));
    await expect(h.heal("nope")).rejects.toMatchObject({ status: 404 });
    await expect(h.heal("canopy:x")).rejects.toMatchObject({ status: 409 });
  });

  test("an auto check with no heal reads as none", () => {
    const { h } = hub();
    h.add(def({ heal: "auto" }));
    expect(h.get("canopy:x")?.heal).toBe("none");
    expect(h.get("canopy:x")?.button).toBe(false);
  });
});

describe("routes", () => {
  test("GET /api/health and POST /api/health/heal", async () => {
    const { h } = hub();
    h.add(def({ heal: "self" }));
    const list = await h.handle(new Request("http://x/api/health"), new URL("http://x/api/health"));
    if (!list) throw new Error("no answer");
    expect(((await list.json()) as { checks: HealthCheck[] }).checks.map((c) => c.id)).toEqual(["canopy:x"]);
    const u = new URL("http://x/api/health/heal?id=canopy:x");
    const res = await h.handle(new Request(u.href, { method: "POST" }), u);
    expect(res?.status).toBe(409);
    const other = new URL("http://x/api/elsewhere");
    expect(await h.handle(new Request(other.href), other)).toBeNull();
  });
});

test("stop leaves nothing running", async () => {
  let calls = 0;
  const { h } = hub();
  h.add(def({ every: 5, probe: async () => (calls++, { state: "ok" }) }));
  await sleep(2);
  h.stop();
  const at = calls;
  await sleep(30);
  expect(calls).toBe(at);
});

describe("rangerResult", () => {
  const r = (state: Parameters<typeof rangerResult>[0]["state"], on = true, why?: string) => rangerResult({ on, state, ...(why ? { why } : {}) });
  test("maps each state", () => {
    expect(r("running")).toEqual({ state: "ok" });
    expect(r("running", false)).toEqual({ state: "off" });
    expect(r("off")).toEqual({ state: "off" });
    expect(r("backoff", true, "waiting 4s")).toEqual({ state: "healing", why: "waiting 4s" });
    expect(r("gave-up").state).toBe("gave-up");
    expect(r("no-tmux").state).toBe("down");
    expect(r("error", true, "bad").state).toBe("down");
  });
});

import { describe, expect, test } from "bun:test";
import type { TriggerEvent } from "../core/trigger";
import { lineText } from "../core/treelines";
import { Unreachable, type ask, type Target } from "./health";
import { DRIFT_USAGE, driftCommand, driftReportLines } from "./drift";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-02T12:00:00Z");

const ev = (over: Partial<TriggerEvent>): TriggerEvent => ({
  id: "e1",
  rule: "spec-weekly",
  source: "schedule",
  service: "schedule",
  key: "web/shop@2026-11-02T05:00:00.000Z",
  short: "2026-11-02",
  title: "spec-converge on shop, 2026-11-02",
  note: "",
  repoId: "web/shop",
  workflow: "spec-converge",
  land: "queue",
  status: "ready",
  count: 1,
  firstAt: NOW - 2 * HOUR,
  lastAt: NOW - HOUR,
  summary: "drift: 2\n- stack: SPEC.md says Vite 8.3.2, bun.lock has 8.4.0\n- commands: SPEC.md lists bun run lint:fix, package.json has no such script",
  ...over,
});

describe("driftReportLines", () => {
  test("no report is no lines", () => {
    expect(driftReportLines({ events: [] }, null, NOW)).toEqual([]);
    expect(driftReportLines({ events: [ev({ summary: undefined })] }, null, NOW)).toEqual([]);
  });

  test("the stale repo first with its items, the clean one only with --all, the fixed one as fixed", () => {
    const events = [
      ev({ id: "a" }),
      ev({ id: "b", repoId: "web/api", status: "no-fix", summary: "drift: none", firstAt: NOW - 3 * HOUR }),
      ev({ id: "c", repoId: "ai/bot", status: "merged", summary: "drift: 1\n- scope: a telemetry folder exists", firstAt: NOW - 26 * HOUR }),
    ];
    expect(driftReportLines({ events }, null, NOW)).toEqual([
      `${"stale".padEnd(18)} web/shop  drift: 2, fix waiting to land  checked 2h ago`,
      "    - stack: SPEC.md says Vite 8.3.2, bun.lock has 8.4.0",
      "    - commands: SPEC.md lists bun run lint:fix, package.json has no such script",
      `${"fixed".padEnd(18)} ai/bot  drift: 1, fix landed  checked 1d ago`,
      "    - scope: a telemetry folder exists",
    ]);
    expect(driftReportLines({ events }, null, NOW, true)).toContain(`${"no drift".padEnd(18)} web/api  drift: none  checked 3h ago`);
    const shop = driftReportLines({ events }, "shop", NOW, true);
    expect(shop).toHaveLength(3);
    expect(shop[0]?.startsWith(`${"stale".padEnd(18)} web/shop`)).toBe(true);
    expect(driftReportLines({ events }, "web/none", NOW, true)).toEqual([]);
    expect(driftReportLines({ events }, "web/api", NOW, true, "mini")[0]).toContain("web/api on mini");
  });

  test("the newest report per repo stands, and a check still running does not hide it", () => {
    const events = [ev({ id: "old", summary: "drift: 1\n- stack: old", firstAt: NOW - 50 * HOUR }), ev({ id: "new", summary: "drift: none", status: "no-fix", firstAt: NOW - HOUR }), ev({ id: "running", summary: undefined, status: "working", firstAt: NOW })];
    expect(driftReportLines({ events }, null, NOW, true)).toEqual([`${"no drift".padEnd(18)} web/shop  drift: none  checked 1h ago`]);
  });
});

describe("driftCommand", () => {
  const out = () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    return { lines, done: () => (console.log = log) };
  };
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  const plain = (line: Parameters<NonNullable<Parameters<typeof driftCommand>[1]["paint"]>>[0]) => lineText(line);

  test("asks every listed backend for its triggers and prints each one's lines", async () => {
    const calls: string[] = [];
    const askFn = (async (t: Target, _method: string, path: string) => {
      calls.push(`${t.name}${path}`);
      if (path === "/api/backends") return { self: "home", backends: [{ name: "mini", tailnet: "http://mini:7850" }] };
      return { rules: [], problems: [], keeping: true, events: t.name === "home" ? [ev({})] : [ev({ repoId: "ai/bot", summary: "drift: none", status: "no-fix" })] };
    }) as typeof ask;
    const o = out();
    try {
      await driftCommand(["--all"], { fail, ask: askFn, now: () => NOW, paint: plain });
    } finally {
      o.done();
    }
    expect(calls).toEqual(["home/api/backends", "home/api/triggers", "mini/api/triggers"]);
    expect(o.lines[0]).toContain("web/shop on home");
    expect(o.lines[3]).toContain("ai/bot on mini");
  });

  test("a backend that does not answer is one line, and nothing found says so", async () => {
    const askFn = (async (_t: Target, _method: string, path: string) => {
      if (path === "/api/backends") throw new Unreachable("refused");
      throw new Unreachable("refused");
    }) as typeof ask;
    const o = out();
    try {
      await driftCommand([], { fail, ask: askFn, now: () => NOW, paint: plain });
    } finally {
      o.done();
    }
    expect(o.lines).toEqual(["home: did not answer: refused", "no spec drift found; a schedule rule running spec-converge writes one per repo"]);
  });

  test("more than a repo and the flags is the usage line", async () => {
    await expect(driftCommand(["a", "b"], { fail, ask: (async () => ({})) as typeof ask })).rejects.toThrow(DRIFT_USAGE);
  });
});

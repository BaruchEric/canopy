import { expect, test } from "bun:test";
import type { ScenarioRun } from "../core/types";
import { listLines, runLines, scenariosCommand } from "./scenarios";

test("listLines", () => {
  expect(listLines("dev-tools/canopy", { names: [{ name: "checkout", kind: "command" }, { name: "refund", kind: "judge" }], errors: [{ file: "x.md" }] })).toEqual([
    "dev-tools/canopy",
    "  checkout         command",
    "  refund           judge",
    "  x.md             unreadable",
  ]);
  expect(listLines("r", { names: [], errors: [] })).toEqual(["no scenarios for r; add one with canopy scenarios r add <name>"]);
});

test("runLines", () => {
  const run: ScenarioRun = { head: "h", at: 1, total: 3, passed: 1, score: 1 / 3, results: [{ name: "a", kind: "command", ok: true, tail: "fine" }, { name: "b", kind: "command", ok: false, tail: "lots\n1 fail" }] };
  expect(runLines(run)).toEqual(["scenarios 1/3 · 0.33", "  ok   a", "  red  b  1 fail"]);
});

/** the command against a fake backend: what it printed, what it posted, and the failure if it failed */
async function drive(argv: string[], answers: Record<string, unknown>) {
  const posted: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      if (req.method === "POST") posted.push(await req.json());
      return p in answers ? Response.json(answers[p], { status: p === "/api/scenarios" ? 201 : 200 }) : Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const lines: string[] = [];
  const log = console.log;
  console.log = (s: string) => { lines.push(s); };
  let failed: string | null = null;
  try {
    await scenariosCommand([...argv, "--backend", `http://127.0.0.1:${server.port}`], { fail: (m) => { throw new Error(m); } });
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
  } finally {
    console.log = log;
    server.stop(true);
  }
  return { lines, posted, failed };
}

test("add with --run and no shell line fails before asking the backend", async () => {
  const got = await drive(["r", "add", "n", "--run"], { "/api/scenarios": { path: "/x/n.md" } });
  expect(got.failed).toBe("--run needs a shell line");
  expect(got.posted).toEqual([]);
  // a flag right after --run is not its shell line
  const before = await drive(["r", "add", "n", "--run", "--judge"], { "/api/scenarios": { path: "/x/n.md" } });
  expect(before.failed).toBe("--run needs a shell line");
  expect(before.posted).toEqual([]);
});

test("add --judge says a judge scenario is listed but not run yet", async () => {
  const got = await drive(["r", "add", "story", "--judge"], { "/api/scenarios": { path: "/x/story.md" } });
  expect(got.failed).toBeNull();
  expect(got.lines).toEqual(["wrote /x/story.md", "judge scenarios are listed but not run until plan 2"]);
  const plain = await drive(["r", "add", "n", "--run", "make n"], { "/api/scenarios": { path: "/x/n.md" } });
  expect(plain.lines).toEqual(["wrote /x/n.md"]);
  expect(plain.posted).toEqual([{ repo: "r", name: "n", run: "make n" }]);
});

test("run on an empty set says there are no scenarios", async () => {
  const empty: ScenarioRun = { head: "h", at: 1, total: 0, passed: 0, score: 1, results: [] };
  const got = await drive(["r", "run"], { "/api/scenarios/run": empty });
  expect(got.failed).toBeNull();
  expect(got.lines).toEqual(["no scenarios for r"]);
});

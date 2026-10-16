import { expect, test } from "bun:test";
import { advance, enqueue } from "../core/landing";
import type { LandingInfo, LandingRun } from "../core/types";
import { queueLines } from "./land";

const rec = (id: string, over: Partial<LandingRun> = {}): LandingRun => ({
  id,
  runId: `r-${id}`,
  repoId: "dev-tools/canopy",
  repoPath: "/dev/dev-tools/canopy",
  branch: `run/x-${id}`,
  target: "main",
  base: "b0",
  dir: `/w/${id}`,
  note: "n",
  verb: "Ask",
  harness: "claude",
  state: "ready",
  startedAt: 1,
  ...over,
});

test("a repo's queue in order, then what came back, then what is ready", () => {
  let entries = enqueue(enqueue(enqueue([], rec("a"), 1), rec("b"), 2), rec("c"), 3);
  entries = entries.map((e) => (e.id === "c" ? advance(e, { t: "red", gate: "test", output: "lots\n1 fail" }, 4) : e.id === "a" ? advance(e, { t: "rebased", setup: false, first: "lint", noGates: false }, 4) : e));
  const info: LandingInfo = { runs: [rec("a"), rec("b"), rec("c"), rec("d"), rec("e", { state: "working" })], entries, orphans: [] };
  expect(queueLines(info, null)).toEqual([
    "dev-tools/canopy",
    "  gate: lint       run/x-a",
    "  queued 2nd       run/x-b",
    "  red: test        run/x-c  test failed",
    "  ready            run/x-d  canopy land r-d",
  ]);
  expect(queueLines(info, "canopy", "mini")[0]).toBe("dev-tools/canopy on mini");
  expect(queueLines(info, "other")).toEqual([]);
});

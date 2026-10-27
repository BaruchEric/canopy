import { expect, test } from "bun:test";
import { advance, enqueue, entryFor } from "../core/landing";
import type { LandingInfo, LandingRun, RunReview } from "../core/types";
import { approveLines, landCommand, queueLines } from "./land";

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
    "  ready            run/x-d  sorting  canopy land r-d",
  ]);
  expect(queueLines(info, "canopy", "mini")[0]).toBe("dev-tools/canopy on mini");
  expect(queueLines(info, "other")).toEqual([]);
});

const sorted = (verdict: RunReview["verdict"], over: Partial<RunReview> = {}): RunReview => ({ verdict, files: [], base: "b0b0b0b0b0b0b0", head: "h1h1h1h1h1h1h1", at: 1, ...over });

test("each ready run's verdict, and an entry that joined on its own", () => {
  const entries = [...enqueue([], rec("a"), 1, { auto: true }), ...enqueue([], rec("b"), 2, { approved: "p1" })];
  const info: LandingInfo = {
    runs: [rec("a"), rec("b"), rec("c", { review: sorted("auto") }), rec("d", { review: sorted("land", { why: "no gates to run" }) }), rec("e", { review: sorted("approve", { files: [{ path: "s.ts", cls: "logic", sensitive: "x" }] }) })],
    entries,
    orphans: [],
  };
  expect(queueLines(info, null)).toEqual([
    "dev-tools/canopy",
    "  queued 1st       run/x-a  joined on its own",
    "  queued 2nd       run/x-b  approved",
    "  ready            run/x-c  lands on its own  canopy land r-c",
    "  ready            run/x-d  needs your land: no gates to run  canopy land r-d",
    "  ready            run/x-e  needs your approval: 1 sensitive file  canopy land r-e",
  ]);
});

test("a run a restart stopped shows as one that can land only when its work is whole", () => {
  const entries = enqueue([], rec("q"), 1);
  const info: LandingInfo = {
    runs: [
      rec("a", { state: "stopped", whole: { ok: true }, review: sorted("land") }),
      rec("b", { state: "stopped", whole: { ok: false, why: "changes left uncommitted" } }),
      rec("c", { state: "stopped" }),
      rec("q", { state: "stopped", whole: { ok: true } }),
    ],
    entries,
    orphans: [],
  };
  expect(queueLines(info, null)).toEqual(["dev-tools/canopy", "  queued 1st       run/x-q", "  stopped          run/x-a  can land: needs your land  canopy land r-a"]);
});

test("what land prints for a run that needs an approval: the files, how to look, the command with the id", () => {
  const review = sorted("approve", {
    sensitiveId: "abc123",
    files: [
      { path: "README.md", cls: "docs" },
      { path: "scripts/go.sh", cls: "logic", sensitive: "matches scripts/** in .canopy/review.json" },
      { path: "tools/x.sh", from: "scripts/x.sh", cls: "logic", why: "renamed from scripts/x.sh", sensitive: "moved from scripts/x.sh: matches scripts/**" },
    ],
  });
  expect(approveLines(rec("a", { review }))).toEqual([
    "run/x-a needs your approval: 2 sensitive files:",
    "  scripts/go.sh  matches scripts/** in .canopy/review.json",
    "  scripts/x.sh -> tools/x.sh  moved from scripts/x.sh: matches scripts/**",
    "look: git -C /w/a diff b0b0b0b0b0b0 h1h1h1h1h1h1 -- scripts/go.sh scripts/x.sh tools/x.sh",
    "then: canopy land r-a --approve abc123",
  ]);
  expect(approveLines(rec("b"))).toEqual(["run/x-b is not sorted yet; try again in a moment"]);
});

test("judge holds name the manual bypass; a low score shows observations", () => {
  const held = advance(entryFor(rec("a"),1),{t:"unjudged",name:"refund",why:"no gateway key"},2);
  const low = advance(entryFor(rec("b"),1),{t:"red",gate:"satisfaction 0.73 < 1",output:"scenario refund: partly\nrefund 42: no"},2);
  const lines = queueLines({runs:[],entries:[held,low],orphans:[]},null);
  expect(lines[1]).toContain("needs a judge");
  expect(lines[1]).toContain("land anyway: canopy land a --skip-judge");
  expect(lines[2]).toContain("satisfaction 0.73 < 1");
  expect(lines[2]).toContain("refund 42: no");
  expect(lines[2]).not.toContain("failed");
});

test("land --skip-judge posts the explicit bypass flag", async () => {
  const posted: unknown[] = [];
  const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:async req => {posted.push(await req.json());return Response.json({...entryFor(rec("a"),1),skipJudge:true});}});
  const log = console.log;
  const lines: string[] = [];
  try {
    console.log = (line: unknown) => {lines.push(String(line));};
    await landCommand("land",["a","--skip-judge","--backend",`http://127.0.0.1:${server.port}`],{fail:message=>{throw Error(message);}});
  } finally {
    console.log=log;
    server.stop(true);
  }
  expect(posted).toEqual([{run:"a",skipJudge:true}]);
  expect(lines.join("\n")).toContain("queued again with the judge scenarios left out");
});

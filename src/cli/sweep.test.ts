import { describe, expect, test } from "bun:test";
import type { SweepItem, SweepKind } from "../core/types";
import { planLines, sweepBody, sweepKeys, sweepTimeoutMs } from "./sweep";

const item = (key: string, kind: SweepItem["kind"], over: Partial<SweepItem> = {}): SweepItem => ({
  key,
  kind,
  id: key,
  repoId: null,
  where: "w",
  title: key,
  idleSince: 0,
  why: "idle",
  closable: true,
  checked: true,
  handOnly: false,
  auto: false,
  ...over,
});

describe("sweepKeys", () => {
  // as the planner makes them: a busy shell is handOnly and unticked, every
  // PR starts unticked, and a draft is handOnly too
  const items = [
    item("s1", "shell"),
    item("c1", "chat"),
    item("r1", "run"),
    item("p1", "pr", { checked: false }),
    item("p2", "pr", { checked: false, handOnly: true }),
    item("s2", "shell", { checked: false, handOnly: true }),
    item("c2", "chat", { closable: false }),
  ];
  test("without kinds: every checked, closable item, so never a PR", () => {
    expect(sweepKeys(items, undefined)).toEqual(["s1", "c1", "r1"]);
  });
  test("with kinds: only those, each one it may close, ticked by default or not", () => {
    expect(sweepKeys(items, ["shell"])).toEqual(["s1"]);
    expect(sweepKeys(items, ["pr", "run"])).toEqual(["r1", "p1"]);
  });
  test("--kind pr closes the PRs that are not drafts", () => {
    expect(sweepKeys(items, ["pr"])).toEqual(["p1"]);
  });
  test("drafts, busy shells and listed-only items are never swept", () => {
    expect(sweepKeys(items, ["shell", "chat", "pr"])).not.toContain("s2");
    expect(sweepKeys(items, ["shell", "chat", "pr"])).not.toContain("p2");
    expect(sweepKeys(items, ["chat"])).not.toContain("c2");
  });
});

describe("planLines", () => {
  test("marks what --yes would close with the kinds given", () => {
    const items = [item("s1", "shell"), item("p1", "pr", { checked: false }), item("p2", "pr", { checked: false, handOnly: true }), item("o1", "outside", { closable: false })];
    const marks = (kinds: SweepKind[] | undefined) => planLines(items, 0, kinds).map((l) => l.slice(0, 3));
    expect(marks(undefined)).toEqual(["[x]", "[ ]", "[ ]", "[-]"]);
    expect(marks(["pr"])).toEqual(["[ ]", "[x]", "[ ]", "[-]"]);
  });
});

describe("sweepKeys, outside items", () => {
  test("an outside item that is not closable is never posted", () => {
    const outside = item("o1", "outside", { closable: false });
    expect(sweepKeys([outside], undefined)).toEqual([]);
    expect(sweepKeys([outside], ["outside"])).toEqual([]);
  });
});

describe("sweepBody", () => {
  test("asks the server to close only what an unticked close may take", () => {
    expect(sweepBody(["pr:o/a#1", "shell:s1"])).toEqual({ keys: ["pr:o/a#1", "shell:s1"], unticked: true });
  });
});

describe("sweepTimeoutMs", () => {
  test("30 s plus 15 s per key, capped at 10 minutes", () => {
    expect(sweepTimeoutMs(1)).toBe(45_000);
    expect(sweepTimeoutMs(10)).toBe(180_000);
    expect(sweepTimeoutMs(1000)).toBe(600_000);
  });
});

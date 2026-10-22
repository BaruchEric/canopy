import { describe, expect, test } from "bun:test";
import type { SweepItem } from "../core/types";
import { sweepKeys, sweepTimeoutMs } from "./sweep";

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
  auto: false,
  ...over,
});

describe("sweepKeys", () => {
  const items = [
    item("s1", "shell"),
    item("c1", "chat"),
    item("r1", "run"),
    item("p1", "pr"),
    item("s2", "shell", { checked: false }),
    item("c2", "chat", { closable: false }),
  ];
  test("without kinds: every checked, closable item but the prs", () => {
    expect(sweepKeys(items, undefined)).toEqual(["s1", "c1", "r1"]);
  });
  test("with kinds: only those, and pr only when named", () => {
    expect(sweepKeys(items, ["shell"])).toEqual(["s1"]);
    expect(sweepKeys(items, ["pr", "run"])).toEqual(["r1", "p1"]);
  });
  test("drafts and listed-only items are never swept", () => {
    expect(sweepKeys(items, ["shell", "chat"])).not.toContain("s2");
    expect(sweepKeys(items, ["chat"])).not.toContain("c2");
  });
});

describe("sweepKeys, outside items", () => {
  test("an outside item that is not closable is never posted", () => {
    const outside = item("o1", "outside", { closable: false });
    expect(sweepKeys([outside], undefined)).toEqual([]);
    expect(sweepKeys([outside], ["outside"])).toEqual([]);
  });
});

describe("sweepTimeoutMs", () => {
  test("30 s plus 15 s per key, capped at 10 minutes", () => {
    expect(sweepTimeoutMs(1)).toBe(45_000);
    expect(sweepTimeoutMs(10)).toBe(180_000);
    expect(sweepTimeoutMs(1000)).toBe(600_000);
  });
});

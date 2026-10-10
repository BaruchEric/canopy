import { describe, expect, test } from "bun:test";
import { eachOf, keptByBackend, newestFirst, restorePlan, stillPicked } from "./kept";
import type { KeptShell } from "../../src/core/types";

const shell = (id: string, savedAt: number, agent: KeptShell["agent"] = null): KeptShell => ({
  id,
  repoId: "dev-tools/canopy",
  path: "/home/eric/dev/dev-tools/canopy",
  place: "strip",
  startedAt: 0,
  savedAt,
  lines: 10,
  agent,
});

const owner = (id: string): string => (id.startsWith("mac|") ? "mac" : "mini");

describe("newestFirst", () => {
  test("sorts across backends by when each was saved", () => {
    const list = [shell("mac|a", 100), shell("mac|b", 300), shell("c", 200)];
    expect(newestFirst(list).map((k) => k.id)).toEqual(["mac|b", "c", "mac|a"]);
  });
  test("leaves the list it was given alone", () => {
    const list = [shell("a", 1), shell("b", 2)];
    newestFirst(list);
    expect(list.map((k) => k.id)).toEqual(["a", "b"]);
  });
});

describe("keptByBackend", () => {
  test("counts each backend's shells in first-seen order", () => {
    const list = [shell("x", 1), shell("mac|a", 2), shell("mac|b", 3), shell("y", 4)];
    expect(keptByBackend(list, owner)).toEqual([
      { name: "mini", count: 2 },
      { name: "mac", count: 2 },
    ]);
  });
  test("is empty with nothing kept", () => {
    expect(keptByBackend([], owner)).toEqual([]);
  });
});

describe("stillPicked", () => {
  test("drops picks that left the list and keeps the list's order", () => {
    const list = [shell("a", 1), shell("b", 2), shell("c", 3)];
    expect(stillPicked(list, new Set(["c", "gone", "a"])).map((k) => k.id)).toEqual(["a", "c"]);
  });
});

describe("restorePlan", () => {
  const list = [shell("a", 1, "claude"), shell("b", 2), shell("c", 3, "codex")];
  test("continues only the shells that had an agent", () => {
    expect(restorePlan(list, true)).toEqual([
      { id: "a", resume: true },
      { id: "b", resume: false },
      { id: "c", resume: true },
    ]);
  });
  test("a plain restore continues none", () => {
    expect(restorePlan(list, false).every((p) => !p.resume)).toBe(true);
  });
});

describe("eachOf", () => {
  test("runs every id in order and says nothing when all pass", async () => {
    const seen: string[] = [];
    expect(await eachOf(["a", "b"], async (id) => void seen.push(id))).toBeNull();
    expect(seen).toEqual(["a", "b"]);
  });
  test("keeps going past a failure and counts them", async () => {
    const seen: string[] = [];
    const out = await eachOf(["a", "b", "c"], async (id) => {
      seen.push(id);
      if (id !== "b") throw new Error(`no ${id}`);
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(out).toBe("2 of 3 failed: no a");
  });
  test("one id's failure is its own message", async () => {
    expect(
      await eachOf(["a"], async () => {
        throw new Error("gone");
      }),
    ).toBe("gone");
  });
});

import { describe, expect, test } from "bun:test";
import type { GrepHit } from "../../src/core/types";
import { groupHits, markHit } from "./hits";

const hit = (file: string, line: number, col = 1, text = "x"): GrepHit => ({
  file,
  line,
  col,
  text,
});

describe("groupHits", () => {
  test("one group per file, files in the order first seen, hits kept in order", () => {
    const groups = groupHits([hit("b.ts", 3), hit("a.ts", 1), hit("b.ts", 9)]);
    expect(groups.map((g) => g.file)).toEqual(["b.ts", "a.ts"]);
    expect(groups[0]?.hits.map((h) => h.line)).toEqual([3, 9]);
  });

  test("no hits is no groups", () => {
    expect(groupHits([])).toEqual([]);
  });
});

describe("markHit", () => {
  test("splits the line into before, match and after around the column", () => {
    expect(markHit("const needle = 1;", 7, 6)).toEqual({
      before: "const ",
      match: "needle",
      after: " = 1;",
    });
  });

  test("a match at column 1 has nothing before it", () => {
    expect(markHit("needle", 1, 6)).toEqual({ before: "", match: "needle", after: "" });
  });

  test("a column past the end marks nothing rather than throwing", () => {
    expect(markHit("short", 40, 3)).toEqual({ before: "short", match: "", after: "" });
  });
});

import { describe, expect, test } from "bun:test";
import { clipLine, grepArgs, mapPool, parseGrep } from "./search";

const OUT = [
  "src/core/exec.ts\x002\x0010\x00import { parseLocator } from \"./host\";\n",
  "src/core/exec.ts\x0070\x0026\x00  const { host, path } = parseLocator(repoPath);\n",
  "README.md\x001\x001\x00parseLocator is the entry\n",
].join("");

describe("grepArgs", () => {
  test("a fixed-string, case-insensitive, line-and-column search of tracked text files", () => {
    expect(grepArgs("needle")).toEqual([
      "grep",
      "-n",
      "-I",
      "--column",
      "-z",
      "-i",
      "-F",
      "-e",
      "needle",
      "--",
    ]);
  });

  test("a query starting with a dash rides behind -e, never as a flag", () => {
    expect(grepArgs("-rf")).toContain("-e");
    expect(grepArgs("-rf").indexOf("-rf")).toBe(grepArgs("-rf").indexOf("-e") + 1);
  });
});

describe("parseGrep", () => {
  test("reads path, line, column and text out of the -z records", () => {
    expect(parseGrep(OUT, 10)).toEqual({
      hits: [
        { file: "src/core/exec.ts", line: 2, col: 10, text: 'import { parseLocator } from "./host";' },
        { file: "src/core/exec.ts", line: 70, col: 24, text: "const { host, path } = parseLocator(repoPath);" },
        { file: "README.md", line: 1, col: 1, text: "parseLocator is the entry" },
      ],
      truncated: false,
    });
  });

  test("stops at the limit and says so", () => {
    const r = parseGrep(OUT, 2);
    expect(r.hits.length).toBe(2);
    expect(r.truncated).toBe(true);
  });

  test("empty output is no hits", () => {
    expect(parseGrep("", 10)).toEqual({ hits: [], truncated: false });
  });

  test("leading indentation is dropped and the column moves with it", () => {
    const out = "a.ts\x005\x0013\x00        foo(needle);\n";
    expect(parseGrep(out, 10).hits[0]).toEqual({ file: "a.ts", line: 5, col: 5, text: "foo(needle);" });
  });

  test("a path with a colon and spaces survives, since -z keeps it verbatim", () => {
    const out = "docs/a: b.md\x003\x001\x00x\n";
    expect(parseGrep(out, 10).hits[0]?.file).toBe("docs/a: b.md");
  });
});

describe("clipLine", () => {
  test("a short line is returned as is with the column unchanged", () => {
    expect(clipLine("hello world", 7, 40)).toEqual({ text: "hello world", col: 7 });
  });

  test("a long line is cut around the match and the column moves with it", () => {
    const text = `${"a".repeat(300)}needle${"b".repeat(300)}`;
    const r = clipLine(text, 301, 80);
    expect(r.text.length).toBeLessThanOrEqual(82);
    expect(r.text.slice(r.col - 1, r.col - 1 + 6)).toBe("needle");
    expect(r.text.startsWith("…")).toBe(true);
    expect(r.text.endsWith("…")).toBe(true);
  });

  test("a match near the start keeps the head of the line", () => {
    const text = `needle${"b".repeat(300)}`;
    const r = clipLine(text, 1, 80);
    expect(r.text.startsWith("needle")).toBe(true);
    expect(r.col).toBe(1);
  });
});

describe("mapPool", () => {
  test("runs every job, at most `n` at once, and keeps the input order", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapPool([5, 1, 3, 2, 4], 2, async (ms: number) => {
      running++;
      peak = Math.max(peak, running);
      await Bun.sleep(ms);
      running--;
      return ms * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });
});

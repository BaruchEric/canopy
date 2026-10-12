import { describe, expect, test } from "bun:test";
import { ansiLines, applySgr, color256, trimTail } from "./ansi";

describe("ansiLines", () => {
  test("plain text is one run a line", () => {
    expect(ansiLines("a\nbc\n")).toEqual([[{ text: "a" }], [{ text: "bc" }]]);
  });

  test("colours and bold become runs, and a reset ends them", () => {
    expect(ansiLines("\x1b[1;32mok\x1b[0m done")).toEqual([[{ text: "ok", bold: true, fg: "var(--moss)" }, { text: " done" }]]);
  });

  test("bright colours take the theme's bright slots", () => {
    expect(ansiLines("\x1b[90mx")).toEqual([[{ text: "x", fg: "var(--ink-faint)" }]]);
  });

  test("256 colours and true colour, in either separator", () => {
    expect(ansiLines("\x1b[38;5;196mr\x1b[38;2;10;20;30mt\x1b[48:2::1:2:3mb")).toEqual([
      [
        { text: "r", fg: "rgb(255 0 0)" },
        { text: "t", fg: "rgb(10 20 30)" },
        { text: "b", fg: "rgb(10 20 30)", bg: "rgb(1 2 3)" },
      ],
    ]);
  });

  test("other escapes go: cursor moves, titles, carriage returns", () => {
    expect(ansiLines("\x1b]0;title\x07a\x1b[2Kb\r\x1b(Bc")).toEqual([[{ text: "abc" }]]);
  });

  test("a style runs on across lines until reset", () => {
    expect(ansiLines("\x1b[31ma\nb")).toEqual([[{ text: "a", fg: "var(--rust)" }], [{ text: "b", fg: "var(--rust)" }]]);
  });
});

describe("applySgr", () => {
  test("22 drops bold and dim, 39 the colour", () => {
    expect(applySgr({ bold: true, dim: true, fg: "x" }, "22;39")).toEqual({});
  });

  test("an empty parameter list resets", () => {
    expect(applySgr({ bold: true }, "")).toEqual({});
  });
});

describe("color256", () => {
  test("the cube and the greys", () => {
    expect(color256(16)).toBe("rgb(0 0 0)");
    expect(color256(231)).toBe("rgb(255 255 255)");
    expect(color256(232)).toBe("rgb(8 8 8)");
    expect(color256(300)).toBeUndefined();
  });
});

describe("trimTail", () => {
  test("blank lines at the end go, a coloured blank stays", () => {
    const lines = ansiLines("a\n  \n\x1b[41m \x1b[0m\n\n");
    expect(trimTail(lines)).toHaveLength(3);
    expect(trimTail(ansiLines("a\n \n"))).toHaveLength(1);
  });
});

import { describe, expect, test } from "bun:test";
import { parseTermMessage, shellArgs, termEnv, termSize, TERM_SIZE } from "./term";

describe("termSize", () => {
  test("defaults when nothing is given", () => {
    expect(termSize(undefined, null)).toEqual({ cols: TERM_SIZE.cols, rows: TERM_SIZE.rows });
  });
  test("reads query-string numbers and floors them", () => {
    expect(termSize("132", "41.9")).toEqual({ cols: 132, rows: 41 });
  });
  test("clamps the absurd and rejects the unparseable", () => {
    expect(termSize(0, 10_000)).toEqual({ cols: TERM_SIZE.min, rows: TERM_SIZE.max });
    expect(termSize("wide", NaN)).toEqual({ cols: TERM_SIZE.cols, rows: TERM_SIZE.rows });
  });
});

describe("shellArgs", () => {
  test("a folder here gets the login interactive shell", () => {
    expect(shellArgs("/Users/me/dev/app", "/bin/zsh")).toEqual(["/bin/zsh", "-l", "-i"]);
  });
  test("a folder elsewhere gets the ssh session a terminal tab would", () => {
    const args = shellArgs("ssh://mini/home/me/app", "/bin/zsh");
    expect(args.slice(0, 4)).toEqual(["ssh", "-t", "--", "mini"]);
    expect(args[4]).toContain("cd '/home/me/app' && ");
    expect(args[4]).toContain('exec "$SHELL" -l');
  });
});

describe("parseTermMessage", () => {
  test("a resize", () => {
    expect(parseTermMessage('{"resize":{"cols":100,"rows":30}}')).toEqual({
      kind: "resize",
      size: { cols: 100, rows: 30 },
    });
  });
  test("anything else is ignored", () => {
    expect(parseTermMessage("not json")).toBeNull();
    expect(parseTermMessage("null")).toBeNull();
    expect(parseTermMessage('{"input":"ls"}')).toBeNull();
    expect(parseTermMessage('{"resize":"big"}')).toBeNull();
  });
});

describe("termEnv", () => {
  test("keeps the base, drops the undefined, and declares a color terminal", () => {
    const env = termEnv({ HOME: "/Users/me", TERM: "dumb", GONE: undefined });
    expect(env).toEqual({ HOME: "/Users/me", TERM: "xterm-256color", COLORTERM: "truecolor" });
  });
});

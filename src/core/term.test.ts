import { describe, expect, test } from "bun:test";
import { isTermId, parseTermMessage, Scrollback, shellArgs, termEnv, termPlace, termSize, TERM_SIZE } from "./term";

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

describe("isTermId", () => {
  test("32 hex digits, nothing else", () => {
    expect(isTermId("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isTermId("0123456789ABCDEF0123456789abcdef")).toBe(false);
    expect(isTermId("0123456789abcdef")).toBe(false);
    expect(isTermId("t12")).toBe(false);
    expect(isTermId(12)).toBe(false);
    expect(isTermId(null)).toBe(false);
  });
});

describe("termPlace", () => {
  test("the panel when asked, the strip otherwise", () => {
    expect(termPlace("panel")).toBe("panel");
    expect(termPlace("strip")).toBe("strip");
    expect(termPlace("window")).toBe("strip");
    expect(termPlace(null)).toBe("strip");
  });
});

describe("Scrollback", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const text = (b: Uint8Array) => new TextDecoder().decode(b);

  test("keeps what it is given, in order", () => {
    const sb = new Scrollback(100);
    sb.push(bytes("one "));
    sb.push(bytes("two "));
    sb.push(bytes("three"));
    expect(text(sb.bytes())).toBe("one two three");
    expect(sb.size).toBe(13);
  });
  test("drops the oldest chunks whole once over the cap", () => {
    const sb = new Scrollback(10);
    sb.push(bytes("aaaa"));
    sb.push(bytes("bbbb"));
    sb.push(bytes("cccc"));
    expect(text(sb.bytes())).toBe("bbbbcccc");
    expect(sb.size).toBe(8);
  });
  test("one chunk over the cap on its own keeps its tail", () => {
    const sb = new Scrollback(4);
    sb.push(bytes("xx"));
    sb.push(bytes("abcdefgh"));
    expect(text(sb.bytes())).toBe("efgh");
    // the oldest chunk goes out whole, so a push over the cap leaves the new one
    sb.push(bytes("i"));
    expect(text(sb.bytes())).toBe("i");
  });
  test("empty chunks and an empty buffer", () => {
    const sb = new Scrollback(4);
    sb.push(new Uint8Array(0));
    expect(sb.size).toBe(0);
    expect(sb.bytes()).toEqual(new Uint8Array(0));
  });
});

import { describe, expect, test } from "bun:test";
import { isKeystroke, isTermId, parseTermMessage, Scrollback, shellArgs, spawnOnPty, termEnv, termPlace, termSize, TERM_SIZE } from "./term";

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

describe("spawnOnPty", () => {
  // The process on the pty is not its session's foreground group (a tmux
  // client is not), so the kernel's SIGWINCH on a resize never reaches it
  // and it keeps drawing at the size it started with.
  test("a resize reaches the process on the pty", async () => {
    let out = "";
    const session = spawnOnPty(
      { argv: ["sh", "-c", 'trap "stty size" WINCH; echo ready; while :; do sleep 0.05; done'] },
      { cols: 80, rows: 24 },
      { data: (chunk) => (out += new TextDecoder().decode(chunk)), exit: () => {} },
    );
    try {
      const until = async (s: string) => {
        for (let i = 0; i < 100 && !out.includes(s); i++) await Bun.sleep(20);
        return out.includes(s);
      };
      expect(await until("ready")).toBe(true);
      session.resize({ cols: 132, rows: 41 });
      expect(await until("41 132")).toBe(true);
    } finally {
      session.close();
    }
  });
});

describe("isKeystroke", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  test("typing, keys and the mouse are a person", () => {
    for (const k of ["a", "ls\r", "\x1b[A", "\x03", "\x1b[<0;10;5M", "\x1b[?1;2cx"]) expect(isKeystroke(enc(k))).toBe(true);
  });
  test("a terminal answering a query is not", () => {
    for (const r of ["\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[12;40R", "\x1b[?2004;2$y", "\x1b[I", "\x1b[O", "\x1b]11;rgb:1e1e/1e1e/1e1e\x07", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\", "\x1bP>|xterm.js(6.0.0)\x1b\\", "\x1b[?1;2c\x1b[I", ""]) {
      expect(isKeystroke(enc(r))).toBe(false);
    }
  });
  test("xterm 6's status report and its DEC cursor report are the terminal too", () => {
    // DSR 5 ("terminal OK") and DECXCPR (CSI ? 6 n answered with the page)
    for (const r of ["\x1b[0n", "\x1b[?12;40R", "\x1b[?12;40;1R", "\x1b[0n\x1b[?3;1R\x1b[I"]) {
      expect(isKeystroke(enc(r))).toBe(false);
    }
  });
});

test("termEnv keeps canopy's answer token out of a shell", () => {
  expect(termEnv({ CANOPY_TAILCHAN_ANSWER_TOKEN: "s", HOME: "/h" })).toEqual({ HOME: "/h", TERM: "xterm-256color", COLORTERM: "truecolor" });
});

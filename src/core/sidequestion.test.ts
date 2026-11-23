import { describe, expect, test } from "bun:test";
import { sideMessage, sideNote, sideQuestion, sideRefusal, withoutSideWord, withSideWord, type SideParent } from "./sidequestion";

describe("sideQuestion", () => {
  test("a message whose first word is btw is one, and the rest is the question", () => {
    expect(sideQuestion("btw what does retryBackoff default to")).toBe("what does retryBackoff default to");
    expect(sideQuestion("btw, where is the port set?")).toBe("where is the port set?");
    expect(sideQuestion("btw: which test covers this")).toBe("which test covers this");
    expect(sideQuestion("btw,no space after the comma")).toBe("no space after the comma");
  });

  test("the word is taken in any case, and after leading space", () => {
    expect(sideQuestion("BTW what is this")).toBe("what is this");
    expect(sideQuestion("Btw what is this")).toBe("what is this");
    expect(sideQuestion("  \n btw what is this")).toBe("what is this");
  });

  test("the question keeps its own lines", () => {
    expect(sideQuestion("btw two things:\n1. the port\n2. the host\n")).toBe("two things:\n1. the port\n2. the host");
    expect(sideQuestion("btw\nwhat is the port")).toBe("what is the port");
  });

  test("the word with its space and nothing after is one with no question yet", () => {
    expect(sideQuestion("btw ")).toBe("");
    expect(sideQuestion("btw,")).toBe("");
    expect(sideQuestion("btw:  ")).toBe("");
  });

  test("the word alone, a longer word, or the word further in is none", () => {
    expect(sideQuestion("btw")).toBeNull();
    expect(sideQuestion("btween the lines")).toBeNull();
    expect(sideQuestion("btw.")).toBeNull();
    expect(sideQuestion("btw? no")).toBeNull();
    expect(sideQuestion("fix it, btw the port is wrong")).toBeNull();
    expect(sideQuestion("")).toBeNull();
    expect(sideQuestion("what does btw mean")).toBeNull();
  });
});

describe("the box's button", () => {
  test("puts the word in front of what is typed", () => {
    expect(withSideWord("what is the port")).toBe("btw what is the port");
    expect(withSideWord("")).toBe("btw ");
    expect(withSideWord("  what is the port")).toBe("btw what is the port");
    expect(sideQuestion(withSideWord("what is the port"))).toBe("what is the port");
  });

  test("leaves a side question as it is, and makes the word alone one", () => {
    expect(withSideWord("btw, what is the port")).toBe("btw, what is the port");
    expect(withSideWord("btw")).toBe("btw ");
    expect(withSideWord("BTW")).toBe("btw ");
  });

  test("takes the word off again", () => {
    expect(withoutSideWord("btw what is the port")).toBe("what is the port");
    expect(withoutSideWord("btw, what is\nthe port")).toBe("what is\nthe port");
    expect(withoutSideWord("btw ")).toBe("");
    expect(withoutSideWord("what is the port")).toBe("what is the port");
  });
});

describe("sideRefusal", () => {
  const run = (over: Partial<SideParent> = {}): SideParent => ({ status: "working", action: "ask", session: "s-1", ...over });

  test("a run that is going and has a session takes one, mid-turn or between turns or waiting", () => {
    expect(sideRefusal(run())).toBeNull();
    expect(sideRefusal(run({ status: "idle", action: "chat" }))).toBeNull();
    expect(sideRefusal(run({ status: "waiting" }))).toBeNull();
  });

  test("an ended run, or a kept record of one, takes none", () => {
    for (const status of ["done", "failed", "stopped", "limited"] as const) {
      expect(sideRefusal(run({ status }))).toContain("the run has ended");
    }
    expect(sideRefusal(run({ kept: true }))).toContain("the run has ended");
  });

  test("a run with no session yet takes none", () => {
    expect(sideRefusal({ status: "idle", action: "chat" })).toBe("the run has no session to fork yet: ask once it has begun");
  });

  test("a coordinator takes none, and a side question takes none of its own", () => {
    expect(sideRefusal(run({ action: "coordinate" }))).toBe("a coordinator takes no side question");
    expect(sideRefusal(run({ sideOf: { run: "p", title: "the parent" } }))).toContain("a side question already");
  });
});

describe("what the forked session is told", () => {
  test("that it is a side question, that the run works on, to change nothing unasked, and the question last", () => {
    const m = sideMessage("  what does retryBackoff default to?\n");
    expect(m).toContain("This is a side question.");
    expect(m).toContain("still at work in this folder");
    expect(m).toContain("Do not carry on the run's task");
    expect(m).toContain("is still running in the run you were forked from");
    expect(m).toContain("Change no file");
    expect(m.endsWith("The side question:\nwhat does retryBackoff default to?")).toBe(true);
  });

  test("the side thread's first note names the run it started from", () => {
    expect(sideNote("migrate checkout")).toBe('a side question beside "migrate checkout", on a fork of its session as it stood; that run got no message and works on');
  });
});

test("Antigravity side questions refuse session forks", () => {
  expect(sideRefusal({ harness: "antigravity", status: "working", action: "ask", session: "s-1" })).toContain("Antigravity session forking");
});

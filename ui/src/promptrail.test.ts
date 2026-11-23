import { describe, expect, test } from "bun:test";
import type { RunStep } from "../../src/core/types";
import { FOLLOW_SLACK, RAIL_LABEL, RAIL_REPLY, boxIsEmpty, cardSlide, firstWords, jumpTop, pickRail, railItems, railMarked, railPlace, railStep, tickLabel, type RailSeat } from "./promptrail";

const steps: RunStep[] = [
  { id: "u1", at: 1000, kind: "user", text: "look at\n  the top bar" },
  { id: "n1", at: 1100, kind: "note", text: "canopy's own remark" },
  { id: "t1", at: 1200, kind: "tool", tool: { name: "Agent", title: "read TopBar.tsx", status: "ok" } },
  { id: "k1", at: 1300, kind: "text", text: "a subagent's words", parent: "t1" },
  { id: "a1", at: 1400, kind: "text", text: "It wraps at 344px.\n\nThe mic is the widest button." },
  { id: "a2", at: 1500, kind: "text", text: "Fixed." },
  { id: "u2", at: 2000, kind: "user", text: "and on a tablet?" },
  { id: "u3", at: 2100, kind: "user", text: "the Fold, I mean" },
  { id: "t2", at: 2200, kind: "tool", tool: { name: "Bash", title: "bun test", status: "running" } },
];

describe("railItems", () => {
  test("one item per message, in order, with its place and first words", () => {
    expect(railItems(steps).map((i) => [i.id, i.n, i.label])).toEqual([
      ["u1", 1, "look at the top bar"],
      ["u2", 2, "and on a tablet?"],
      ["u3", 3, "the Fold, I mean"],
    ]);
  });

  test("the reply is the agent's first words before the next message, never a note, a tool or a subagent's", () => {
    const [first, second, third] = railItems(steps);
    expect(first?.reply).toBe("It wraps at 344px. The mic is the widest button.");
    // a message sent before the agent spoke, and one it is still working on
    expect(second?.reply).toBe("");
    expect(third?.reply).toBe("");
  });

  test("words said before the first message belong to no item, and no message gives no rail", () => {
    const early: RunStep[] = [{ id: "a0", at: 1, kind: "text", text: "hello" }, ...steps.slice(0, 1)];
    expect(railItems(early)).toEqual([{ id: "u1", n: 1, label: "look at the top bar", reply: "" }]);
    expect(railItems([])).toEqual([]);
    expect(railItems(steps.filter((s) => s.kind !== "user"))).toEqual([]);
  });

  test("a long message and a long reply are cut to the card's room", () => {
    const long = "word ".repeat(80);
    const [item] = railItems([
      { id: "u", at: 1, kind: "user", text: long },
      { id: "a", at: 2, kind: "text", text: long },
    ]);
    expect(item?.label.length).toBeLessThanOrEqual(RAIL_LABEL);
    expect(item?.label.endsWith("word…")).toBe(true);
    expect(item?.reply.length).toBeLessThanOrEqual(RAIL_REPLY);
    expect(item?.reply.endsWith("…")).toBe(true);
  });

  test("hundreds of steps stay one pass", () => {
    const many: RunStep[] = [];
    for (let i = 0; i < 96; i++) {
      many.push({ id: `u${i}`, at: i * 10, kind: "user", text: `message ${i + 1}` });
      for (let j = 0; j < 6; j++) many.push({ id: `t${i}-${j}`, at: i * 10 + j, kind: "tool", tool: { name: "Bash", title: "ls", status: "ok" } });
      many.push({ id: `a${i}`, at: i * 10 + 8, kind: "text", text: `reply ${i + 1}` });
    }
    const items = railItems(many);
    expect(items).toHaveLength(96);
    expect(items[48]).toEqual({ id: "u48", n: 49, label: "message 49", reply: "reply 49" });
  });
});

test("firstWords puts text on one line and cuts at a word when one is near", () => {
  expect(firstWords("  one\n\ttwo  ", 20)).toBe("one two");
  expect(firstWords("alpha beta gamma delta", 12)).toBe("alpha beta…");
  // no space near the cut: the word itself is cut
  expect(firstWords("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghi…");
  expect(firstWords("exactly ten", 11)).toBe("exactly ten");
});

test("railPlace and tickLabel say the place, then the words", () => {
  expect(railPlace(49, 96)).toBe("49 of 96");
  expect(tickLabel({ n: 3, label: "fix the top bar" }, 12)).toBe("Message 3 of 12: fix the top bar");
  expect(tickLabel({ n: 3, label: "" }, 12)).toBe("Message 3 of 12");
});

describe("railMarked", () => {
  const at = (passed: number, atEnd = false, held: number | null = null) => railMarked({ total: 12, passed, atEnd, held });

  test("the last message that reached the reading line is the one in view", () => {
    expect(at(5)).toBe(4);
    expect(at(12)).toBe(11);
  });

  test("before any has reached it, the first", () => {
    expect(at(0)).toBe(0);
  });

  test("at the end of the timeline, the newest, wherever it sits", () => {
    expect(at(10, true)).toBe(11);
  });

  test("a jump's target wins while it is held, unless it is no longer a message", () => {
    expect(at(10, true, 3)).toBe(3);
    expect(at(10, false, 40)).toBe(9);
    expect(at(10, false, -1)).toBe(9);
  });

  test("no messages, no mark", () => {
    expect(railMarked({ total: 0, passed: 0, atEnd: true, held: null })).toBe(-1);
  });
});

describe("railStep", () => {
  const step = (marked: number, dir: 1 | -1, above = false) => railStep({ marked, dir, total: 12, above });

  test("the message before and the one after", () => {
    expect(step(5, -1)).toBe(4);
    expect(step(5, 1)).toBe(6);
  });

  test("back from a message that scrolled out above goes to its top first", () => {
    expect(step(5, -1, true)).toBe(5);
    expect(step(5, 1, true)).toBe(6);
  });

  test("the first message is as far back as it goes, and past the last is the newest step", () => {
    expect(step(0, -1)).toBe(0);
    expect(step(11, 1)).toBe("end");
    expect(step(40, 1)).toBe("end");
    expect(railStep({ marked: 0, dir: 1, total: 0, above: false })).toBeNull();
  });
});

test("jumpTop keeps a jump inside the timeline and follows the newest step only from its end", () => {
  expect(jumpTop(400, 2000)).toEqual({ top: 400, follow: false });
  expect(jumpTop(-20, 2000)).toEqual({ top: 0, follow: false });
  // the last message cannot reach the top: the jump lands at the end and the timeline follows again
  expect(jumpTop(2600, 2000)).toEqual({ top: 2000, follow: true });
  expect(jumpTop(2000 - FOLLOW_SLACK + 1, 2000).follow).toBe(true);
  expect(jumpTop(2000 - FOLLOW_SLACK, 2000).follow).toBe(false);
  // a timeline too short to scroll is always at its end
  expect(jumpTop(120, -30)).toEqual({ top: 0, follow: true });
});

test("cardSlide keeps a tick's card inside the rail: none at the top, all at the foot", () => {
  expect(cardSlide(0, 400)).toBe(0);
  expect(cardSlide(200, 400)).toBe(50);
  expect(cardSlide(400, 400)).toBe(100);
  expect(cardSlide(900, 400)).toBe(100);
  expect(cardSlide(10, 0)).toBe(50);
});

describe("pickRail", () => {
  const seat = (over: Partial<RailSeat> = {}): RailSeat => ({ shown: true, modal: false, focus: 0, pointed: false, ...over });

  test("the only rail drawn, and none when none is", () => {
    expect(pickRail([seat()])).toBe(0);
    expect(pickRail([seat({ shown: false }), seat()])).toBe(1);
    expect(pickRail([seat({ shown: false })])).toBe(-1);
    expect(pickRail([])).toBe(-1);
  });

  test("the sheet over the page beats the docked chats under it", () => {
    expect(pickRail([seat({ focus: 9, pointed: true }), seat({ modal: true })])).toBe(1);
  });

  test("the timeline that holds the focus, the deepest when one sits inside another's box", () => {
    expect(pickRail([seat(), seat({ focus: 7 }), seat({ pointed: true })])).toBe(1);
    expect(pickRail([seat({ modal: true, focus: 7 }), seat({ modal: true, focus: 9 })])).toBe(1);
  });

  test("with no focus in any, the one last pointed at, else the first", () => {
    expect(pickRail([seat(), seat({ pointed: true })])).toBe(1);
    expect(pickRail([seat(), seat()])).toBe(0);
  });
});

describe("boxIsEmpty", () => {
  test("a message box gives the keys to the rail only while it holds no words", () => {
    expect(boxIsEmpty("")).toBe(true);
    // a stray space or a blank line is no draft
    expect(boxIsEmpty("  \n\t")).toBe(true);
    expect(boxIsEmpty("half a thought")).toBe(false);
    expect(boxIsEmpty("\n a")).toBe(false);
  });
});

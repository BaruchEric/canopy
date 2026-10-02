import { describe, expect, test } from "bun:test";
import type { Sprout } from "../../src/core/types";
import type { FeedSnapshot } from "./feed";
import { needsYou, sortSprouts, sproutLines, sproutWord, stageAt, stageStrip } from "./sprouts";

const sprout = (over: Partial<Sprout> = {}): Sprout => ({
  id: "sp_000000000001",
  slug: "coins",
  title: "Coin counter",
  status: "queued",
  repoId: "_incubator/coins",
  seedPath: "/root/_incubator/coins",
  prepared: true,
  inputs: [],
  clarified: false,
  reclarify: false,
  flows: [],
  spent: { runs: 0, workMs: 0 },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const q = (question: string) => ({ question, header: "", options: [], multiSelect: false });
const marks = (s: Sprout) => stageStrip(s).map((x) => `${x.stage}:${x.mark}`).join(" ");

describe("the stage strip", () => {
  test("a fresh sprout has clarify next and nothing done", () => {
    expect(stageAt(sprout())).toBeNull();
    expect(marks(sprout())).toBe("clarify:todo research:todo eval:todo build:todo test:todo accept:todo deploy:todo retro:todo");
  });
  test("clarifying is now; parked there is stuck", () => {
    expect(marks(sprout({ status: "clarifying" })).startsWith("clarify:now research:todo")).toBe(true);
    const parked = sprout({ status: "parked", parked: "x", flows: [{ workflow: "clarify", flowId: "f1", outcome: "failed" }] });
    expect(stageAt(parked)).toBe("clarify");
    expect(marks(parked).startsWith("clarify:stuck research:todo")).toBe(true);
  });
  test("queued after clarify has clarify done and research waiting", () => {
    const s = sprout({ clarified: true, flows: [{ workflow: "clarify", flowId: "f1", outcome: "done" }] });
    expect(marks(s).startsWith("clarify:done research:todo")).toBe(true);
  });
  test("researching covers research; parked in scout is stuck at research", () => {
    expect(marks(sprout({ status: "researching", clarified: true })).startsWith("clarify:done research:now eval:todo")).toBe(true);
    const s = sprout({ status: "parked", parked: "the scout workflow is not installed", clarified: true, flows: [{ workflow: "clarify", flowId: "f1", outcome: "done" }] });
    expect(stageAt(s)).toBe("research");
  });
  test("live is done through deploy", () => {
    expect(marks(sprout({ status: "live", clarified: true }))).toBe("clarify:done research:done eval:done build:done test:done accept:done deploy:done retro:todo");
  });
});

describe("words and order", () => {
  test("a word for each state that matters here", () => {
    expect(sproutWord(sprout({ prepared: false }))).toBe("making the seed");
    expect(sproutWord(sprout())).toBe("waiting its turn to clarify");
    expect(sproutWord(sprout({ clarified: true }))).toBe("waiting its turn for research");
    expect(sproutWord(sprout({ status: "clarifying" }))).toBe("clarifying");
    expect(sproutWord(sprout({ status: "clarifying", questions: [q("a"), q("b")] }))).toBe("2 questions for you");
    expect(sproutWord(sprout({ status: "rejected" }))).toBe("turned down at eval");
  });
  test("questions and parks need you; the rest do not", () => {
    expect(needsYou(sprout({ status: "clarifying", questions: [q("a")] }))).toBe(true);
    expect(needsYou(sprout({ status: "parked", parked: "x" }))).toBe(true);
    expect(needsYou(sprout({ status: "clarifying" }))).toBe(false);
  });
  test("what needs you first, then what runs, then what ended; newest first in each", () => {
    const list = [
      sprout({ id: "sp_000000000001", status: "stopped", updatedAt: 9 }),
      sprout({ id: "sp_000000000002", status: "clarifying", updatedAt: 2 }),
      sprout({ id: "sp_000000000003", status: "parked", parked: "x", updatedAt: 1 }),
      sprout({ id: "sp_000000000004", status: "queued", updatedAt: 5 }),
    ];
    expect(sortSprouts(list).map((s) => s.id.slice(-1))).toEqual(["3", "4", "2", "1"]);
  });
});

describe("feed lines", () => {
  const snap = (sprouts: Record<string, Sprout>): FeedSnapshot => ({ repos: [], sources: [], runs: {}, flows: {}, fleets: {}, workspaces: [], sprouts });
  test("a new sprout, a status change, questions, a park and a dismissal", () => {
    const s = sprout();
    expect(sproutLines({ type: "incubator", sprout: s }, snap({}), 5).map((l) => l.text)).toEqual(["new project in the incubator"]);
    const c = sprout({ status: "clarifying" });
    expect(sproutLines({ type: "incubator", sprout: c }, snap({ [s.id]: s }), 5).map((l) => l.text)).toEqual(["clarifying"]);
    const asking = sprout({ status: "clarifying", questions: [q("a")] });
    expect(sproutLines({ type: "incubator", sprout: asking }, snap({ [s.id]: c }), 5).map((l) => l.text)).toEqual(["1 question for you"]);
    const parked = sprout({ status: "parked", parked: "the scout workflow is not installed" });
    const [line] = sproutLines({ type: "incubator", sprout: parked }, snap({ [s.id]: c }), 5);
    expect(line).toMatchObject({ kind: "incubator", repo: "Coin counter", repoId: "_incubator/coins", text: "parked: the scout workflow is not installed", quiet: false });
    expect(sproutLines({ type: "incubator-gone", id: s.id }, snap({ [s.id]: s }), 5).map((l) => [l.text, l.quiet])).toEqual([["dismissed", true]]);
  });
  test("a save that changes nothing a person reads is quiet", () => {
    const s = sprout({ status: "clarifying" });
    const [line] = sproutLines({ type: "incubator", sprout: { ...s, updatedAt: 9 } }, snap({ [s.id]: s }), 5);
    expect(line?.quiet).toBe(true);
  });
});

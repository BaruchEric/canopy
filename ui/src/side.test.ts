import { describe, expect, test } from "bun:test";
import type { Run } from "../../src/core/types";
import { modelWord, SIDE_BESIDE_MIN, sideAsked, sideBeside, sideGoes, sideModel, sideModels } from "./side";

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  repoId: "canopy",
  action: "chat",
  verb: "chat",
  progress: "replying",
  expectsChange: false,
  chat: true,
  harness: "claude",
  note: "",
  status: "idle",
  startedAt: 1,
  steps: [],
  prompt: null,
  ...over,
});

describe("a side question's models", () => {
  test("claude offers its own list, and the one it runs on is in it", () => {
    expect(sideModels("claude", "default")).toEqual(["default", "fable", "opus", "sonnet", "haiku"]);
    expect(sideModels("claude", "haiku")).toEqual(["default", "fable", "opus", "sonnet", "haiku"]);
  });

  test("a name outside the harness's list comes first, so the select can show it", () => {
    const models = sideModels("codex", "gpt-7-custom");
    expect(models[0]).toBe("gpt-7-custom");
    expect(models).toContain("default");
    expect(new Set(models).size).toBe(models.length);
    // the repo's and the one picked, each once
    expect(sideModels("claude", "mine", "sonnet", "mine").slice(0, 2)).toEqual(["mine", "default"]);
    expect(sideModels("claude")).toEqual(["default", "fable", "opus", "sonnet", "haiku"]);
  });

  test("the model a thread runs on is its record's, default when it names none", () => {
    expect(sideModel(run({ agentSettings: { harness: "claude", model: "sonnet", effort: "default" } }))).toBe("sonnet");
    expect(sideModel(run())).toBe("default");
    expect(modelWord("default")).toBe("the default model");
    expect(modelWord("haiku")).toBe("haiku");
  });
});

describe("what a side thread says it asked", () => {
  test("its first message's first line, past canopy's own note", () => {
    const asked = sideAsked(run({
      name: "retry backoff default",
      steps: [
        { id: "1", at: 1, kind: "note", text: "a side question beside …" },
        { id: "2", at: 2, kind: "user", text: "what does retryBackoff default to?\nand where is it set" },
        { id: "3", at: 3, kind: "text", text: "500 ms" },
        { id: "4", at: 4, kind: "user", text: "and the cap?" },
      ],
    }));
    expect(asked).toBe("what does retryBackoff default to?");
  });

  test("the name it goes by when its steps hold no message", () => {
    expect(sideAsked(run({ name: "retry backoff default" }))).toBe("retry backoff default");
    expect(sideAsked(run())).toBe("chat");
  });
});

describe("where a box's text goes", () => {
  const going = run({ status: "working", session: "s1" });

  test("to the run unless it opens with btw", () => {
    expect(sideGoes("what is the port?", going, false)).toBe("run");
    expect(sideGoes("btween the lines", going, false)).toBe("run");
    expect(sideGoes("", going, false)).toBe("run");
  });

  test("beside the run when it does, mid-turn and between turns alike", () => {
    expect(sideGoes("btw what is the port?", going, false)).toBe("side");
    expect(sideGoes("BTW: what is the port?", run({ status: "idle", session: "s1" }), false)).toBe("side");
    expect(sideGoes("btw, what is the port?", run({ status: "waiting", session: "s1" }), false)).toBe("side");
  });

  test("nowhere yet with nothing asked, or beside a run that takes none now", () => {
    expect(sideGoes("btw ", going, false)).toBe("held");
    // nothing was said in the chat, so it has no session to fork
    expect(sideGoes("btw what is the port?", run({ status: "idle" }), false)).toBe("held");
    expect(sideGoes("btw and the host?", run({ status: "idle", session: "s2", sideOf: { run: "p", title: "the parent" } }), false)).toBe("held");
  });

  test("to the run after all once the user says so", () => {
    expect(sideGoes("btw what is the port?", going, true)).toBe("run");
    expect(sideGoes("btw ", going, true)).toBe("run");
  });
});

describe("where the column sits", () => {
  test("beside the run from the width a phone's layout ends at, over it below", () => {
    expect(sideBeside(SIDE_BESIDE_MIN)).toBe(true);
    expect(sideBeside(1240)).toBe(true);
    expect(sideBeside(760)).toBe(false);
    expect(sideBeside(390)).toBe(false);
  });
});

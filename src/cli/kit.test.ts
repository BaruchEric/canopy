import { describe, expect, test } from "bun:test";
import { actionWord, kitApplyLines, kitStatusLines } from "./kit";
import type { KitInfo } from "../core/types";

const info: KitInfo = {
  ok: true, error: null,
  machines: [{
    machine: "mac",
    seen: { machine: "mac", at: 1, away: null, home: "/h", store: { tracked: [], branch: "main", ahead: 0, behind: 2, dirty: 3, fetchFailed: false }, targets: [], sources: {} },
    plan: [{ kind: "pull" }, { kind: "link", agent: "codex", name: "ship", link: "../../.claude/skills/ship" }],
  }],
  cells: [
    { machine: "mac", agent: "codex", skill: "ship", state: "missing", why: "" },
    { machine: "mac", agent: "codex", skill: "qnap", state: "foreign", why: "a dir canopy did not place" },
    { machine: "mac", agent: "claude", skill: "ship", state: "ok", why: "" },
  ],
};

describe("kit cli", () => {
  test("status: the store line, the problems, the plan", () => {
    expect(kitStatusLines(info, null)).toEqual([
      "mac  store main, 2 behind, 3 changed",
      "  codex  ship  missing",
      "  codex  qnap  foreign  a dir canopy did not place",
      "  plan: pull, link codex/ship",
    ]);
  });
  test("an error reads as one line", () => {
    expect(kitStatusLines({ ok: false, error: "kit.json: bad", machines: [], cells: [] }, null)).toEqual(["kit.json: bad"]);
  });
  test("apply lines and words", () => {
    expect(actionWord({ kind: "remove", agent: "codex", name: "x" })).toBe("remove codex/x");
    expect(kitApplyLines({ machine: "mac", done: [{ kind: "pull" }], failed: [{ action: { kind: "mkdir", agent: "hermes" }, why: "cannot make /x" }] }))
      .toEqual(["mac: pull done", "mac: mkdir hermes failed: cannot make /x"]);
  });
});

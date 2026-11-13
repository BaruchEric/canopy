import { expect, test } from "bun:test";
import { loadoutLines } from "./loadouts";

test("one line per loadout, then the errors", () => {
  expect(loadoutLines({ base: ["verify-build"], loadouts: [
    { name: "homelab-ops", note: "the mini's stacks", harness: "claude", model: "sonnet", effort: "medium", skills: ["homelab:tailchan"], mcp: ["executor"], canopyTools: false },
    { name: "docs", note: "", harness: "claude", model: "haiku", effort: "low", skills: [], mcp: [], canopyTools: true },
  ], errors: ["loadouts.x.model: claude does not take gpt-5"] })).toEqual([
    "homelab-ops  claude sonnet medium  1 skill  executor  the mini's stacks",
    "docs         claude haiku low      0 skills  canopy tools",
    "always on: verify-build",
    "error: loadouts.x.model: claude does not take gpt-5",
  ]);
});

test("a loadout with no servers and no canopy tools prints no server column", () => {
  expect(loadoutLines({ base: [], loadouts: [
    { name: "a", note: "n", harness: "codex", model: "gpt-5", effort: "high", skills: ["x", "y"], mcp: [], canopyTools: false },
  ], errors: [] })).toEqual(["a  codex gpt-5 high  2 skills  n"]);
});

test("servers and canopy tools share a column", () => {
  expect(loadoutLines({ base: [], loadouts: [
    { name: "a", note: "", harness: "claude", model: "m", effort: "low", skills: [], mcp: ["s1", "s2"], canopyTools: true },
  ], errors: [] })).toEqual(["a  claude m low  0 skills  s1, s2, canopy tools"]);
});

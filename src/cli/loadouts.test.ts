import { expect, test } from "bun:test";
import { defaultLines, loadoutLines, providerLines, resolveLines } from "./loadouts";

test("one line per loadout, then the errors", () => {
  expect(loadoutLines({ base: ["verify-build"], loadouts: [
    { name: "homelab-ops", note: "the mini's stacks", harness: "claude", model: "sonnet", effort: "medium", skills: ["homelab:tailchan"], mcp: ["executor"], canopyTools: false },
    { name: "docs", note: "", harness: "claude", model: "haiku", effort: "low", skills: [], mcp: [], canopyTools: true },
  ], errors: ["loadouts.x.model: claude does not take gpt-5"], servers: [] })).toEqual([
    "homelab-ops  claude sonnet medium  1 skill  executor  the mini's stacks",
    "docs         claude haiku low      0 skills  canopy tools",
    "always on: verify-build",
    "error: loadouts.x.model: claude does not take gpt-5",
  ]);
});

test("a loadout with no servers and no canopy tools prints no server column", () => {
  expect(loadoutLines({ base: [], loadouts: [
    { name: "a", note: "n", harness: "codex", model: "gpt-5", effort: "high", skills: ["x", "y"], mcp: [], canopyTools: false },
  ], errors: [], servers: [] })).toEqual(["a  codex gpt-5 high  2 skills  n"]);
});

test("servers and canopy tools share a column", () => {
  expect(loadoutLines({ base: [], loadouts: [
    { name: "a", note: "", harness: "claude", model: "m", effort: "low", skills: [], mcp: ["s1", "s2"], canopyTools: true },
  ], errors: [], servers: [] })).toEqual(["a  claude m low  0 skills  s1, s2, canopy tools"]);
});

test("a loadout's provider rides beside its agent, and the defaults and providers follow the loadouts", () => {
  expect(loadoutLines({ base: [], loadouts: [
    { name: "off", note: "", harness: "claude", model: "default", effort: "default", skills: [], mcp: [], canopyTools: false, provider: "local" },
  ], errors: [], servers: [], machine: "mac",
  defaults: { loadout: "quick", machines: { mac: "off" }, repos: { "dev-tools/*": "none" } },
  providers: [{ id: "local", note: "llama", harness: "claude", machines: ["mac"], central: false, envNames: [], keys: [], state: "hand", why: "this machine keeps its own file" }],
  })).toEqual([
    "off  claude default default on local  0 skills",
    "default: quick everywhere",
    "default: off on machine mac (this backend)",
    "default: none in dev-tools/*",
    "provider local  claude  hand  on mac  own file  this machine keeps its own file  llama",
  ]);
});

test("no defaults and no providers add no lines", () => {
  const info = { base: [], loadouts: [], errors: [], servers: [] };
  expect(defaultLines(info)).toEqual([]);
  expect(providerLines(info)).toEqual([]);
});

test("an adopted central provider says so", () => {
  expect(providerLines({ base: [], loadouts: [], errors: [], servers: [], providers: [
    { id: "gw", note: "", harness: "claude", machines: null, central: true, envNames: ["T"], keys: ["env"], state: "ok", adopted: true },
  ] })).toEqual(["provider gw  claude  ok (adopted)  every machine"]);
});

test("resolve says the loadout and where it came from, or why there is none", () => {
  expect(resolveLines("app", { name: "feature", from: "repo", key: "dev-tools/*" })).toEqual(["app: feature (from repo dev-tools/*)"]);
  expect(resolveLines("app", { name: null, from: "machine", key: "mini" })).toEqual(["app: no loadout, machine mini says none"]);
  expect(resolveLines("app", { name: null, from: null, skipped: ["repo app: cx runs codex"] })).toEqual(["app: no loadout", "  passed over: repo app: cx runs codex"]);
});

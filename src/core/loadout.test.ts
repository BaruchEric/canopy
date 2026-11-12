import { expect, test } from "bun:test";
import { baseCovers, parseLoadouts } from "./loadout";
import { parseKit, withCanopyServer } from "./kit";
import type { KitManifest } from "./types";

const srv = (agents?: string[]) => ({ command: "x", ...(agents ? { agents } : {}) });
const parsed = parseKit({
  version: 1,
  machines: { mac: { backend: "mac" } },
  targets: [
    { agent: "claude", skills: "~/.claude/skills", mode: "store", mcp: { file: "~/.claude.json", format: "claude-json" } },
    { agent: "codex", skills: "~/.codex/skills", mode: "link", mcp: { file: "~/.codex/config.toml", format: "codex-toml" } },
  ],
  mcp: { executor: srv(), "wiki-memory": srv(), "codex-only": srv(["codex"]) },
});
if (!("kit" in parsed)) throw new Error(`kit fixture: ${parsed.errors.join("; ")}`);
const kit: KitManifest = withCanopyServer(parsed.kit);

test("no loadouts block is no loadouts and no errors", () => {
  expect(parseLoadouts({ version: 1 }, kit)).toEqual({ base: [], loadouts: [], errors: [] });
});
test("an empty definition takes the defaults", () => {
  expect(parseLoadouts({ loadouts: { docs: {} } }, kit).loadouts).toEqual([
    { name: "docs", note: "", harness: "claude", model: "default", effort: "default", skills: [], mcp: [], canopyTools: false },
  ]);
});
test("the spec's homelab-ops parses whole", () => {
  const info = parseLoadouts({ loadoutBase: { skills: ["verify-build", "homelab:*"] }, loadouts: { "homelab-ops": { note: "the mini's stacks", model: "sonnet", effort: "medium", skills: ["homelab:tailchan"], mcp: ["executor", "wiki-memory"] } } }, kit);
  expect(info.base).toEqual(["verify-build", "homelab:*"]);
  expect(info.loadouts[0]).toMatchObject({ name: "homelab-ops", model: "sonnet", effort: "medium", skills: ["homelab:tailchan"], mcp: ["executor", "wiki-memory"] });
  expect(info.errors).toEqual([]);
});
test("a codex loadout with a plain model parses", () => {
  const info = parseLoadouts({ loadouts: { cx: { harness: "codex", model: "gpt-5", effort: "high" } } }, kit);
  expect(info.errors).toEqual([]);
  expect(info.loadouts[0]).toMatchObject({ harness: "codex", model: "gpt-5", effort: "high" });
});
test.each([
  [{ "Bad Name": {} }, "loadouts.Bad Name: a name of lowercase letters, digits and dashes"],
  [{ a: "x" }, "loadouts.a: not an object"],
  [{ a: { skill: [] } }, "loadouts.a.skill: not a loadout field"],
  [{ a: { harness: "gpt" } }, "loadouts.a.harness: claude or codex"],
  [{ a: { model: "gpt-5" } }, "loadouts.a.model: claude does not take gpt-5"],
  [{ a: { effort: "turbo" } }, "loadouts.a.effort: claude does not take turbo"],
  [{ a: { skills: "x" } }, "loadouts.a.skills: a list of skill names"],
  [{ a: { skills: ["x:*"] } }, "loadouts.a.skills: a list of skill names"],
  [{ a: { harness: "codex", skills: ["x"] } }, "loadouts.a.skills: a codex loadout takes no skills"],
  [{ a: { harness: "codex", mcp: ["executor"] } }, "loadouts.a.mcp: a codex loadout takes no servers"],
  [{ a: { mcp: ["nope"] } }, "loadouts.a.mcp: no server named nope in the kit"],
  [{ a: { mcp: ["canopy"] } }, "loadouts.a.mcp: canopy's own server comes with canopyTools"],
  [{ a: { mcp: ["codex-only"] } }, "loadouts.a.mcp: codex-only is not for claude"],
  [{ a: { note: "x".repeat(201) } }, "loadouts.a.note: at most 200 characters"],
  [{ a: { canopyTools: "yes" } }, "loadouts.a.canopyTools: true or false"],
])("%j is refused with its reason, and only that loadout goes", (bad, why) => {
  const info = parseLoadouts({ loadouts: { ...bad, good: {} } }, kit);
  expect(info.errors).toEqual([why]);
  expect(info.loadouts.map((l) => l.name)).toEqual(["good"]);
});
test("a bad base is an error and no base", () => {
  expect(parseLoadouts({ loadoutBase: { skills: "x" }, loadouts: {} }, kit)).toEqual({ base: [], loadouts: [], errors: ["loadoutBase.skills: a list of skill names"] });
});
test("a loadouts block that is not an object", () => {
  expect(parseLoadouts({ loadouts: [] }, kit).errors).toEqual(["loadouts: an object of loadout name to definition"]);
});
test("with no kit nothing can be checked", () => {
  expect(parseLoadouts({ loadouts: { a: {} } }, null)).toEqual({ base: [], loadouts: [], errors: ["loadouts: kit.json did not parse, so no loadout can be checked"] });
});
test("baseCovers takes a name or a plugin's prefix", () => {
  expect(baseCovers(["verify-build", "homelab:*"], "verify-build")).toBe(true);
  expect(baseCovers(["homelab:*"], "homelab:tailchan")).toBe(true);
  expect(baseCovers(["homelab:*"], "homelab")).toBe(false);
  expect(baseCovers(["homelab:*"], "homelabx:a")).toBe(false);
});

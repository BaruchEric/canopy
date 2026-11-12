import { expect, test } from "bun:test";
import { baseCovers, mergeProviderSettings, parseLoadouts, planLoadoutStart, skillOverridesFor, type LoadoutStartPlan } from "./loadout";
import { parseKit, withCanopyServer } from "./kit";
import { DEFAULT_AGENT, type Harness, type KitManifest, type LoadoutsInfo, type Mention } from "./types";

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

const m = (name: string, from: string, kind: Mention["kind"] = "skill", harness: Harness = "claude"): Mention => ({ name, kind, harness, from, description: "" });
const skills = [m("ripe", "user"), m("grill-me", "user"), m("homelab:tailchan", "plugin:homelab"), m("homelab:macmini", "plugin:homelab"),
  m("superpowers:brainstorming", "plugin:superpowers"), m("redeploy", "project"), m("verify-build", "user"), m("commit", "user", "command"),
  m("codex-thing", "user", "skill", "codex"), m("compact", "builtin", "builtin")];
const planInfo: LoadoutsInfo = {
  base: ["verify-build", "homelab:*"],
  errors: [],
  loadouts: [
    { name: "docs", note: "", harness: "claude", model: "haiku", effort: "low", skills: [], mcp: [], canopyTools: false },
    { name: "homelab-ops", note: "", harness: "claude", model: "sonnet", effort: "medium", skills: ["homelab:tailchan"], mcp: ["executor", "wiki-memory"], canopyTools: false },
    { name: "needs-missing", note: "", harness: "claude", model: "default", effort: "default", skills: ["nope:gone"], mcp: [], canopyTools: false },
    { name: "codex-fast", note: "", harness: "codex", model: "gpt-5.5", effort: "low", skills: [], mcp: [], canopyTools: false },
  ],
};
const planBase = { name: "docs", info: planInfo, agent: DEFAULT_AGENT, skills, machine: "mini", entryOf: () => ({ entry: { type: "stdio", command: "bash", args: [] } }) };

test("listed on, base and the repo's left alone, every other user and plugin skill off", () => {
  expect(skillOverridesFor({ skills: ["homelab:tailchan"] }, ["verify-build", "homelab:*"], skills)).toEqual({
    overrides: { "grill-me": "off", "homelab:tailchan": "on", ripe: "off", "superpowers:brainstorming": "off" },
    off: 3,
  });
});
test("a repo skill named like a user skill is never named", () => {
  const twin = [m("redeploy", "user"), m("redeploy", "project")];
  expect(skillOverridesFor({ skills: [] }, [], twin)).toEqual({ overrides: {}, off: 0 });
});
test("an unknown loadout names the ones there are", () => {
  expect(planLoadoutStart({ ...planBase, name: "nope" })).toEqual({ refused: "no loadout named nope; kit.json has docs, homelab-ops, needs-missing, codex-fast" });
});
test("an unknown loadout in a kit with errors says so", () => {
  expect(planLoadoutStart({ ...planBase, name: "nope", info: { base: [], loadouts: [], errors: ["loadouts: kit.json did not parse, so no loadout can be checked"] } }))
    .toEqual({ refused: "no loadout named nope; kit.json has none (loadouts: kit.json did not parse, so no loadout can be checked)" });
});
test("a skill the machine lacks refuses the start", () => {
  expect(planLoadoutStart({ ...planBase, name: "needs-missing" })).toEqual({ refused: "loadout needs-missing names nope:gone, which mini does not have" });
});
test("a server the kit cannot give refuses the start with the kit's why", () => {
  expect(planLoadoutStart({ ...planBase, name: "homelab-ops", entryOf: (s) => (s === "executor" ? { why: "the kit does not put executor on mini" } : { entry: { type: "stdio", command: "bash", args: [] } }) }))
    .toEqual({ refused: "loadout homelab-ops: the kit does not put executor on mini" });
});
test("a claude loadout replaces model and effort and keeps provider, yolo and extra", () => {
  const plan = planLoadoutStart({ ...planBase, name: "homelab-ops", agent: { ...DEFAULT_AGENT, provider: "zai", extra: "--verbose", yolo: true } });
  expect(plan).toMatchObject({ agent: { harness: "claude", model: "sonnet", effort: "medium", provider: "zai", extra: "--verbose", yolo: true }, canopyTools: false,
    equip: { loadout: "homelab-ops", model: "sonnet", effort: "medium", skills: ["homelab:tailchan"], mcp: ["executor", "wiki-memory"], off: 3 } });
  expect(Object.keys((plan as LoadoutStartPlan).servers)).toEqual(["executor", "wiki-memory"]);
});
test("a harness change drops the route's provider and extra", () => {
  const plan = planLoadoutStart({ ...planBase, name: "codex-fast", agent: { ...DEFAULT_AGENT, provider: "zai", extra: "--verbose" } }) as LoadoutStartPlan;
  expect(plan.agent).toEqual({ ...DEFAULT_AGENT, harness: "codex", model: "gpt-5.5", effort: "low", extra: "" });
  expect(plan.overrides).toEqual({});
  expect(plan.servers).toEqual({});
});
test("the provider's settings keep everything and take the overrides over their own", () => {
  expect(mergeProviderSettings({ env: { A: "1" }, skillOverrides: { ripe: "on", x: "off" } }, { ripe: "off" }))
    .toEqual({ env: { A: "1" }, skillOverrides: { ripe: "off", x: "off" } });
  expect(mergeProviderSettings(null, { ripe: "off" })).toEqual({ skillOverrides: { ripe: "off" } });
});

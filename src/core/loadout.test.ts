import { expect, test } from "bun:test";
import { baseCovers, mergeProviderSettings, parseLoadouts, planLoadoutStart, skillOverridesFor, type LoadoutStartPlan } from "./loadout";
import { parseKit, withCanopyServer } from "./kit";
import { sortMentions } from "./mentions";
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
/** a plugin's skill or command, as the scan names it: from its name, keyed by name@marketplace */
const p = (name: string, key: string, kind: Mention["kind"] = "skill"): Mention => ({ name, kind, harness: "claude", from: `plugin:${key.slice(0, key.indexOf("@"))}`, description: "", plugin: key });
const skills = [m("ripe", "user"), m("grill-me", "user"), p("homelab:tailchan", "homelab@hl"), p("homelab:macmini", "homelab@hl"),
  p("superpowers:brainstorming", "superpowers@sp"), m("redeploy", "project"), m("verify-build", "user"), m("commit", "user", "command"),
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

const NO_PLUGINS = { plugins: {}, pluginsOff: [] };

test("listed on, base and the repo's left alone, every other user skill off and every plugin the loadout leaves out off whole", () => {
  expect(skillOverridesFor({ skills: ["homelab:tailchan"] }, ["verify-build", "homelab:*"], skills)).toEqual({
    overrides: { "grill-me": "off", "homelab:tailchan": "on", ripe: "off" },
    plugins: { "superpowers@sp": false },
    pluginsOff: ["superpowers"],
    off: 3,
  });
});
test("a repo skill named like a user skill is never named", () => {
  const twin = [m("redeploy", "user"), m("redeploy", "project")];
  expect(skillOverridesFor({ skills: [] }, [], twin)).toEqual({ overrides: {}, ...NO_PLUGINS, off: 0 });
});
test("a listed repo-only skill gets on and a repo skill is never turned off", () => {
  expect(skillOverridesFor({ skills: ["redeploy"] }, [], [m("redeploy", "project"), m("ripe", "user")])).toEqual({ overrides: { redeploy: "on", ripe: "off" }, ...NO_PLUGINS, off: 1 });
});
test("a listed user skill that a repo skill shadows still gets on", () => {
  expect(skillOverridesFor({ skills: ["redeploy"] }, [], [m("redeploy", "user"), m("redeploy", "project")])).toEqual({ overrides: { redeploy: "on" }, ...NO_PLUGINS, off: 0 });
});
test("a plugin skill never gets an off key: its plugin goes off, and off counts its skills", () => {
  const got = skillOverridesFor({ skills: [] }, [], skills);
  expect(got.overrides).toEqual({ "grill-me": "off", ripe: "off", "verify-build": "off" });
  expect(got.plugins).toEqual({ "homelab@hl": false, "superpowers@sp": false });
  expect(got.pluginsOff).toEqual(["homelab", "superpowers"]);
  expect(got.off).toBe(6);
});
test("one listed skill keeps its whole plugin on", () => {
  const got = skillOverridesFor({ skills: ["homelab:macmini"] }, [], skills);
  expect(got.overrides["homelab:macmini"]).toBe("on");
  expect(got.overrides["homelab:tailchan"]).toBeUndefined();
  expect(got.plugins).toEqual({ "superpowers@sp": false });
  expect(got.off).toBe(4);
});
test("a skill the base names keeps its plugin on", () => {
  expect(skillOverridesFor({ skills: [] }, ["homelab:tailchan"], skills).plugins).toEqual({ "superpowers@sp": false });
});
test("a base of plugin:* keeps that plugin on", () => {
  expect(skillOverridesFor({ skills: [] }, ["superpowers:*"], skills).plugins).toEqual({ "homelab@hl": false });
});
test("a plugin with no skills (commands or hooks only) is left alone", () => {
  const got = skillOverridesFor({ skills: [] }, [], [p("vercel:deploy", "vercel@official", "command"), m("ripe", "user")]);
  expect(got).toEqual({ overrides: { ripe: "off" }, ...NO_PLUGINS, off: 1 });
});
test("two plugins of one name from two marketplaces go off by their own keys", () => {
  const twins = [p("foo:x", "foo@a"), p("foo:y", "foo@b"), p("foo:z", "foo@b")];
  expect(skillOverridesFor({ skills: ["foo:x"] }, [], twins)).toEqual({ overrides: { "foo:x": "on" }, plugins: { "foo@b": false }, pluginsOff: ["foo"], off: 2 });
  expect(skillOverridesFor({ skills: [] }, [], twins)).toEqual({ overrides: {}, plugins: { "foo@a": false, "foo@b": false }, pluginsOff: ["foo"], off: 3 });
});
test("a skill that shares its name with a command is still turned off, and its plugin with it", () => {
  // the order the scan reads them: each folder's commands before its skills
  const read = sortMentions([m("visual-plan", "user", "command"), m("visual-plan", "user"), p("vercel:bootstrap", "vercel@official", "command"), p("vercel:bootstrap", "vercel@official")]);
  expect(skillOverridesFor({ skills: [] }, [], read)).toEqual({ overrides: { "visual-plan": "off" }, plugins: { "vercel@official": false }, pluginsOff: ["vercel"], off: 2 });
});
test("only a claude skill counts as one the machine has", () => {
  const info: LoadoutsInfo = { ...planInfo, loadouts: [
    { name: "cmd", note: "", harness: "claude", model: "default", effort: "default", skills: ["commit"], mcp: [], canopyTools: false },
    { name: "cdx", note: "", harness: "claude", model: "default", effort: "default", skills: ["codex-thing"], mcp: [], canopyTools: false },
  ] };
  expect(planLoadoutStart({ ...planBase, info, name: "cmd" })).toEqual({ refused: "loadout cmd names commit, which mini does not have" });
  expect(planLoadoutStart({ ...planBase, info, name: "cdx" })).toEqual({ refused: "loadout cdx names codex-thing, which mini does not have" });
});
test("the plan carries the plugins off, and equip names them", () => {
  const plan = planLoadoutStart({ ...planBase, name: "docs" }) as LoadoutStartPlan;
  expect(plan.plugins).toEqual({ "superpowers@sp": false });
  expect(plan.equip).toEqual({ loadout: "docs", model: "haiku", effort: "low", skills: [], mcp: [], off: 3, pluginsOff: ["superpowers"] });
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
    equip: { loadout: "homelab-ops", model: "sonnet", effort: "medium", skills: ["homelab:tailchan"], mcp: ["executor", "wiki-memory"], off: 3, pluginsOff: ["superpowers"] } });
  expect(Object.keys((plan as LoadoutStartPlan).servers)).toEqual(["executor", "wiki-memory"]);
});
test("a harness change drops the route's provider and extra", () => {
  const plan = planLoadoutStart({ ...planBase, name: "codex-fast", agent: { ...DEFAULT_AGENT, provider: "zai", extra: "--verbose" } }) as LoadoutStartPlan;
  expect(plan.agent).toEqual({ ...DEFAULT_AGENT, harness: "codex", model: "gpt-5.5", effort: "low", extra: "" });
  expect(plan.overrides).toEqual({});
  expect(plan.plugins).toEqual({});
  expect(plan.servers).toEqual({});
  expect(plan.equip.pluginsOff).toBeUndefined();
});
test("the provider's settings keep everything and take the overrides over their own", () => {
  expect(mergeProviderSettings({ env: { A: "1" }, skillOverrides: { ripe: "on", x: "off" } }, { ripe: "off" }))
    .toEqual({ env: { A: "1" }, skillOverrides: { ripe: "off", x: "off" } });
  expect(mergeProviderSettings(null, { ripe: "off" })).toEqual({ skillOverrides: { ripe: "off" } });
});
test("the plugins off lay over the provider's enabledPlugins key by key", () => {
  expect(mergeProviderSettings({ enabledPlugins: { "a@m": true, "b@m": true } }, {}, { "b@m": false }))
    .toEqual({ skillOverrides: {}, enabledPlugins: { "a@m": true, "b@m": false } });
  expect(mergeProviderSettings(null, {}, { "b@m": false })).toEqual({ skillOverrides: {}, enabledPlugins: { "b@m": false } });
  // no plugins off: the provider's own switches stay as they are
  expect(mergeProviderSettings({ enabledPlugins: { "a@m": false } }, {}, {})).toEqual({ enabledPlugins: { "a@m": false }, skillOverrides: {} });
});

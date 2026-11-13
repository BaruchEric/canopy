# Manager, plan 1: loadouts for a hand-started run

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: implemented 2026-11-12 on branch `manager-loadouts`; merged into `main` and shipped 2026-11-12. Real run on a scratch server with claude 2.1.323 (Task 9): loadout `docs` (haiku, low, user skill `unslop`) ran on haiku with `unslop` and the repo's `projskill` in its init `skills`; loadout `broken` (server `command: "false"`) ended failed with "a loadout server did not start here: badsrv (failed)", and its files were gone. That run found that `skillOverrides` does not reach a plugin's skills, so the final review's fix wave turns a plugin off whole through `enabledPlugins`. Rerun after that fix, same setup, both runs on haiku: a plain run's init listed 202 skills and 15 plugins, the `docs` run's 51 and 7. The 8 plugins gone are exactly `equip.pluginsOff` (firebase, frontend-design, homelab, impeccable, skill-creator, superpowers, vercel, video-toolkit); the 7 left are `watch` (commands only, so left alone), two `@synced` and four `@builtin`. `equip.off` was 156: 72 user skills and the 84 skills of those plugins. The drop of 151 is those 156, less 5 user skills the user's own settings already turn off (docktail, lets-talk-about, parallels-desktop, raycast, visual-recap), which the plain run did not list either; nothing else went, and nothing turned off stayed. A first rerun showed a skill that shares its name with a command (`skillsets`, `visual-plan`, `vercel:bootstrap`) hidden behind the command in the mentions list and so left on; `sortMentions` now keeps the skill. `unslop` and `projskill` stayed.

**Goal:** A run started from the plan sheet or `canopy run --loadout NAME` gets exactly the harness, model, effort, skills and MCP servers a kit.json loadout names, plus the repo's own skills and `loadoutBase`.

**Architecture:** kit.json gains `loadoutBase` and `loadouts`, parsed by a pure, browser-safe `core/loadout.ts` beside the kit's own parser and carried in `KitInfo`. At a start, a pure planner turns the loadout, the repo's skill list (`listMentions`) and the kit's server entries into agent settings, a `skillOverrides` map and an MCP server map; the server writes one settings file and one `mcp.json` per run, and the claude driver passes them and checks at init that every loadout server connected. The run keeps what it was given as `equip`.

**Tech Stack:** Bun, TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), React 19 with Zustand, `bun test`, oxlint, Vite.

**Spec:** `docs/superpowers/specs/2026-11-12-manager-design.md`, sections "Loadouts in kit.json", "Starting a run with a loadout", "Probes before plan 1" (with its Answers) and "Phases" item 1.

## Global Constraints

- Every run keeps `--setting-sources user,project,local` and `--strict-mcp-config` (`core/claudedrive.ts`).
- A run gets one `--settings` file at most (probe P1: a second one replaces the first). A loadout's file holds the provider's settings with `skillOverrides` laid over.
- Skill keys are what the CLI uses: a user skill's folder name, `<plugin>:<folder>` for a plugin's (probe P3). `"*"` keys do nothing.
- Runs spawn the user's installed `claude`; never the Agent SDK or an API key.
- `src/core/loadout.ts` stays browser-safe: no Bun or node imports.
- Tests pass on macOS and Linux; a test that needs a kit sets `CANOPY_KIT` to a scratch file before `startServer`, since `src/test-env.ts` clears every `CANOPY_` name.
- No codex skills or servers in this version: a codex loadout takes harness, model and effort only.
- Prose in comments, docs and messages follows the repo's style: plain words, no em dashes. Commit messages have no backticks and end with `Claude-Session: https://claude.ai/code/session_01BR8Nn8uhcR6LN74aB1WYBc`.
- All four gates pass before a task's commit: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.

## Review Focus

1. A loadout start whose route names a provider whose settings file cannot be read or is not JSON: refuse the start naming the file, never start without the provider. Test in Task 6.
2. A codex route with a claude loadout, or the reverse: the route's `provider` and `extra` are dropped when the harness changes, since they belong to the other harness. Test in Task 2.
3. A repo skill with the same name as a user skill: the repo's is kept on and never named in the overrides. Test in Task 2.
4. A run that stops or ends after its files were written: the settings file and `mcp.json` both go. Test in Task 6.
5. A kit.json that does not parse: `GET /api/loadouts` carries the error, and a start with a loadout says so instead of "no loadout named". Tests in Tasks 2 and 5.

---

### Task 1: Loadout types and the parser

**Files:**
- Modify: `src/core/types.ts` (beside `KitInfo`, about line 4150; `Run` at about 1324)
- Create: `src/core/loadout.ts`
- Test: `src/core/loadout.test.ts`

**Interfaces:**
- Produces, in `types.ts`:

```ts
/** A named set of what a run starts with, from kit.json's `loadouts` (FR-065). */
export interface Loadout {
  name: string;
  /** one line on what it is for, at most 200 characters */
  note: string;
  harness: Harness;
  model: string;
  effort: AgentEffort;
  /** skill keys kept on: a user skill's folder, `<plugin>:<folder>` */
  skills: string[];
  /** server names from the kit's `mcp` block */
  mcp: string[];
  canopyTools: boolean;
}

/** kit.json's loadouts as this backend parsed them (FR-065). */
export interface LoadoutsInfo {
  /** `loadoutBase.skills`: on in every loadout; `name:*` covers a plugin's */
  base: string[];
  loadouts: Loadout[];
  /** one line per problem, naming the loadout and the field; a loadout with one is left out */
  errors: string[];
}

/** What a loadout resolved to at a run's start, kept on the run (FR-065). */
export interface RunEquip {
  loadout: string;
  model: string;
  effort: AgentEffort;
  skills: string[];
  mcp: string[];
  /** how many of the machine's user and plugin skills the run started without */
  off: number;
}
```

  `KitInfo` gains `loadouts?: LoadoutsInfo`; `Run` gains `equip?: RunEquip`.
- Produces, in `loadout.ts`: `LOADOUT_NAME: RegExp` (`/^[a-z0-9][a-z0-9-]{0,39}$/`), `parseLoadouts(raw: unknown, kit: KitManifest | null): LoadoutsInfo`, `baseCovers(base: readonly string[], skill: string): boolean`, `EMPTY_LOADOUTS: LoadoutsInfo`.
- Consumes: `takesModel(h, model)` and `takesEffort(h, effort)` from `core/harness.ts`, `isHarness` (or the `Harness` list) from `core/types.ts`.

- [ ] **Step 1: Write the failing tests** in `src/core/loadout.test.ts`. The kit fixture is a `KitManifest` with `mcp` holding `executor` (agents null), `wiki-memory` (agents null), `codex-only` (agents `["codex"]`) and `canopy` (as `withCanopyServer` adds it).

```ts
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
```

- [ ] **Step 2: Run them to see them fail.** Run: `bun test src/core/loadout.test.ts`. Expected: FAIL, `parseLoadouts` not found.
- [ ] **Step 3: Add the types and write `loadout.ts`.** A skill key matches `/^[A-Za-z0-9][\w.-]*(:[A-Za-z0-9][\w.-]*)?$/`; a base entry may also end in `:*`. Fields of a loadout: `note`, `harness`, `model`, `effort`, `skills`, `mcp`, `canopyTools`; any other key is "not a loadout field". Errors keep the order loadouts appear in the object, one per field, and a loadout with any error is left out. Loadouts keep kit.json's order. `EMPTY_LOADOUTS` is `{ base: [], loadouts: [], errors: [] }`.
- [ ] **Step 4: Run the tests.** Run: `bun test src/core/loadout.test.ts`. Expected: PASS.
- [ ] **Step 5: Gates and commit.** Run the four gates, then `git add src/core/types.ts src/core/loadout.ts src/core/loadout.test.ts && git commit` with the message "Loadouts: the kit.json block and its parser (FR-065)".

### Task 2: Planning a loadout start

**Files:**
- Modify: `src/core/loadout.ts`
- Test: `src/core/loadout.test.ts`

**Interfaces:**
- Consumes: `Loadout`, `LoadoutsInfo`, `RunEquip`, `baseCovers` (Task 1); `Mention` and `AgentSettings`, `KitMcpEntry` from `types.ts`.
- Produces:

```ts
export interface LoadoutStartPlan {
  /** the route's settings with harness, model and effort replaced */
  agent: AgentSettings;
  /** empty for a codex loadout */
  overrides: Record<string, "on" | "off">;
  /** each loadout server's entry, by name */
  servers: Record<string, KitMcpEntry>;
  canopyTools: boolean;
  equip: RunEquip;
}
export function skillOverridesFor(loadout: Pick<Loadout, "skills">, base: readonly string[], skills: readonly Mention[]): { overrides: Record<string, "on" | "off">; off: number };
export function planLoadoutStart(o: {
  name: string;
  info: LoadoutsInfo;
  agent: AgentSettings;
  skills: readonly Mention[];
  /** the kit's own name for this machine, for the refusal */
  machine: string;
  entryOf: (server: string) => { entry: KitMcpEntry } | { why: string };
}): LoadoutStartPlan | { refused: string };
export function mergeProviderSettings(provider: Record<string, unknown> | null, overrides: Record<string, "on" | "off">): Record<string, unknown>;
```

- [ ] **Step 1: Write the failing tests.** Mentions are built with a helper `m(name, from, kind = "skill", harness = "claude")`.

```ts
const skills = [m("ripe", "user"), m("grill-me", "user"), m("homelab:tailchan", "plugin:homelab"), m("homelab:macmini", "plugin:homelab"),
  m("superpowers:brainstorming", "plugin:superpowers"), m("redeploy", "project"), m("verify-build", "user"), m("commit", "user", "command"),
  m("codex-thing", "user", "skill", "codex"), m("compact", "builtin", "builtin")];
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
  expect(planLoadoutStart({ ...base, name: "nope" })).toEqual({ refused: "no loadout named nope; kit.json has docs, homelab-ops, needs-missing, codex-fast" });
});
test("an unknown loadout in a kit with errors says so", () => {
  expect(planLoadoutStart({ ...base, name: "nope", info: { base: [], loadouts: [], errors: ["loadouts: kit.json did not parse, so no loadout can be checked"] } }))
    .toEqual({ refused: "no loadout named nope; kit.json has none (loadouts: kit.json did not parse, so no loadout can be checked)" });
});
test("a skill the machine lacks refuses the start", () => {
  expect(planLoadoutStart({ ...base, name: "needs-missing" })).toEqual({ refused: "loadout needs-missing names nope:gone, which mini does not have" });
});
test("a server the kit cannot give refuses the start with the kit's why", () => {
  expect(planLoadoutStart({ ...base, name: "homelab-ops", entryOf: (s) => (s === "executor" ? { why: "the kit does not put executor on mini" } : { entry: { type: "stdio", command: "bash", args: [] } }) }))
    .toEqual({ refused: "loadout homelab-ops: the kit does not put executor on mini" });
});
test("a claude loadout replaces model and effort and keeps provider, yolo and extra", () => {
  const plan = planLoadoutStart({ ...base, name: "homelab-ops", agent: { ...DEFAULT_AGENT, provider: "zai", extra: "--verbose", yolo: true } });
  expect(plan).toMatchObject({ agent: { harness: "claude", model: "sonnet", effort: "medium", provider: "zai", extra: "--verbose", yolo: true }, canopyTools: false,
    equip: { loadout: "homelab-ops", model: "sonnet", effort: "medium", skills: ["homelab:tailchan"], mcp: ["executor", "wiki-memory"], off: 3 } });
  expect(Object.keys((plan as LoadoutStartPlan).servers)).toEqual(["executor", "wiki-memory"]);
});
test("a harness change drops the route's provider and extra", () => {
  const plan = planLoadoutStart({ ...base, name: "codex-fast", agent: { ...DEFAULT_AGENT, provider: "zai", extra: "--verbose" } }) as LoadoutStartPlan;
  expect(plan.agent).toEqual({ ...DEFAULT_AGENT, harness: "codex", model: "gpt-5.5", effort: "low", extra: "" });
  expect(plan.overrides).toEqual({});
  expect(plan.servers).toEqual({});
});
test("the provider's settings keep everything and take the overrides over their own", () => {
  expect(mergeProviderSettings({ env: { A: "1" }, skillOverrides: { ripe: "on", x: "off" } }, { ripe: "off" }))
    .toEqual({ env: { A: "1" }, skillOverrides: { ripe: "off", x: "off" } });
  expect(mergeProviderSettings(null, { ripe: "off" })).toEqual({ skillOverrides: { ripe: "off" } });
});
```

  `base` is `{ name: "docs", info, agent: DEFAULT_AGENT, skills, machine: "mini", entryOf: () => ({ entry: { type: "stdio", command: "bash", args: [] } }) }`, where `info` holds `docs` (haiku, low), `homelab-ops` (the spec's, base `["verify-build", "homelab:*"]`), `needs-missing` (skills `["nope:gone"]`) and `codex-fast` (harness codex, model `gpt-5.5`, effort low). Pick a codex model `takesModel("codex", …)` accepts.
- [ ] **Step 2: Run them to see them fail.** Run: `bun test src/core/loadout.test.ts`. Expected: FAIL on the new names.
- [ ] **Step 3: Write the three functions.** `skillOverridesFor` reads only claude skills from `user` and `plugin:*`, skips any name that also appears from `project`, sorts the keys, and counts "off" entries. `planLoadoutStart` checks in this order: the name (the refusal lists the loadouts in kit.json's order, `none` when there are none, then ` (<the first error>)` when `info.errors` is not empty), every loadout skill among `skills` (any source, first missing one in the message), every server through `entryOf`. A codex loadout has no overrides and no servers. When the loadout's harness differs from `agent.harness`, the plan's agent has no `provider` and `extra` is `""`. `canopyTools` is the loadout's.
- [ ] **Step 4: Run the tests.** Run: `bun test src/core/loadout.test.ts`. Expected: PASS.
- [ ] **Step 5: Gates and commit.** Message: "Loadouts: plan a start from a loadout, the repo's skills and the kit's servers".

### Task 3: One settings file and several servers on the command line

**Files:**
- Modify: `src/core/runtools.ts:43-46`, `src/server/runtools.ts`, `src/core/driver.ts:58-78`, `src/core/claudedrive.ts:135-170`, `src/server/index.ts:1310` (the one `writeMcpConfig` caller)
- Test: `src/core/runtools.test.ts`, `src/server/runtools.test.ts`, `src/core/claudedrive.test.ts`

**Interfaces:**
- Produces:
  - `core/runtools.ts`: `mcpRule(server: string): string` returning `` `mcp__${server}__*` ``; `CANOPY_TOOL_RULE = mcpRule("canopy")`; `mcpConfigJson(servers: Readonly<Record<string, McpEntry | KitMcpEntry>>): string` writing `{ mcpServers: servers }`.
  - `server/runtools.ts`: `writeMcpConfig(id: string, servers: Readonly<Record<string, McpEntry | KitMcpEntry>>, dir?: string): Promise<string>`; `settingsPath(id: string, dir?: string): string` (`<dir>/<id>.settings.json`); `writeRunSettings(id: string, settings: Record<string, unknown>, dir?: string): Promise<string>` (0600, `wx`, like `writeMcpConfig`); `removeRunSettings(id: string, dir?: string): Promise<void>`; `sweepMcpConfigs` also removes `*.settings.json`.
  - `DriveSpec` gains `settings?: string` ("the run's own settings file, passed as the one `--settings`: a loadout's, holding the provider's settings too") and `servers?: readonly string[]` ("servers the run's mcp.json holds besides canopy's: each is allowed by its `mcp__<name>__*` rule and checked at init").
- Consumes: nothing from Tasks 1 and 2.

- [ ] **Step 1: Write the failing tests.**

```ts
// core/runtools.test.ts
test("mcp.json holds every server it is given", () => {
  expect(JSON.parse(mcpConfigJson({ canopy: { command: "bun", args: [], env: {} }, pdfcraft: { type: "stdio", command: "p", args: ["mcp"] } })))
    .toEqual({ mcpServers: { canopy: { command: "bun", args: [], env: {} }, pdfcraft: { type: "stdio", command: "p", args: ["mcp"] } } });
});
test("a server's rule", () => expect(mcpRule("wiki-memory")).toBe("mcp__wiki-memory__*"));

// server/runtools.test.ts (scratch dir)
test("a run's settings file is 0600 and goes with removeRunSettings and the sweep", async () => {
  const file = await writeRunSettings("r1", { skillOverrides: { ripe: "off" } }, dir);
  expect(file).toBe(settingsPath("r1", dir));
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ skillOverrides: { ripe: "off" } });
  await removeRunSettings("r1", dir);
  expect(existsSync(file)).toBe(false);
  await writeRunSettings("r2", {}, dir);
  await sweepMcpConfigs(dir);
  expect(existsSync(settingsPath("r2", dir))).toBe(false);
});

// core/claudedrive.test.ts
test("a run's own settings file is the one --settings, provider or not", () => {
  const argv = cliArgs({ allowedTools: [], maxTurns: 5, settings: "/c/run-tools/r1.settings.json" }, { ...DEFAULT_AGENT, provider: "zai" });
  expect(argv.filter((a) => a === "--settings")).toHaveLength(1);
  expect(argv[argv.indexOf("--settings") + 1]).toBe("/c/run-tools/r1.settings.json");
});
test("each loadout server is allowed by its own rule", () => {
  const argv = cliArgs({ allowedTools: ["Read"], maxTurns: 5, mcpConfig: "/c/m.json", servers: ["pdfcraft", "wiki-memory"] });
  expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read,mcp__canopy__*,mcp__pdfcraft__*,mcp__wiki-memory__*");
});
```

  The provider test needs `zai` to be a provider `takesProvider("claude", …)` accepts and a `providersDir()` that resolves; if the fixture cannot make one, assert instead that without `settings` the provider's `--settings` is there and with it only the run's is.
- [ ] **Step 2: Run them to see them fail.** Run: `bun test src/core/runtools.test.ts src/server/runtools.test.ts src/core/claudedrive.test.ts`. Expected: FAIL.
- [ ] **Step 3: Make the changes.** In `cliArgs`, with `spec.settings` set, build the flags from the agent without `withProviderFile` and put `"--settings", spec.settings` among them; the allowed list is `spec.allowedTools`, then `CANOPY_TOOL_RULE` when `spec.mcpConfig` is set (as today), then `mcpRule(s)` for each of `spec.servers`. The `runTools` caller in `server/index.ts` passes `{ canopy: { ...canopyMcpCommand(), env: … } }`.
- [ ] **Step 4: Run the tests.** Same command. Expected: PASS, and the rest of `claudedrive.test.ts` and `runtools-route.test.ts` still pass.
- [ ] **Step 5: Gates and commit.** Message: "Run launch: one settings file of its own and an mcp.json of several servers".

### Task 4: A loadout server that did not start ends the run

**Files:**
- Modify: `src/core/claudedrive.ts` (the init branch at about line 348), `src/core/testdata/fake-claude.ts`
- Test: `src/core/claudedrive.test.ts`

**Interfaces:**
- Produces: `serversDown(init: Record<string, unknown>, want: readonly string[]): string[]`, exported from `claudedrive.ts`, answering `"<name> (<status>)"` for each wanted server whose `mcp_servers` entry is missing (`"absent"`) or not `"connected"`, in `want`'s order.
- Consumes: `DriveSpec.servers` (Task 3).

- [ ] **Step 1: Write the failing tests.** `fake-claude.ts` reads `FAKE_CLAUDE_MCP`, a JSON list of `{ name, status }`, and puts it in its init message as `mcp_servers` (absent: no field, as today). The driver harness in `claudedrive.test.ts` takes `opts.spec` (a partial `DriveSpec`) laid over its default spec.

```ts
test("serversDown names each wanted server that is not connected", () => {
  const init = { mcp_servers: [{ name: "pdfcraft", status: "connected" }, { name: "executor", status: "failed" }] };
  expect(serversDown(init, ["pdfcraft", "executor", "wiki-memory"])).toEqual(["executor (failed)", "wiki-memory (absent)"]);
  expect(serversDown({}, [])).toEqual([]);
});
test("a run whose loadout server failed ends failed, naming it", async () => {
  const { until } = await drive("chat", "hi", { spec: { servers: ["executor"] }, env: { FAKE_CLAUDE_MCP: JSON.stringify([{ name: "executor", status: "failed" }]) } });
  const run = await until((r) => r.status === "failed", "the failed run");
  expect(run.error).toContain("a loadout server did not start here: executor (failed)");
});
test("a run whose loadout servers connected goes on", async () => {
  const { until } = await drive("chat", "hi", { spec: { servers: ["executor"] }, env: { FAKE_CLAUDE_MCP: JSON.stringify([{ name: "executor", status: "connected" }]) } });
  await until((r) => r.status === "idle", "the chat's first answer");
});
```

  Use the harness's own name for its start function and its chat mode; the names above are placeholders for that harness's.
- [ ] **Step 2: Run them to see them fail.** Run: `bun test src/core/claudedrive.test.ts -t "loadout server|serversDown"`. Expected: FAIL.
- [ ] **Step 3: Write it.** In the init branch, when `serversDown(m, ctx.spec.servers ?? [])` is not empty, kill the process and throw `new Error(`a loadout server did not start here: ${down.join(", ")}`)`; the drive's catch hands it to `ctx.exited` as `error`.
- [ ] **Step 4: Run the tests.** Run: `bun test src/core/claudedrive.test.ts`. Expected: PASS.
- [ ] **Step 5: Gates and commit.** Message: "Run launch: a loadout server that did not start ends the run at init".

### Task 5: The kit carries loadouts, and GET /api/loadouts

**Files:**
- Modify: `src/server/kit.ts` (`read` at line 115, `doScan` at 133, every place that sets `this.last`), `src/server/index.ts` (beside the `/api/kit` dispatch at about line 3939)
- Test: `src/server/kit.test.ts`

**Interfaces:**
- Consumes: `parseLoadouts`, `EMPTY_LOADOUTS` (Task 1); `buildEntry`, `mcpWanted` from `core/kit.ts`.
- Produces, on `KitHub`:
  - `loadouts(): LoadoutsInfo`, also carried as `KitInfo.loadouts` in every `kit` event and `GET /api/kit`.
  - `machineName(): string | null`: the kit machine whose `backend` is this backend (`m.backend === deps.self`).
  - `runEntry(server: string): { entry: KitMcpEntry } | { why: string }`, the entry a run on this backend gets: `buildEntry(s, "claude", "claude-json", deps.hostHome ?? homedir(), deps.procEnv ?? process.env)` when `mcpWanted(s, "claude", machine)`.
  - Route `GET /api/loadouts` answering `state.kit.loadouts()`. A GET defaults to the read right, so `core/callers.ts` needs no entry.

- [ ] **Step 1: Write the failing tests** in `src/server/kit.test.ts`, with its `setup()` and a manifest holding `loadouts` and an `mcp` block with `probe` (`command: "~/bin/probe"`, machines `["mac"]`) and `elsewhere` (machines `["gpd"]`), `self` matching the `mac` machine's `backend`, and `hostHome: "/home/eric"`.

```ts
test("the scan carries the parsed loadouts", async () => {
  const hub = await setup(withLoadouts);
  await hub.scan();
  expect(hub.loadouts().loadouts.map((l) => l.name)).toEqual(["docs"]);
  expect(hub.info().loadouts?.loadouts.map((l) => l.name)).toEqual(["docs"]);
});
test("a kit.json that does not parse leaves no loadouts and says why", async () => {
  const hub = await setup("{ not json");
  await hub.scan();
  expect(hub.loadouts().loadouts).toEqual([]);
  expect(hub.loadouts().errors[0]).toStartWith("kit.json: ");
});
test("runEntry builds the claude entry with the host's home", async () => {
  const hub = await setup(withLoadouts);
  await hub.scan();
  expect(hub.machineName()).toBe("mac");
  expect(hub.runEntry("probe")).toEqual({ entry: { type: "stdio", command: "/home/eric/bin/probe", args: [] } });
  expect(hub.runEntry("elsewhere")).toEqual({ why: "the kit does not put elsewhere on mac" });
  expect(hub.runEntry("nope")).toEqual({ why: "no server named nope in the kit" });
});
```

  A backend that is no kit machine answers `{ why: "this backend is not a machine in kit.json" }`; a `buildEntry` refusal answers its `why`. Add a test for each.
- [ ] **Step 2: Run them to see them fail.** Run: `bun test src/server/kit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write it.** `read()` keeps the raw JSON so `doScan` sets the loadouts from `parseLoadouts(raw, withCanopyServer(kit))`; on a read or parse failure they are `{ ...EMPTY_LOADOUTS, errors: [<the KitError's message>] }`.
- [ ] **Step 4: Run the tests.** Same command. Expected: PASS.
- [ ] **Step 5: Gates and commit.** Message: "Kit: loadouts in KitInfo, the run entry for a server, GET /api/loadouts".

### Task 6: Starting a run with a loadout

**Files:**
- Modify: `src/core/runner.ts` (`StartExtras` at line 83, the run record at 433-450, `driveSpec` at 467), `src/core/runlog.ts` (`isRun` at 83, `snapshot` at about 150), `src/server/index.ts` (`startRepoRun` at 1206, `RunStartHow` at 1281, `runTools` at 1305, `dropRunTools` at 1319, the run route at 5392, the end cleanup at 5915)
- Test: create `src/server/loadout-route.test.ts`, copying the setup of `src/server/runtools-route.test.ts`

**Interfaces:**
- Consumes: `planLoadoutStart`, `mergeProviderSettings` (Task 2); `writeRunSettings`, `removeRunSettings`, `writeMcpConfig` (Task 3); `KitHub.loadouts`, `machineName`, `runEntry` (Task 5); `listMentions` from `core/mentions.ts`; `providersDir` from `core/store.ts`.
- Produces:
  - `StartExtras` gains `canopy?: true` (set by `runTools`; the runner sets `run.canopyTools` from it, no longer from `mcpConfig`), `settings?: string`, `servers?: readonly string[]` and `equip?: RunEquip`. The runner copies `settings` and `servers` into the `DriveSpec` and `equip` onto the run.
  - `RunStartHow` gains `loadout?: string`.
  - The run route takes `loadout` (a string); `canopy run` and the page send it (Tasks 7 and 8).

- [ ] **Step 1: Write the failing tests.** The scratch kit.json (set as `CANOPY_KIT` before `startServer`) has one machine whose `backend` is `selfName(null, hostname())` from `core/backends.ts`, a server `probe` (`command: "bash"`, `args: ["-c", "true"]`) and these loadouts: `docs` (model haiku, effort low, skills `["repo-skill"]`), `tools` (skills `["repo-skill"]`, mcp `["probe"]`), `missing` (skills `["nope-xyz"]`). The scratch repo has `.claude/skills/repo-skill/SKILL.md`. Wait for `GET /api/loadouts` to list them before the first start. The `HeldDriver` captures each `DriveCtx`.

```ts
test("a loadout run starts with its model, effort and one settings file", async () => {
  const run = await post(`/api/repos/run?id=${repo}`, { action: "ask", note: "x", branch: true, loadout: "docs" });
  expect(run.status).toBe(201);
  const ctx = driver.last();
  expect(ctx.agent).toMatchObject({ model: "haiku", effort: "low" });
  const settings = JSON.parse(await readFile(ctx.spec.settings!, "utf8")) as { skillOverrides: Record<string, string> };
  expect(settings.skillOverrides["repo-skill"]).toBe("on");
  expect(Object.entries(settings.skillOverrides).filter(([k]) => k !== "repo-skill").every(([, v]) => v === "off")).toBe(true);
  expect(run.body.equip).toEqual({ loadout: "docs", model: "haiku", effort: "low", skills: ["repo-skill"], mcp: [], off: expect.any(Number) });
});
test("a loadout's servers go in the run's mcp.json, without canopy's unless asked", async () => {
  const run = await post(`/api/repos/run?id=${repo}`, { action: "ask", note: "x", branch: true, loadout: "tools" });
  const ctx = driver.last();
  expect(Object.keys(JSON.parse(await readFile(ctx.spec.mcpConfig!, "utf8")).mcpServers)).toEqual(["probe"]);
  expect(ctx.spec.servers).toEqual(["probe"]);
  expect(run.body.canopyTools).toBeUndefined();
});
test("the files go when the run stops", async () => {
  const run = await post(`/api/repos/run?id=${repo}`, { action: "ask", note: "x", branch: true, loadout: "tools" });
  const { settings, mcpConfig } = driver.last().spec;
  await post("/api/runs/stop", { id: run.body.id });
  await until(() => !existsSync(settings!) && !existsSync(mcpConfig!), "the run's files to go");
});
test.each([
  [{ loadout: "nope" }, 400, "no loadout named nope; kit.json has docs, tools, missing"],
  [{ loadout: "missing" }, 400, "loadout missing names nope-xyz, which"],
  [{ loadout: "docs", times: 2 }, 400, "a loadout starts one run; a group picks a profile per member"],
  [{ loadout: 7 }, 400, "loadout must be a loadout's name"],
])("%j is refused", async (extra, status, words) => {
  const res = await post(`/api/repos/run?id=${repo}`, { action: "ask", note: "x", branch: true, ...extra });
  expect(res.status).toBe(status);
  expect(res.body.error).toContain(words);
});
test("a provider whose settings file cannot be read refuses the start", async () => {
  // set the repo's job route to a claude provider whose providers/<id>.json is absent or not JSON
  const res = await post(`/api/repos/run?id=${repo}`, { action: "ask", note: "x", branch: true, loadout: "docs" });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain(".json");
});
test("the kept run.json keeps equip", async () => {
  // start with docs, stop it, read <config>/runs/<id>/run.json
  expect(kept.equip).toMatchObject({ loadout: "docs", model: "haiku" });
});
```

  Use the helper names the copied test file already has for posting, waiting and the held driver.
- [ ] **Step 2: Run them to see them fail.** Run: `bun test src/server/loadout-route.test.ts`. Expected: FAIL.
- [ ] **Step 3: Wire the start.** In `startRepoRun`, after the agent is resolved and before `needHarness`: with `how.loadout`, read the skills (`listMentions(repo.path)` for a claude loadout, `[]` otherwise), call `planLoadoutStart` with `machine: state.kit.machineName() ?? hostname()` and `entryOf: (s) => state.kit.runEntry(s)`, throw `HttpError(400, refused)` on a refusal, and go on with the plan's agent. The run's id is chosen up front. The tools decision becomes `how.tools ?? (plan ? plan.canopyTools : agent.canopyTools === true)`. With a plan for claude: read `${providersDir()}/${agent.provider}.json` when the agent names a claude provider (unreadable or not JSON: `HttpError(400, "provider <id>'s settings file <path> cannot be read: <reason>")`), write `mergeProviderSettings(provider, plan.overrides)` with `writeRunSettings`, and write the servers into the run's `mcp.json`: through `runTools` (which takes the extra servers beside canopy's) when tools are on, else `writeMcpConfig(id, plan.servers)` when there are any. The release on a failed start removes both files. The route parses `loadout` (`typeof b.loadout === "string" && LOADOUT_NAME.test(b.loadout)`, else 400 "loadout must be a loadout's name") and refuses it with `times > 1` or `action: "coordinate"`. `dropRunTools` also calls `removeRunSettings`, and the end cleanup runs it when `run.canopyTools || run.equip`. `runlog.ts` keeps `equip` (strings through the redacting `r`, as `agentSettings` does) and `isRun` checks it.
- [ ] **Step 4: Run the tests.** Run: `bun test src/server/loadout-route.test.ts src/server/runtools-route.test.ts src/core/runner*.test.ts src/core/runlog.test.ts`. Expected: PASS.
- [ ] **Step 5: Gates and commit.** Message: "Runs: start one with a loadout from kit.json (FR-065 phase 1)".

### Task 7: canopy loadouts and canopy run --loadout

**Files:**
- Modify: `src/cli/run.ts` (`parseRunArgs` at 39, the body at 220), `src/cli/index.ts` (the command switch near line 930 and the usage text)
- Create: `src/cli/loadouts.ts`
- Test: `src/cli/run.test.ts`, create `src/cli/loadouts.test.ts`

**Interfaces:**
- Consumes: `LoadoutsInfo` (Task 1), `GET /api/loadouts` (Task 5), the route's `loadout` (Task 6).
- Produces: `RunArgs.loadout?: string`; `loadoutLines(info: LoadoutsInfo): string[]`; `canopy loadouts [--json] [--backend URL | --on NAME]`.

- [ ] **Step 1: Write the failing tests.**

```ts
// run.test.ts
test("--loadout names the run's loadout", () => {
  expect(parseRunArgs(["canopy", "ask", "--loadout", "docs"])).toMatchObject({ loadout: "docs" });
});
test.each([
  [["canopy", "ask", "--loadout"], "--loadout needs a name"],
  [["canopy", "ask", "--loadout", "docs", "--times", "2"], "--loadout starts one run; use --profiles for a group"],
])("%j is refused", (argv, why) => expect(parseRunArgs(argv)).toBe(why));

// loadouts.test.ts
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
```

  Pad the name and agent columns to the longest in the list, as the test shows; a loadout with no servers and no canopy tools prints no server column.
- [ ] **Step 2: Run them to see them fail.** Run: `bun test src/cli/run.test.ts src/cli/loadouts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write it.** A line is its fields joined by two spaces, empty ones left out: the name and the agent (`harness model effort`), each padded to the longest in the list; the skill count (`1 skill`, `n skills`); the servers and then `canopy tools` when on, joined by `, `; the note. Then `always on: <base joined by , >` when the base is not empty, then `error: <line>` per error. The body sends `loadout` when set. `canopy loadouts` asks `GET /api/loadouts` on the selected backend and prints `loadoutLines`, or the JSON with `--json`; with no loadouts and no errors it prints "no loadouts in kit.json". Add both to the usage text beside `canopy run`.
- [ ] **Step 4: Run the tests.** Same command. Expected: PASS.
- [ ] **Step 5: Gates and commit.** Message: "CLI: canopy loadouts, and canopy run --loadout".

### Task 8: Pick a loadout in the plan sheet, see it on the run

**Files:**
- Create: `ui/src/loadouts.ts`, `ui/src/loadouts.test.ts`
- Modify: `ui/src/api.ts:936` (`run`), `ui/src/store.ts:1615` and `:5248` (`startRun`), `ui/src/components/RunSheet.tsx` (`Plan` at 280, the sheet head at about 649), `ui/src/components/RunChip.tsx:23`, `ui/src/styles.css` only if the select needs a rule

**Interfaces:**
- Consumes: `KitInfo.loadouts` (already in `s.kit[backend]` from the `kit` event and `loadKit`), `Run.equip`, the route's `loadout`.
- Produces: `loadoutLabel(l: Loadout): string`, `equipTitle(e: RunEquip): string`; `api.run(..., canopyTools?, loadout?)` and `startRun(..., canopyTools?, loadout?)` with `loadout` last.

- [ ] **Step 1: Write the failing tests** in `ui/src/loadouts.test.ts`.

```ts
test("a label names the model and effort only when they are not the default", () => {
  expect(loadoutLabel(L({ name: "homelab-ops", model: "sonnet", effort: "medium" }))).toBe("homelab-ops (sonnet, medium)");
  expect(loadoutLabel(L({ name: "docs" }))).toBe("docs");
  expect(loadoutLabel(L({ name: "fast", harness: "codex", model: "gpt-5.5" }))).toBe("fast (codex, gpt-5.5)");
});
test("a run's equip as a title, one line each", () => {
  expect(equipTitle({ loadout: "homelab-ops", model: "sonnet", effort: "medium", skills: ["homelab:tailchan"], mcp: ["executor"], off: 42 }))
    .toBe("loadout homelab-ops\nsonnet, medium\nskills: homelab:tailchan\nservers: executor\n42 skills off");
});
```

- [ ] **Step 2: Run them to see them fail.** Run: `bun test ui/src/loadouts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Build the pick and the chip.** `loadoutLabel` is the name, then in parentheses whichever of these apply, joined by `, `: the harness when it is not claude, the model and the effort when not `default`. `equipTitle` is one line each: `loadout <name>`, the model and effort, `skills: …` and `servers: …` when not empty, `<n> skills off`. In `Plan`, read `useStore((s) => s.kit[backendOf(repo.id)]?.loadouts?.loadouts ?? [])`. When that list is not empty and the run is one plain run (`!coordinate && !workspace && !repo.host && !repo.forge && times === 1`), show a `label.plan-branch` holding "loadout" and a `select` whose first option (value `""`) is "the repo's route" and then one option per loadout, text `loadoutLabel(l)`, title `l.note`. With one picked: the agent fact chip shows `loadoutLabel` in place of `describeAgent(agent)`, `ToolsPreflight` defaults to the loadout's `canopyTools`, and `go()` passes the name to `startRun`. The sheet head shows a `span.branch` with `run.equip.loadout` and `title={equipTitle(run.equip)}` when the run has `equip`; `RunChip`'s title gains a line `loadout <name>`.
- [ ] **Step 4: Run the tests.** Run: `bun test ui/src/loadouts.test.ts`. Expected: PASS.
- [ ] **Step 5: Watch it in a browser.** `bun run build`, then start a scratch server on a free port with a short `CANOPY_CONFIG_DIR` (under `/tmp`, since the tmux socket path has a length limit) and `CANOPY_KIT` pointing at a scratch kit.json with two loadouts, over a scratch root holding one git repo. Drive it with Playwright (`playwright-core` and the installed Chromium): open the repo's ask plan sheet at 1440 px and at 390 px, pick each loadout, and screenshot the sheet. Expected: the select lists both loadouts, the agent chip follows the pick, and on the phone the select fits the sheet with no sideways scroll. Look at the screenshots before going on.
- [ ] **Step 6: Gates and commit.** Message: "Plan sheet: pick a loadout; the run sheet and chip name it".

### Task 9: Docs, a real run, and ship

**Files:**
- Modify: `docs/architecture.md` (the "## The kit" section: a Loadouts paragraph; find the run start's section with `grep -n '^## ' docs/architecture.md` and add the settings file and the init check), `SPEC.md` ("Data and state": `run-tools/<id>.settings.json`; the stack line on launch flags if it names them), `README.md` (`canopy loadouts`, `canopy run --loadout`, the plan sheet's loadout pick), `FEATURES.md` (FR-065: phase 1 shipped, with the date), `docs/superpowers/specs/2026-11-12-manager-design.md` ("Phases" item 1: shipped, with the commit), `docs/superpowers/plans/README.md` (a row for this plan) and this plan's Status line.

- [ ] **Step 1: Write the docs** above, each true of the code as merged.
- [ ] **Step 2: A real run.** Add a `docs` loadout to the scratch kit (model haiku, effort low, one user skill) and start a run with the real `claude` on the scratch server: `canopy run <repo> ask --loadout docs -m "Reply with the names of the skills you can use, comma separated"` with `--backend` at the scratch server. Read the run's wire (`canopy run show <id> --wire`): the init message's `skills` holds the loadout's skill and the repo's, and none of the user skills turned off. Then a loadout naming a server that cannot start (`command: "false"`) ends failed with "a loadout server did not start here". Record both outcomes in this plan's Status line.
- [ ] **Step 3: Gates.** `bun run typecheck && bun run lint && bun test && bun run build`. Expected: all pass.
- [ ] **Step 4: Commit, merge and push.** Commit the docs ("Loadouts: docs, plan status"), merge the branch into `main` from the main checkout, push, then remove the kept worktree with `canopy worktrees rm canopy manager-loadouts --delete-branch`.
- [ ] **Step 5: Deploy.** From the main checkout: `bun run build` (the Mac's server serves `dist/web`), then `bun run redeploy` for the mini without `--force`; on exit 4 wait for the live run, flow or landing to end and try again. The Mac's launchd server runs the new server code only after a restart, which locks its secrets key until Eric unlocks it.

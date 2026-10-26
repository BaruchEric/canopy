import { describe, expect, test } from "bun:test";
import { DEFAULT_RUN, DEFAULT_SETTINGS, parseScenario, parseScenarioSet, parseScenariosFile, scenarioTemplate, scoreOf } from "./scenario";

const cmd = `---\nname: checkout-flow\nkind: command\nrun: bun test "$SCENARIO_DIR/checkout.test.ts"\n---\n`;
const judge = `---\nname: refund\nkind: judge\nevidence: src/refund.ts src/mail.ts\n---\nA customer asks for a refund.\n`;

describe("parseScenario", () => {
  test("both kinds", () => {
    expect(parseScenario("checkout-flow.md", cmd)).toEqual({ name: "checkout-flow", kind: "command", run: 'bun test "$SCENARIO_DIR/checkout.test.ts"', evidence: [], body: "" });
    expect(parseScenario("refund.md", judge)).toEqual({ name: "refund", kind: "judge", evidence: ["src/refund.ts", "src/mail.ts"], body: "A customer asks for a refund." });
  });
  test("kind defaults to command and run is optional", () => {
    expect(parseScenario("a.md", "---\nname: a\n---\n")).toEqual({ name: "a", kind: "command", evidence: [], body: "" });
  });
  test("a missing or bad name", () => {
    expect(parseScenario("a.md", "---\nkind: command\n---\n")).toEqual({ error: "a.md: name must be a short name of letters, digits, dots, dashes or underscores" });
    expect(parseScenario("a.md", "---\nname: ../x\n---\n")).toEqual({ error: "a.md: name must be a short name of letters, digits, dots, dashes or underscores" });
  });
  test("a run line naming a CANOPY_ variable is refused", () => {
    expect(parseScenario("a.md", "---\nname: a\nrun: cat $CANOPY_CONFIG_DIR/callers.json\n---\n")).toEqual({ error: "a.md: run must not name a CANOPY_ variable" });
  });
  test("evidence outside the repo, or on a command scenario, is refused", () => {
    expect(parseScenario("a.md", "---\nname: a\nkind: judge\nevidence: /etc/passwd\n---\nstory\n")).toEqual({ error: "a.md: evidence must be paths inside the repo, not /etc/passwd" });
    expect(parseScenario("a.md", "---\nname: a\nkind: judge\nevidence: src/../../x\n---\nstory\n")).toEqual({ error: "a.md: evidence must be paths inside the repo, not src/../../x" });
    expect(parseScenario("a.md", "---\nname: a\nevidence: src/x.ts\n---\n")).toEqual({ error: "a.md: evidence is only read by kind: judge" });
  });
  test("a judge scenario needs a story", () => {
    expect(parseScenario("a.md", "---\nname: a\nkind: judge\n---\n\n")).toEqual({ error: "a.md: a judge scenario needs a story below the frontmatter" });
  });
  test("no frontmatter is the workflow parser's error", () => {
    expect(parseScenario("a.md", "name: a\n")).toEqual({ error: "no frontmatter: the file must start with a --- block" });
  });
});

describe("parseScenarioSet", () => {
  test("a bad file is named and the rest are kept, in file name order", () => {
    const set = parseScenarioSet([{ file: "b.md", text: cmd.replace("checkout-flow", "b") }, { file: "broken.md", text: "nope" }, { file: "a.md", text: cmd.replace("checkout-flow", "a") }]);
    expect(set.scenarios.map((s) => s.name)).toEqual(["a", "b"]);
    expect(set.errors).toEqual([{ file: "broken.md", error: "no frontmatter: the file must start with a --- block" }]);
  });
  test("two files with one name: the second is an error", () => {
    const set = parseScenarioSet([{ file: "a.md", text: cmd }, { file: "b.md", text: cmd }]);
    expect(set.scenarios).toHaveLength(1);
    expect(set.errors).toEqual([{ file: "b.md", error: "b.md: a scenario named checkout-flow is in a.md already" }]);
  });
});

describe("parseScenariosFile", () => {
  test("defaults and limits", () => {
    expect(parseScenariosFile("{}")).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ run: DEFAULT_RUN, judge: "jev", minimum: 1, timeout: 600 });
    expect(parseScenariosFile('{"run": "make e2e", "judge": "off", "minimum": 0.8, "timeout": 1800}')).toEqual({ run: "make e2e", judge: "off", minimum: 0.8, timeout: 1800 });
    expect(parseScenariosFile('{"timeout": 1801}')).toEqual({ error: ".canopy/scenarios.json: timeout must be at most 1800 seconds" });
    expect(parseScenariosFile('{"minimum": 2}')).toEqual({ error: ".canopy/scenarios.json: minimum must be a number from 0 to 1" });
    expect(parseScenariosFile('{"judge": "claude"}')).toEqual({ error: ".canopy/scenarios.json: judge must be jev or off" });
    expect(parseScenariosFile('{"run": "echo $CANOPY_API"}')).toEqual({ error: ".canopy/scenarios.json: run must not name a CANOPY_ variable" });
    expect(parseScenariosFile("[]")).toEqual({ error: ".canopy/scenarios.json must be an object" });
    expect("error" in parseScenariosFile("{")).toBe(true);
  });
});

test("scenarioTemplate", () => {
  expect(scenarioTemplate("checkout-flow", "command")).toBe("---\nname: checkout-flow\nkind: command\n---\n");
  expect(scenarioTemplate("checkout-flow", "command", "make e2e")).toBe("---\nname: checkout-flow\nkind: command\nrun: make e2e\n---\n");
  expect(scenarioTemplate("refund", "judge")).toBe("---\nname: refund\nkind: judge\n---\nWhat a user does, and what they should see when it works.\n");
});

test("scoreOf is the mean over total, with unrun scenarios at 0", () => {
  const r = (ok: boolean, p?: number) => ({ name: "x", kind: "command" as const, ok, ...(p !== undefined ? { p } : {}) });
  expect(scoreOf([])).toBe(1);
  expect(scoreOf([r(true), r(false), r(true)])).toBeCloseTo(2 / 3);
  expect(scoreOf([r(true), r(true, 0.5)], 4)).toBeCloseTo(0.375);
});

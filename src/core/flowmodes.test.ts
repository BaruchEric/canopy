import { describe, expect, test } from "bun:test";
import { applyModes, FLOW_MODES_FILE, parseFlowModes } from "./flowmodes";
import { parseWorkflow } from "./workflow";

const SHIP = `---\nblurb: b\n---\n\n## Gates\ncheck: @gates\n\n## Commit\n\ncommit\n\n## Push\nmode: manual\n\npush\n`;
const ship = () => {
  const e = parseWorkflow(SHIP, { name: "ship", source: "bundled", file: "/ship.md" });
  if (!e.ok) throw new Error(e.error);
  return e.workflow;
};

describe("parseFlowModes", () => {
  test("the shape, and an empty file", () => {
    expect(parseFlowModes('{"modes":{"ship":{"Push":"manual"},"*":{"Deploy":"manual"}}}')).toEqual({ ship: { Push: "manual" }, "*": { Deploy: "manual" } });
    expect(parseFlowModes("{}")).toEqual({});
  });
  test.each<[string, string]>([
    ["[]", `${FLOW_MODES_FILE} must be an object`],
    ['{"modes":[]}', `${FLOW_MODES_FILE}: modes must be an object of workflow names`],
    ['{"modes":{"ship":"manual"}}', `${FLOW_MODES_FILE}: modes.ship must be an object of step names`],
    ['{"modes":{"ship":{"Push":"sometimes"}}}', `${FLOW_MODES_FILE}: modes.ship.Push must be auto or manual, not sometimes`],
  ])("refuses %s", (text, error) => {
    expect(parseFlowModes(text)).toEqual({ error });
  });
  test("not JSON", () => {
    const r = parseFlowModes("{");
    expect("error" in r && typeof r.error === "string" && r.error.startsWith(`${FLOW_MODES_FILE} is not JSON: `)).toBe(true);
  });
});

describe("applyModes", () => {
  test("the workflow's entry wins over *, the repo's say is marked, and the file's mode can be put back to auto", () => {
    const wf = ship();
    const { workflow, warnings } = applyModes(wf, { ship: { Commit: "manual", Push: "auto" }, "*": { Commit: "auto", Gates: "manual" } });
    expect(workflow.steps.map((s) => [s.mode, s.modeFrom])).toEqual([["manual", "repo"], ["manual", "repo"], ["auto", "repo"]]);
    expect(warnings).toEqual([]);
    expect(wf.steps.map((s) => s.mode)).toEqual(["auto", "auto", "manual"]);
    expect(wf.steps[0]).not.toHaveProperty("modeFrom");
  });
  test("an entry that names no step is a warning, and * never warns", () => {
    const { workflow, warnings } = applyModes(ship(), { ship: { Deploy: "manual" }, "*": { Nowhere: "manual" } });
    expect(warnings).toEqual([`${FLOW_MODES_FILE}: modes.ship.Deploy names no step of ship`]);
    expect(workflow.steps.map((s) => s.mode)).toEqual(["auto", "auto", "manual"]);
  });
  test("no modes leaves the workflow as it was", () => {
    const wf = ship();
    expect(applyModes(wf, {})).toEqual({ workflow: wf, warnings: [] });
  });
  test("a step named after an object property does not inherit a mode", () => {
    const wf = ship();
    const namedToString = { ...wf, steps: wf.steps.map((step) => (step.name === "Commit" ? { ...step, name: "toString" } : step)) };
    const { workflow } = applyModes(namedToString, { ship: { Commit: "manual" } });
    expect(workflow.steps.find((step) => step.name === "toString")?.mode).toBe("auto");
  });
});

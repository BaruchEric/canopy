/**
 * The buttons a park and a gate draw, rendered from the real components:
 * the project's sheet and the flow's sheet. What each says and which comes
 * first is what keeps a hurried "continue" from deploying a build the judge
 * refused (incubator review, P1).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Flow, FlowStep, Sprout } from "../../../src/core/types";
import { useStore } from "../store";
import { FlowConsole } from "./FlowSheet";
import { SproutSheet } from "./IncubatorSheets";

const pristine = useStore.getState();

function renderCurrent(node: ReactNode): string {
  const initial = useStore.getInitialState();
  const before = { ...initial };
  Object.assign(initial, useStore.getState());
  try {
    return renderToStaticMarkup(node);
  } finally {
    Object.assign(initial, before);
  }
}

/** every small button in the markup, in order, a star on the strong one */
const buttons = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*class="mini( strong)?"[^>]*>([^<]*)<\/button>/g)].map((m) => `${m[1] ? "*" : ""}${(m[2] ?? "").trim()}`);

const refused: FlowStep = {
  name: "Accept",
  status: "gated",
  reason: "the judge says it only partly meets the intent",
  summary: "The export button is missing.",
  judgment: { answers: { fit: { choice: "partly", probabilities: {} }, evidence: { probability: 0.9 }, rules: { probability: 0 } }, go: false, rejected: false, reason: "only partly" },
};
const flow = (over: Partial<Flow> = {}): Flow => ({
  id: "f9", repoId: "_incubator/coins", workflow: "build-new", verb: "build", note: "", status: "gated",
  steps: [{ name: "Scaffold", status: "passed" }, { name: "Test", status: "passed" }, refused],
  current: 2, startedAt: 0, backTo: "Scaffold", ...over,
});
const sprout = (over: Partial<Sprout> = {}): Sprout => ({
  id: "sp_000000000001", slug: "coins", title: "Coin counter", status: "parked", parked: "build-new waits after Accept: the judge says it only partly meets the intent",
  repoId: "_incubator/coins", seedPath: "/root/_incubator/coins", prepared: true, inputs: [], clarified: true, reclarify: false,
  flows: [{ workflow: "build-new", flowId: "f9" }], spent: { runs: 3, workMs: 60_000 }, createdAt: 1, updatedAt: 2, ...over,
});

describe("a park's and a gate's buttons, as drawn", () => {
  afterEach(() => {
    useStore.setState({ sprouts: pristine.sprouts, flows: pristine.flows });
  });

  test("the project sheet at a build the judge refused: the way back first, the deploy second and named, and its stop ends the project (FR-062)", () => {
    useStore.setState({ sprouts: { sp_000000000001: sprout() }, flows: { f9: flow() } });
    const drawn = buttons(renderCurrent(<SproutSheet id="sp_000000000001" />));
    expect(drawn.slice(0, 3)).toEqual(["*send it back to Scaffold", "deploy it anyway", "end the project"]);
    expect(drawn).not.toContain("*continue");
  });

  test("the project sheet at a step whose run failed, and at a park with no flow waiting: one way on", () => {
    useStore.setState({ sprouts: { sp_000000000001: sprout() }, flows: { f9: flow({ parkedFor: "failed", backTo: undefined }) } });
    expect(buttons(renderCurrent(<SproutSheet id="sp_000000000001" />)).slice(0, 2)).toEqual(["*run the step again", "end the project"]);
    useStore.setState({ sprouts: { sp_000000000001: sprout({ parked: "deploy: no scope", flows: [{ workflow: "build-new", flowId: "f9", outcome: "done" }] }) }, flows: {} });
    expect(buttons(renderCurrent(<SproutSheet id="sp_000000000001" />)).slice(0, 2)).toEqual(["*resume", "end the project"]);
  });

  test("the flow sheet's gate draws the same words", () => {
    useStore.setState({ flows: { f9: flow() } });
    const drawn = buttons(renderCurrent(<FlowConsole flowId="f9" />));
    expect(drawn).toContain("*send it back to Scaffold");
    expect(drawn.indexOf("*send it back to Scaffold")).toBeLessThan(drawn.indexOf("accept and finish anyway"));
    expect(drawn).toContain("stop here");
  });
});

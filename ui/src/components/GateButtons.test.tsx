/**
 * The buttons a park and a gate draw, rendered from the real components:
 * the project's sheet and the flow's sheet. What each says and which comes
 * first is what keeps a hurried "continue" from deploying a build the judge
 * refused (incubator review, P1). A gate takes one answer at a time, so a
 * double tap never starts a manual step nobody gave its go.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useState, type ReactNode } from "react";
import type { Flow, FlowStep, Sprout } from "../../../src/core/types";
import { useStore } from "../store";
import { FlowConsole, gateAt, GateChoices, oneAtATime, useGateGuard } from "./FlowSheet";
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
    const html = renderCurrent(<FlowConsole flowId="f9" />);
    const drawn = buttons(html);
    expect(drawn).toContain("*send it back to Scaffold");
    expect(drawn.indexOf("*send it back to Scaffold")).toBeLessThan(drawn.indexOf("accept and finish anyway"));
    expect(drawn).toContain("stop here");
    // a gate as first drawn takes an answer
    expect(offCount(gateRow(html))).toBe(0);
  });
});

/** the flow sheet's row of gate buttons */
function gateRow(html: string): string {
  const start = html.indexOf('<div class="gate-buttons">');
  if (start < 0) throw new Error("no gate buttons in the markup");
  return html.slice(start, html.indexOf("</div>", start));
}

/** how many buttons in the markup are off */
const offCount = (html: string): number => [...html.matchAll(/<button[^>]*>/g)].filter((m) => m[0].includes('disabled=""')).length;

/** a ship flow at its Review gate, with a manual Deploy after it */
const reviewed = (over: Partial<Flow> = {}): Flow => ({
  id: "f2", repoId: "canopy", workflow: "ship", verb: "ship", note: "", status: "gated",
  steps: [{ name: "Review", status: "gated", reason: "the reviewer wants a look" }, { name: "Deploy", status: "pending" }],
  current: 0, startedAt: 0, ...over,
});
/** the same flow once a continue passed Review: Deploy waits for its go */
const held = reviewed({ steps: [{ name: "Review", status: "passed" }, { name: "Deploy", status: "held", reason: "Deploy waits for your go" }], current: 1 });

describe("a gate takes one answer at a time", () => {
  test("a gate moves when a continue brings a manual step up, its status changes or its park's cause does; not for a new summary", () => {
    expect(gateAt(held)).not.toBe(gateAt(reviewed()));
    expect(gateAt(reviewed({ status: "working" }))).not.toBe(gateAt(reviewed()));
    expect(gateAt(reviewed({ parkedFor: "budget" }))).not.toBe(gateAt(reviewed()));
    expect(gateAt({ ...reviewed(), id: "f3" })).not.toBe(gateAt(reviewed()));
    const summed = reviewed({ steps: [{ name: "Review", status: "gated", reason: "the reviewer wants a look", summary: "Looks fine." }, { name: "Deploy", status: "pending" }] });
    expect(gateAt(summed)).toBe(gateAt(reviewed()));
  });

  test("a second tap while the first answer is on its way sends nothing; once it is back the next one sends", async () => {
    const heard: boolean[] = [];
    const once = oneAtATime((busy) => heard.push(busy));
    let sent = 0;
    let answer = () => {};
    const slow = () => {
      sent++;
      return new Promise<void>((done) => {
        answer = done;
      });
    };
    const first = once(slow);
    expect(await once(slow)).toBe(false);
    expect(sent).toBe(1);
    expect(heard).toEqual([true]);
    answer();
    expect(await first).toBe(true);
    expect(heard).toEqual([true, false]);
    expect(await once(async () => void sent++)).toBe(true);
    expect(sent).toBe(2);
  });

  test("an answer that failed frees the gate for the next", async () => {
    const once = oneAtATime(() => {});
    await expect(once(() => Promise.reject(new Error("409")))).rejects.toThrow("409");
    let sent = false;
    expect(
      await once(async () => {
        sent = true;
      }),
    ).toBe(true);
    expect(sent).toBe(true);
  });

  test("while off, every button is off, stop too; the manual step's start among them", () => {
    const html = renderToStaticMarkup(<GateChoices flow={held} off className="gate-buttons" onChoose={() => {}} />);
    expect(buttons(html)).toEqual(["*start Deploy", "retry this step", "stop here"]);
    expect(offCount(html)).toBe(3);
    const on = renderToStaticMarkup(<GateChoices flow={held} off={false} className="gate-buttons" onChoose={() => {}} />);
    expect(buttons(on)).toEqual(["*start Deploy", "retry this step", "stop here"]);
    expect(offCount(on)).toBe(0);
  });

  // A server render runs no handler and no effect, so each harness acts as
  // it draws: a state update made while a component draws draws it again at
  // once, as a tap or a moved flow would make it draw.

  test("a tap draws every button off while its answer is on its way, and a second tap then sends nothing", () => {
    let sent = 0;
    let answer = () => {};
    function Tapped() {
      const guard = useGateGuard(reviewed());
      // a tap at each draw: the second comes while the first is on its way
      guard.choose(() => {
        sent++;
        return new Promise<void>((done) => {
          answer = done;
        });
      });
      return <GateChoices flow={reviewed()} off={guard.off} className="gate-buttons" onChoose={() => {}} />;
    }
    const html = renderToStaticMarkup(<Tapped />);
    expect(buttons(html)).toEqual(["*continue to Deploy", "retry this step", "stop here"]);
    expect(offCount(html)).toBe(3);
    expect(sent).toBe(1);
    answer();
  });

  test("a continue that brings the manual step up draws its start off, so a second tap cannot run it", () => {
    function Moved() {
      const [flow, setFlow] = useState(() => reviewed());
      const guard = useGateGuard(flow);
      // the answer came back: Deploy waits for its go where Review's continue was
      if (flow.current === 0) setFlow(held);
      return <GateChoices flow={flow} off={guard.off} className="gate-buttons" onChoose={() => {}} />;
    }
    const html = renderToStaticMarkup(<Moved />);
    expect(buttons(html)).toEqual(["*start Deploy", "retry this step", "stop here"]);
    expect(offCount(html)).toBe(3);
    // a gate that did not move takes the tap
    function Still() {
      const guard = useGateGuard(held);
      return <GateChoices flow={held} off={guard.off} className="gate-buttons" onChoose={() => {}} />;
    }
    expect(offCount(renderToStaticMarkup(<Still />))).toBe(0);
  });
});

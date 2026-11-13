/**
 * The manager's top view as drawn from the store: what waits on Eric with
 * its controls in place, the goal picker for a run the page does not hold,
 * and the phone's order. Rendered from the real component with the store
 * seeded the way GateButtons.test.tsx seeds it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoordTask, Flow, LandEntry, LandingRun, Run, RunBranch, RunReview } from "../../../src/core/types";
import { useStore } from "../store";
import { arcPath, ManagerView } from "./ManagerView";

const pristine = useStore.getState();

/** renders with the store as the test set it: a server render reads the initial state */
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

// Bun has neither matchMedia nor location; each test that stubs them takes
// them away again, so no later file sees a stub.
const hadMatchMedia = "matchMedia" in globalThis;
const realMatchMedia = globalThis.matchMedia;
afterEach(() => {
  if (hadMatchMedia) globalThis.matchMedia = realMatchMedia;
  else Reflect.deleteProperty(globalThis, "matchMedia");
  Reflect.deleteProperty(globalThis, "location");
  useStore.setState({ runs: pristine.runs, flows: pristine.flows, landing: pristine.landing, prs: pristine.prs, repos: pristine.repos, kit: pristine.kit });
});

/** useMedia reads matchMedia as it first renders, so this decides the layout. */
function screen(phone: boolean): void {
  globalThis.matchMedia = ((query: string) => ({
    matches: phone,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof globalThis.matchMedia;
}

/** the page's address, which the view reads its run from */
const at = (search: string): void => void Object.assign(globalThis, { location: { search, pathname: "/" } });

/** every small button in the markup, in order, a star on the strong one */
const buttons = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*class="mini( strong)?"[^>]*>([^<]*)<\/button>/g)].map((m) => `${m[1] ? "*" : ""}${(m[2] ?? "").trim()}`);

/** the markup of the section with that label, empty when there is none */
function section(html: string, label: string): string {
  const start = html.indexOf(`aria-label="${label}"`);
  if (start < 0) return "";
  return html.slice(start, html.indexOf("</section>", start));
}

const br = (id: string, over: Partial<RunBranch> = {}): RunBranch => ({ name: `run/x-${id}`, target: "main", base: "b0", dir: `/w/${id}`, state: "ready", origin: `b-${id}`, ...over });

const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  repoId: "canopy",
  action: "ask",
  verb: "Ask",
  progress: "working",
  expectsChange: true,
  chat: false,
  harness: "claude",
  note: "n",
  status: "done",
  startedAt: 1,
  steps: [],
  prompt: null,
  branch: br(id),
  ...over,
});

const card = (id: string, state: CoordTask["state"], over: Partial<CoordTask> = {}): CoordTask => ({ id, title: `card ${id}`, repo: "canopy", note: `the note for ${id}`, action: "ask", state, ...over });

const GOAL = "Buzz my phone once per waiting run";

const coord = (tasks: CoordTask[], over: Partial<Run> = {}): Run =>
  run("k", {
    action: "coordinate",
    verb: "Coordinate",
    chat: true,
    status: "idle",
    branch: undefined,
    note: "the goal as noted",
    startedAt: 100,
    steps: [{ id: "s1", at: 100, kind: "user", text: GOAL }],
    tasks,
    ...over,
  });

/** a flow parked at its last step's gate */
const gated: Flow = {
  id: "f1",
  repoId: "canopy",
  workflow: "ship",
  verb: "ship",
  note: "n",
  status: "gated",
  steps: [
    { name: "Build", status: "passed", runId: "r1" },
    { name: "Review", status: "gated", reason: "the reviewer wants a look", runId: "r2" },
  ],
  current: 1,
  startedAt: 5,
  branch: br("f1", { state: "working" }),
};

const flowCard = card("t1", "running", { flow: "f1", branch: "b-f1", workflow: "ship" });

const rec = (id: string, over: Partial<LandingRun> = {}): LandingRun => ({
  id,
  runId: id.replace(/^b-/, ""),
  repoId: "canopy",
  repoPath: "/r/canopy",
  branch: `run/x-${id}`,
  target: "main",
  base: "b0",
  dir: `/w/${id}`,
  note: "n",
  verb: "Ask",
  harness: "claude",
  state: "ready",
  startedAt: 1,
  ...over,
});

const entry = (id: string, state: LandEntry["state"], over: Partial<LandEntry> = {}): LandEntry => ({
  id,
  repoId: "canopy",
  repoPath: "/r/canopy",
  branch: `run/x-${id}`,
  target: "main",
  dir: `/w/${id}`,
  note: "n",
  state,
  tries: 0,
  queuedAt: 1,
  updatedAt: 60,
  ...over,
});

const review = (verdict: RunReview["verdict"]): RunReview => ({ verdict, files: [], base: "b0", head: "h1", at: 40 });

/** a card whose child run c2 settled on branch b-c2, with what the queue holds of it */
function settled(landing: { runs?: LandingRun[]; entries?: LandEntry[] }): void {
  useStore.setState({
    runs: { k: coord([card("t2", "done", { run: "c2", branch: "b-c2", outcome: "ready" })]), c2: run("c2") },
    landing: { "": { runs: landing.runs ?? [], entries: landing.entries ?? [], orphans: [] } },
  });
}

describe("needs you", () => {
  test("a card's flow parked at a gate shows the gate's buttons in needs you", () => {
    screen(false);
    at("?view=manager&run=k");
    useStore.setState({ runs: { k: coord([flowCard]) }, flows: { f1: gated } });
    const needs = section(renderCurrent(<ManagerView />), "needs you");
    expect(needs).toContain("the reviewer wants a look");
    expect(buttons(needs)).toEqual(["*accept and finish", "retry this step", "stop here"]);
  });

  test("a ready branch whose verdict wants Eric offers land and send back; one that needs approval opens the approve sheet's look", () => {
    screen(false);
    at("?view=manager&run=k");
    settled({ runs: [rec("b-c2", { review: review("land") })] });
    expect(buttons(section(renderCurrent(<ManagerView />), "needs you"))).toEqual(["*land", "send back"]);
    settled({ runs: [rec("b-c2", { review: review("approve") })] });
    expect(buttons(section(renderCurrent(<ManagerView />), "needs you"))).toEqual(["*look and land", "send back"]);
  });

  test("a branch sent back offers fix it, and one waiting on the judge offers land anyway", () => {
    screen(false);
    at("?view=manager&run=k");
    settled({ runs: [rec("b-c2")], entries: [entry("b-c2", "conflict", { reason: "main moved under it" })] });
    expect(buttons(section(renderCurrent(<ManagerView />), "needs you"))).toEqual(["*fix it"]);
    settled({ runs: [rec("b-c2")], entries: [entry("b-c2", "judge", { reason: "a scenario needs a judge" })] });
    expect(buttons(section(renderCurrent(<ManagerView />), "needs you"))).toEqual(["*land anyway"]);
  });

  test("proposed cards wait for start these; with nothing waiting, it says so", () => {
    screen(false);
    at("?view=manager&run=k");
    useStore.setState({ runs: { k: coord([card("t1", "proposed")]) } });
    expect(buttons(section(renderCurrent(<ManagerView />), "needs you"))).toEqual(["*start these"]);
    useStore.setState({ runs: { k: coord([card("t1", "done", { outcome: "landed" })]) } });
    expect(section(renderCurrent(<ManagerView />), "needs you")).toContain("Nothing waits on you.");
  });
});

describe("which goal", () => {
  test("a run the store does not hold says the goal ended and lists the live goals", () => {
    screen(false);
    at("?view=manager&run=mini%7Cgone");
    useStore.setState({ runs: { k: coord([]) } });
    const html = renderCurrent(<ManagerView />);
    expect(html).toContain("This goal has ended");
    expect(html).toContain(GOAL);
    expect(html).toContain('href="/?view=manager&amp;run=k"');
  });

  test("no run and one live coordinator opens that goal; none live asks to pick", () => {
    screen(false);
    at("?view=manager");
    useStore.setState({ runs: { k: coord([flowCard]) }, flows: { f1: gated } });
    const html = renderCurrent(<ManagerView />);
    expect(html).toContain(`>${GOAL}</h1>`);
    expect(html).toContain('aria-label="needs you"');
    useStore.setState({ runs: { k: coord([], { status: "done" }) } });
    const none = renderCurrent(<ManagerView />);
    expect(none).toContain("Pick a goal");
    expect(none).toContain("No coordinator is running.");
  });

  test("an ended goal the page still holds shows its rows, with no hold, add or end", () => {
    screen(false);
    at("?view=manager&run=k");
    useStore.setState({ runs: { k: coord([flowCard], { status: "done" }) }, flows: { f1: gated } });
    const html = renderCurrent(<ManagerView />);
    expect(html).toContain("This goal has ended.");
    expect(html).toContain('aria-label="workers"');
    const head = buttons(html.slice(0, html.indexOf('aria-label="rings"')));
    expect(head).not.toContain("hold");
    expect(head).not.toContain("add a task");
    expect(head).not.toContain("end goal");
  });
});

describe("rings and lanes", () => {
  test("a ring per card after the manager's, one arc path each, in waves by after", () => {
    screen(false);
    at("?view=manager&run=k");
    useStore.setState({ runs: { k: coord([flowCard, card("t2", "queued", { after: ["t1"] })]) }, flows: { f1: gated } });
    const rings = section(renderCurrent(<ManagerView />), "rings");
    expect([...rings.matchAll(/class="mgr-ring /g)]).toHaveLength(3);
    // the manager's two cards, t1's two steps, t2's build and land
    expect([...rings.matchAll(/<path class="mgr-arc /g)]).toHaveLength(6);
    expect(rings.indexOf(">manager<")).toBeLessThan(rings.indexOf(">t1<"));
    expect(rings).toContain(">after t1<");
    expect(rings.indexOf(">after t1<")).toBeGreaterThan(rings.indexOf(">t1<"));
    expect(rings.indexOf(">after t1<")).toBeLessThan(rings.indexOf(">t2<"));
    // t1's step in hand, in its centre
    expect(rings).toContain(">2/2<");
  });

  test("an arc spans its share less a 4 degree gap, the long way round for one arc alone", () => {
    // a quarter from the top: 90 less 4 degrees, short way
    expect(arcPath(0, 4)).toMatch(/^M 50(\.00)? 8(\.00)? A 42 42 0 0 1 /);
    expect(arcPath(0, 1)).toContain(" A 42 42 0 1 1 ");
  });

  test("a proposed card on a live goal has equip and start now; a working one has stop and open run", () => {
    screen(false);
    at("?view=manager&run=k");
    useStore.setState({ runs: { k: coord([card("t1", "proposed"), card("t2", "running", { run: "c2", branch: "b-c2" })]), c2: run("c2", { status: "working", branch: br("c2", { state: "working" }) }) } });
    const workers = section(renderCurrent(<ManagerView />), "workers");
    const t1 = buttons(workers.slice(workers.indexOf('id="mgr-lane-t1"'), workers.indexOf('id="mgr-lane-t2"')));
    const t2 = buttons(workers.slice(workers.indexOf('id="mgr-lane-t2"')));
    expect(t1).toEqual(["say", "equip", "start now"]);
    expect(t2).toEqual(["say", "stop", "open run"]);
    expect(workers).toContain('<ol class="step-strip mgr-steps" aria-label="Steps">');
  });
});

describe("the layout", () => {
  test("wide, the rings come first, then needs you and the workers, then the chat", () => {
    screen(false);
    at("?view=manager&run=k");
    useStore.setState({ runs: { k: coord([flowCard]) }, flows: { f1: gated } });
    const html = renderCurrent(<ManagerView />);
    const order = ["rings", "needs you", "workers", "manager chat"].map((l) => html.indexOf(`aria-label="${l}"`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain('aria-label="Show"');
  });

  test("on a phone, needs you comes before the rings, and the workers and the chat take turns", () => {
    screen(true);
    at("?view=manager&run=k");
    useStore.setState({ runs: { k: coord([flowCard]) }, flows: { f1: gated } });
    const html = renderCurrent(<ManagerView />);
    const needs = html.indexOf('aria-label="needs you"');
    expect(needs).toBeGreaterThan(-1);
    expect(html.indexOf('aria-label="rings"')).toBeGreaterThan(needs);
    expect(html).toContain('<div class="mgr-switch" role="group" aria-label="Show"><button type="button" class="mini on" aria-pressed="true">workers</button><button type="button" class="mini" aria-pressed="false">chat</button></div>');
    expect(html).toMatch(/<aside class="mgr-chat[^"]*" id="mgr-chat" aria-label="manager chat" hidden="">/);
  });
});

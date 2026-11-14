import { describe, expect, test } from "bun:test";
import type { Flow, FlowStep, IncubatorStages, Sprout } from "../../src/core/types";
import type { FeedSnapshot } from "./feed";
import { gateButtons } from "./flows";
import { branchHref, cannotStart, needsYou, parkDetailOf, parkWords, queuedWhy, replaceSprouts, sortSprouts, sproutActivity, sproutBackend, sproutLines, sproutWord, stageAt, stageStrip, stagesWord, staleSprout, workLine } from "./sprouts";

const sprout = (over: Partial<Sprout> = {}): Sprout => ({
  id: "sp_000000000001",
  slug: "coins",
  title: "Coin counter",
  status: "queued",
  repoId: "_incubator/coins",
  seedPath: "/root/_incubator/coins",
  prepared: true,
  inputs: [],
  clarified: false,
  reclarify: false,
  flows: [],
  spent: { runs: 0, workMs: 0 },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const q = (question: string) => ({ question, header: "", options: [], multiSelect: false });
const marks = (s: Sprout) => stageStrip(s).map((x) => `${x.stage}:${x.mark}`).join(" ");

describe("the stage strip", () => {
  test("a fresh sprout has clarify next and nothing done", () => {
    expect(stageAt(sprout())).toBeNull();
    expect(marks(sprout())).toBe("clarify:todo research:todo eval:todo build:todo test:todo accept:todo deploy:todo retro:todo");
  });
  test("clarifying is now; parked there is stuck", () => {
    expect(marks(sprout({ status: "clarifying" })).startsWith("clarify:now research:todo")).toBe(true);
    const parked = sprout({ status: "parked", parked: "x", flows: [{ workflow: "clarify", flowId: "f1", outcome: "failed" }] });
    expect(stageAt(parked)).toBe("clarify");
    expect(marks(parked).startsWith("clarify:stuck research:todo")).toBe(true);
  });
  test("queued after clarify has clarify done and research waiting", () => {
    const s = sprout({ clarified: true, flows: [{ workflow: "clarify", flowId: "f1", outcome: "done" }] });
    expect(marks(s).startsWith("clarify:done research:todo")).toBe(true);
  });
  test("researching covers research; parked in scout is stuck at research", () => {
    expect(marks(sprout({ status: "researching", clarified: true })).startsWith("clarify:done research:now eval:todo")).toBe(true);
    const s = sprout({ status: "parked", parked: "the scout workflow is not installed", clarified: true, flows: [{ workflow: "clarify", flowId: "f1", outcome: "done" }] });
    expect(stageAt(s)).toBe("research");
  });
  test("live is done through deploy", () => {
    expect(marks(sprout({ status: "live", clarified: true }))).toBe("clarify:done research:done eval:done build:done test:done accept:done deploy:done retro:todo");
  });
  test("the retro's mark is its own state, whatever the sprout's status", () => {
    const retro = { for: "end" as const, state: "running" as const, at: 1, flowsSeen: 1, tries: 1 };
    const live = (state: "due" | "running" | "done" | "failed") => marks(sprout({ status: "live", clarified: true, retro: { ...retro, state } })).split(" ").at(-1);
    expect(live("due")).toBe("retro:todo");
    expect(live("running")).toBe("retro:now");
    expect(live("done")).toBe("retro:done");
    expect(live("failed")).toBe("retro:stuck");
    const parked = sprout({ status: "parked", parked: "x", clarified: true, retro: { ...retro, for: "park" } });
    expect(marks(parked).endsWith("retro:now")).toBe(true);
  });
});

describe("words and order", () => {
  test("a word for each state that matters here", () => {
    expect(sproutWord(sprout({ prepared: false }))).toBe("making the seed");
    expect(sproutWord(sprout())).toBe("waiting its turn to clarify");
    expect(sproutWord(sprout({ clarified: true }))).toBe("waiting its turn for research");
    expect(sproutWord(sprout({ status: "clarifying" }))).toBe("clarifying");
    expect(sproutWord(sprout({ status: "clarifying", questions: [q("a"), q("b")] }))).toBe("2 questions for you");
    expect(sproutWord(sprout({ status: "rejected" }))).toBe("turned down at eval");
    expect(sproutWord(sprout({ status: "handed-off" }))).toBe("handed off");
  });
  test("a queued sprout says which turn it waits for, the build and the hand-off included", () => {
    const done = (workflow: string, n: number) => ({ workflow, flowId: `f${n}`, outcome: "done" as const });
    const flows = [done("clarify", 1), done("scout", 2)];
    const extend = { kind: "extend" as const, host: "vercel" as const, why: "w", target: "web-apps/clms" };
    expect(sproutWord(sprout({ clarified: true, pick: extend, flows }))).toBe("waiting its turn to build");
    expect(sproutWord(sprout({ clarified: true, pick: extend, flows: [...flows, done("extend", 3)] }))).toBe("waiting its turn to hand off");
    expect(sproutWord(sprout({ clarified: true, pick: { ...extend, kind: "new", target: undefined }, flows: [...flows, done("build-new", 3)] }))).toBe("waiting its turn to deploy");
  });
  test("the branch is a link only when it is canopy's GitHub tree url; the sheet says what the seed came from", () => {
    expect(branchHref("https://github.com/eric/clms/tree/new/dark-mode")).toBe("https://github.com/eric/clms/tree/new/dark-mode");
    for (const bad of ["javascript:alert(1)", "https://evil.io/eric/clms/tree/new/x", "https://github.com/eric/clms/tree/main", undefined]) expect(branchHref(bad)).toBe(null);
    const work = { kind: "extend" as const, from: "https://github.com/eric/clms.git", base: "b", target: "web-apps/clms", remote: "https://github.com/eric/clms.git", branch: "new/s", at: 1 };
    expect(workLine(sprout({ work }))).toBe("extends web-apps/clms, on the branch new/s");
    expect(workLine(sprout({ work: { kind: "renovate", from: "https://github.com/up/lib", base: "b", at: 1 } }))).toBe("renovates https://github.com/up/lib");
    expect(workLine(sprout())).toBe(null);
  });
  test("a hand-off fills the strip up to the retro", () => {
    expect(stageStrip(sprout({ status: "handed-off" })).map((x) => x.mark)).toEqual(["done", "done", "done", "done", "done", "done", "done", "todo"]);
  });
  test("questions and parks need you; the rest do not", () => {
    expect(needsYou(sprout({ status: "clarifying", questions: [q("a")] }))).toBe(true);
    expect(needsYou(sprout({ status: "parked", parked: "x" }))).toBe(true);
    expect(needsYou(sprout({ status: "clarifying" }))).toBe(false);
  });
  test("what needs you first, then what runs, then what ended; newest first in each", () => {
    const list = [
      sprout({ id: "sp_000000000001", status: "stopped", updatedAt: 9 }),
      sprout({ id: "sp_000000000002", status: "clarifying", updatedAt: 2 }),
      sprout({ id: "sp_000000000003", status: "parked", parked: "x", updatedAt: 1 }),
      sprout({ id: "sp_000000000004", status: "queued", updatedAt: 5 }),
    ];
    expect(sortSprouts(list).map((s) => s.id.slice(-1))).toEqual(["3", "4", "2", "1"]);
  });
});

describe("feed lines", () => {
  const snap = (sprouts: Record<string, Sprout>): FeedSnapshot => ({ repos: [], sources: [], runs: {}, flows: {}, fleets: {}, workspaces: [], sprouts });
  test("a new sprout, a status change, questions, a park and a dismissal", () => {
    const s = sprout();
    expect(sproutLines({ type: "incubator", sprout: s }, snap({}), 5).map((l) => l.text)).toEqual(["new project in the incubator"]);
    const c = sprout({ status: "clarifying" });
    expect(sproutLines({ type: "incubator", sprout: c }, snap({ [s.id]: s }), 5).map((l) => l.text)).toEqual(["clarifying"]);
    const asking = sprout({ status: "clarifying", questions: [q("a")] });
    expect(sproutLines({ type: "incubator", sprout: asking }, snap({ [s.id]: c }), 5).map((l) => l.text)).toEqual(["1 question for you"]);
    const parked = sprout({ status: "parked", parked: "the scout workflow is not installed" });
    const [line] = sproutLines({ type: "incubator", sprout: parked }, snap({ [s.id]: c }), 5);
    expect(line).toMatchObject({ kind: "incubator", repo: "Coin counter", repoId: "_incubator/coins", text: "parked: the scout workflow is not installed", quiet: false });
    expect(sproutLines({ type: "incubator-gone", id: s.id }, snap({ [s.id]: s }), 5).map((l) => [l.text, l.quiet])).toEqual([["dismissed", true]]);
  });
  test("a retro starting, leaving lessons, leaving none, and failing", () => {
    const retro = { for: "end" as const, state: "due" as const, at: 1, flowsSeen: 1, tries: 0 };
    const was = sprout({ status: "live", retro });
    const text = (s: Sprout, before: Sprout = was) => sproutLines({ type: "incubator", sprout: s }, snap({ [s.id]: before }), 5).map((l) => [l.text, l.quiet]);
    const running = sprout({ status: "live", retro: { ...retro, state: "running", tries: 1 } });
    expect(text(running)).toEqual([["looking back", false]]);
    const two = [{ key: "a", lesson: "A." }, { key: "b", lesson: "B." }];
    expect(text(sprout({ status: "live", retro: { ...retro, state: "done", advice: two } }), running)).toEqual([["the retro left 2 lessons", false]]);
    expect(text(sprout({ status: "live", retro: { ...retro, state: "done", advice: [] } }), running)).toEqual([["the retro left no advice", true]]);
    expect(text(sprout({ status: "live", retro: { ...retro, state: "failed", reason: "the run failed" } }), running)).toEqual([["the retro failed: the run failed", false]]);
  });
  test("a save that changes nothing a person reads is quiet", () => {
    const s = sprout({ status: "clarifying" });
    const [line] = sproutLines({ type: "incubator", sprout: { ...s, updatedAt: 9 } }, snap({ [s.id]: s }), 5);
    expect(line?.quiet).toBe(true);
  });
});

describe("replaceSprouts", () => {
  const mk = (id: string, updatedAt: number): Sprout => ({
    id, slug: id, title: id, status: "queued", repoId: `_incubator/${id}`, seedPath: `/a/${id}`, prepared: true, inputs: [],
    clarified: true, reclarify: false, flows: [], spent: { runs: 0, workMs: 0 }, createdAt: 1, updatedAt,
  });
  test("the list wins for a sprout no event touched, and drops one it lacks", () => {
    const out = replaceSprouts({ a: mk("a", 1), b: mk("b", 1) }, [mk("a", 2)]);
    expect(Object.keys(out)).toEqual(["a"]);
    expect(out.a?.updatedAt).toBe(2);
  });
  test("an event's sprout stands over an older listed one, and one it added is kept", () => {
    const out = replaceSprouts({ a: mk("a", 5), c: mk("c", 5) }, [mk("a", 2)], () => true);
    expect(out.a?.updatedAt).toBe(5);
    expect(out.c?.updatedAt).toBe(5);
  });
  test("a sprout an event dropped stays gone", () => {
    expect(replaceSprouts({}, [mk("a", 2)], () => true)).toEqual({});
  });
});

describe("staleSprout", () => {
  test("an answer older than the sprout held is stale; one as new, or about a sprout not held, is not", () => {
    const held = { [sprout().id]: sprout({ updatedAt: 5 }) };
    expect(staleSprout(held, sprout({ updatedAt: 4 }))).toBe(true);
    expect(staleSprout(held, sprout({ updatedAt: 5 }))).toBe(false);
    expect(staleSprout(held, sprout({ updatedAt: 6 }))).toBe(false);
    expect(staleSprout(held, sprout({ id: "sp_000000000002", updatedAt: 1 }))).toBe(false);
    expect(staleSprout({}, sprout({ id: "constructor" }))).toBe(false);
  });
});

test("a sprout queued for canopy's ship is at the deploy stage", () => {
  const s = sprout({ status: "queued", clarified: true, pick: { kind: "new", host: "vercel", why: "w" }, flows: [
    { workflow: "clarify", flowId: "f1", outcome: "done" },
    { workflow: "scout", flowId: "f2", outcome: "done" },
    { workflow: "build-new", flowId: "f3", outcome: "done" },
  ] });
  expect(stageAt(s)).toBe("deploy");
});

test("canopy's deploy shows as the deploy stage", () => {
  const s = sprout({ status: "parked", clarified: true, parked: "deploy: vercel deploy: Build failed", flows: [{ workflow: "scout", flowId: "a", outcome: "done" }, { workflow: "build-new", flowId: "b", outcome: "done" }], pick: { kind: "new", host: "vercel", why: "w" } });
  expect(stageAt(s)).toBe("deploy");
});

describe("stagesWord", () => {
  test("through the runner while it answers: isolated, and the title names the socket", () => {
    const w = stagesWord({ isolated: true, mode: "runner", waiting: null });
    expect(w).toMatchObject({ word: "stages isolated", warn: false });
    expect(w.title).toContain("CANOPY_STAGE_SOCKET");
  });

  test("a runner set up but away is its own word: stages wait for it", () => {
    const w = stagesWord({ isolated: false, mode: "runner", waiting: "the stage runner is not answering" });
    expect(w).toMatchObject({ word: "stage runner away", warn: true });
    expect(w.title).toContain("CANOPY_STAGE_SOCKET is set");
  });

  test("a runner that answers with its fence not confirmed is unfenced, never isolated, and the title says why", () => {
    const why = "the fence is down: http://192.168.1.1/ answered";
    const w = stagesWord({ isolated: false, mode: "runner", waiting: why, unfenced: why });
    expect(w).toMatchObject({ word: "stages unfenced", warn: true });
    expect(w.title).toContain(why);
    expect(w.title).toContain("CANOPY_FENCE_PROBE");
  });

  test("a fenced runner whose claude login is dead says the stages need one, and the title says what to do", () => {
    const why = "the stages' claude login expired on 2026-11-01: save a token";
    const w = stagesWord({ isolated: true, mode: "runner", waiting: why, unfenced: null, login: why });
    expect(w).toMatchObject({ word: "stages need a login", warn: true });
    expect(w.title).toContain(why);
    expect(w.title).toContain("start on their own");
    // a backend older than the check says nothing of a login, and reads as before
    expect(stagesWord({ isolated: true, mode: "runner", waiting: null, unfenced: null }).word).toBe("stages isolated");
  });

  test("unisolated says stages run here with canopy's tokens", () => {
    const w = stagesWord({ isolated: false, mode: "unisolated", waiting: null });
    expect(w).toMatchObject({ word: "stages unisolated", warn: true });
    expect(w.title).toContain("CANOPY_INCUBATOR_UNISOLATED=1 is set");
    expect(w.title).toContain("canopy's tokens");
  });

  test("off names both envs as missing", () => {
    const w = stagesWord({ isolated: false, mode: "off", waiting: null });
    expect(w).toMatchObject({ word: "stages off", warn: true });
    expect(w.title).toContain("Neither CANOPY_STAGE_SOCKET nor CANOPY_INCUBATOR_UNISOLATED=1 is set");
  });

  test("every mode has its own word", () => {
    const words = (["runner", "unisolated", "off"] as const).map((mode) => stagesWord({ isolated: false, mode, waiting: null }).word);
    expect(new Set(words).size).toBe(3);
  });
});

describe("where a new project goes", () => {
  const off: IncubatorStages = { isolated: false, mode: "off", waiting: null };
  const isolated: IncubatorStages = { isolated: true, mode: "runner", waiting: null };
  const away: IncubatorStages = { isolated: false, mode: "runner", waiting: "the stage runner is not answering" };
  const unisolated: IncubatorStages = { isolated: false, mode: "unisolated", waiting: null };
  const order = ["mac", "mini"];
  const all = () => true;
  test("home while its stages can start, a runner away among them", () => {
    expect(sproutBackend(order, "mac", { mac: unisolated, mini: isolated }, all)).toBe("mac");
    expect(sproutBackend(order, "mac", { mac: away, mini: isolated }, all)).toBe("mac");
  });
  test("home with stages off sends it to the first online backend whose stages can start", () => {
    expect(sproutBackend(order, "mac", { mac: off, mini: isolated }, all)).toBe("mini");
    expect(sproutBackend(["mac", "nas", "mini"], "mac", { mac: off, nas: off, mini: isolated }, all)).toBe("mini");
  });
  test("home when no other can, is offline, or has not said", () => {
    expect(sproutBackend(order, "mac", { mac: off, mini: off }, all)).toBe("mac");
    expect(sproutBackend(order, "mac", { mac: off, mini: isolated }, (b) => b !== "mini")).toBe("mac");
    expect(sproutBackend(order, "mac", { mac: off }, all)).toBe("mac");
    expect(sproutBackend(["mac"], "mac", {}, all)).toBe("mac");
  });
  test("a backend with stages off is named as one a project would never start on; any other holds nothing back", () => {
    expect(cannotStart("mac", off)).toBe("mac has nowhere to run a stage, so a project started there would never start. Pick another backend, or set CANOPY_INCUBATOR_UNISOLATED=1 on mac and restart it.");
    // a runner away starts its projects once it answers, and a backend that has not said is asked by the server
    for (const st of [isolated, unisolated, away, undefined]) expect(cannotStart("mini", st)).toBe(null);
  });
});

describe("why a queued project waits", () => {
  const held: IncubatorStages = { isolated: false, mode: "runner", waiting: "the stage runner is not answering", unfenced: null };
  test("a queued, prepared project on a backend whose stages wait says the backend's reason", () => {
    expect(queuedWhy(sprout({ status: "queued", prepared: true }), held)).toBe("the stage runner is not answering");
  });
  test("nothing for a project not queued, one still being prepared, or a backend that holds nothing back", () => {
    expect(queuedWhy(sprout({ status: "parked", parked: "x" }), held)).toBe(null);
    expect(queuedWhy(sprout({ status: "queued", prepared: false }), held)).toBe(null);
    expect(queuedWhy(sprout({ status: "queued", prepared: true }), { ...held, waiting: null })).toBe(null);
    expect(queuedWhy(sprout({ status: "queued", prepared: true }), undefined)).toBe(null);
  });
});

describe("a card's activity", () => {
  test("questions, a park and a branch to push wait on you", () => {
    expect(sproutActivity(sprout({ status: "clarifying", questions: [q("Who?")] }))).toBe("needs");
    expect(sproutActivity(sprout({ status: "parked", parked: "x" }))).toBe("needs");
    expect(sproutActivity(sprout({ status: "approving" }))).toBe("needs");
  });
  test("a stage under way works, clarify before its questions among them", () => {
    for (const status of ["clarifying", "researching", "building", "testing", "accepting", "deploying"] as const) {
      expect(sproutActivity(sprout({ status }))).toBe("working");
    }
  });
  test("a retro running after the end works; queued and ended are still", () => {
    const retro = { for: "live", state: "running", at: 1, flowsSeen: 1, tries: 1 } as unknown as NonNullable<Sprout["retro"]>;
    expect(sproutActivity(sprout({ status: "live", retro }))).toBe("working");
    expect(sproutActivity(sprout({ status: "live" }))).toBe("still");
    expect(sproutActivity(sprout({ status: "queued" }))).toBe("still");
    expect(sproutActivity(sprout({ status: "stopped" }))).toBe("still");
  });
});

describe("parkDetailOf (incubator review, P2)", () => {
  test("the current park's detail, and none once the project is not parked or for an older park", () => {
    const parks = [
      { at: 5, reason: "clarify failed: boom", detail: "old words" },
      { at: 9, reason: "build waits after Test: check failed with exit 1", detail: "FAIL src/a.test.ts" },
    ];
    expect(parkDetailOf(sprout({ status: "parked", parkedAt: 9, parks }))).toBe("FAIL src/a.test.ts");
    expect(parkDetailOf(sprout({ status: "queued", parkedAt: 9, parks }))).toBeNull();
    // a park with no detail never shows an older one's
    expect(parkDetailOf(sprout({ status: "parked", parkedAt: 12, parks: [...parks, { at: 12, reason: "the scout workflow is not installed" }] }))).toBeNull();
  });
});

describe("parkWords (incubator review, P1)", () => {
  const accept = (go: boolean): FlowStep => ({
    name: "Accept",
    status: "gated",
    reason: go ? "a gate" : "the judge says it only partly meets the intent",
    judgment: { answers: { fit: { choice: go ? "meets" : "partly", probabilities: {} }, evidence: { probability: 0.9 }, rules: { probability: 0 } }, go, rejected: false, reason: go ? null : "only partly" },
  });
  const built = (workflow: string, first: string, last: FlowStep, o: Partial<Flow> = {}): Flow => ({
    id: "f9", repoId: "_incubator/coins", workflow, verb: "build", note: "", status: "gated",
    steps: [{ name: first, status: "passed" }, { name: "Test", status: "passed" }, last],
    current: 2, startedAt: 0, ...o,
  });
  const parked = (workflow: string): Sprout => sprout({ status: "parked", parked: "x", clarified: true, flows: [{ workflow, flowId: "f9" }] });
  const drawn = (s: Sprout, f: Flow | undefined): string[] => gateButtons(parkWords(s, f)).map((b) => `${b.strong ? "*" : ""}${b.choice}: ${b.word}`);

  test("a build the judge refused: the way back leads, and going on says it deploys anyway", () => {
    const f = built("build-new", "Scaffold", accept(false), { backTo: "Scaffold" });
    expect(drawn(parked("build-new"), f)).toEqual(["*retry: send it back to Scaffold", "continue: deploy it anyway"]);
    expect(parkWords(parked("build-new"), f).title).toBe("Accept did not accept the work; this deploys the project as it is");
    expect(drawn(parked("renovate"), built("renovate", "Renovate", accept(false), { backTo: "Renovate" }))).toEqual(["*retry: send it back to Renovate", "continue: deploy it anyway"]);
  });

  test("an extend goes to its hand-off, not a deploy", () => {
    const f = built("extend", "Build", accept(false), { backTo: "Build" });
    expect(drawn(parked("extend"), f)).toEqual(["*retry: send it back to Build", "continue: hand it off anyway"]);
    expect(parkWords(parked("extend"), f).title).toBe("Accept did not accept the work; this takes the branch to its hand-off as it is");
  });

  test("a build's last gate that asks for a go says what going on does", () => {
    expect(drawn(parked("build-new"), built("build-new", "Scaffold", accept(true)))).toEqual(["*continue: accept and deploy it", "retry: retry this step"]);
  });

  test("a gate before the last step, a stage that is no build, and a park with one way on keep the gate's own words", () => {
    const mid = built("build-new", "Scaffold", { name: "Accept", status: "pending" }, { current: 1 });
    expect(drawn(parked("build-new"), mid)).toEqual(["*continue: continue to Accept", "retry: retry this step"]);
    expect(drawn(parked("clarify"), built("clarify", "Clarify", accept(false)))).toEqual(["*retry: retry this step", "continue: accept and finish anyway"]);
    expect(drawn(parked("build-new"), built("build-new", "Scaffold", accept(false), { parkedFor: "failed" }))).toEqual(["*continue: run the step again"]);
  });

  test("past scout's last step the build is next, and the words say so", () => {
    const scout = (last: FlowStep, o: Partial<Flow> = {}): Flow => ({
      id: "f9", repoId: "_incubator/coins", workflow: "scout", verb: "scout", note: "", status: "gated",
      steps: [{ name: "Research", status: "passed" }, { ...last, name: "Eval" }], current: 1, startedAt: 0, ...o,
    });
    const refused = scout(accept(false), { backTo: "Research" });
    expect(drawn(parked("scout"), refused)).toEqual(["*retry: send it back to Research", "continue: build it anyway"]);
    expect(parkWords(parked("scout"), refused).title).toBe("Eval did not accept the research; this takes the pick as it is and queues the build");
    // a judge that could not answer refused nothing
    expect(drawn(parked("scout"), scout(accept(true)))).toEqual(["*continue: accept the pick and build it", "retry: retry this step"]);
    // Research's own park is mid-flow and keeps the gate's words
    expect(drawn(parked("scout"), scout(accept(true), { current: 0 }))).toEqual(["*continue: continue to Eval", "retry: retry this step"]);
  });

  test("with no flow waiting at a gate there is one button", () => {
    const failed = sprout({ status: "parked", parked: "deploy: no scope", flows: [{ workflow: "build-new", flowId: "f9", outcome: "done" }] });
    expect(drawn(failed, built("build-new", "Scaffold", accept(false)))).toEqual(["*continue: resume"]);
    expect(drawn(parked("build-new"), undefined)).toEqual(["*continue: resume"]);
    // another flow's gate is not this park's
    expect(drawn(parked("build-new"), built("build-new", "Scaffold", accept(false), { id: "other" }))).toEqual(["*continue: resume"]);
    expect(drawn(parked("build-new"), built("build-new", "Scaffold", accept(false), { status: "working" }))).toEqual(["*continue: resume"]);
  });
});

/** A side question on the page (FR-077), as the console draws it: the btw
 *  button in a run's box, the column beside the run, the tab's mark, and
 *  the line a side question's own console opens with. */
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Repo, Run } from "../../../src/core/types";
import { useStore } from "../store";
import { Console } from "./RunSheet";
import { SideLine } from "./SideQuestion";

const pristine = useStore.getState();
afterEach(() => useStore.setState(pristine, true));

const repo: Repo = { id: "app", name: "app", path: "/dev/app", group: "", source: "launch", status: null };
const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  repoId: "app",
  action: "ask",
  verb: "Ask",
  progress: "asking",
  expectsChange: false,
  chat: false,
  harness: "claude",
  name: "migrate the billing checkout",
  note: "migrate the billing checkout",
  status: "working",
  session: "sess-1",
  startedAt: 1,
  steps: [{ id: "p1", at: 1, kind: "text", text: "Reading the checkout module." }],
  prompt: null,
  ...over,
});
const parent = run("p");
const side = run("s1", {
  action: "chat",
  verb: "chat",
  chat: true,
  status: "idle",
  startedAt: 9,
  name: "what is the retry default",
  note: "what is the retry default?",
  sideOf: { run: "p", title: "migrate the billing checkout" },
  agentSettings: { harness: "claude", model: "haiku", effort: "default" },
  steps: [
    { id: "s1", at: 9, kind: "user", text: "what is the retry default?" },
    { id: "s2", at: 10, kind: "text", text: "500 ms, doubling to 8 s." },
  ],
});

/** A static render reads the store's first state, so the current one stands
 *  in for it while `what` is drawn. */
function drawn(what: ReactElement): string {
  const initial = useStore.getInitialState();
  const before = { ...initial };
  Object.assign(initial, useStore.getState());
  try {
    return renderToStaticMarkup(what);
  } finally {
    Object.assign(initial, before);
  }
}
/** a run's console, as the sheet over the page draws it */
const sheet = (of: Run): string => drawn(<Console run={of} repo={repo} />);
const count = (html: string, part: string): number => html.split(part).length - 1;

describe("a run's console", () => {
  test("offers a side question from its box, and shows no column until one is asked", () => {
    useStore.setState({ repos: [repo], runs: { p: parent } });
    const html = sheet(parent);
    expect(count(html, "side-btn")).toBe(1);
    expect(html).toContain('aria-label="Side question"');
    expect(html).not.toContain("side-hint");
    expect(html).not.toContain("side-q");
  });

  test("shows the side question on show beside it: what was asked, where it started, its own box and model", () => {
    useStore.setState({ repos: [repo], runs: { p: parent, s1: side }, sideShown: { p: "s1" } });
    const html = sheet(parent);
    const column = html.slice(html.indexOf('<aside class="side-q'));
    expect(column).toContain("Side question");
    expect(column).toContain("what is the retry default?");
    expect(column).toContain("Started from: migrate the billing checkout");
    expect(column).toContain("500 ms, doubling to 8 s.");
    expect(column).toContain('aria-label="This side question&#x27;s model"');
    expect(column).toMatch(/<option value="haiku" selected="">haiku<\/option>/);
    expect(column).toContain(">end chat<");
    // one box each, and only the run's offers a side question
    expect(count(html, 'class="composer-box"')).toBe(2);
    expect(count(html, "side-btn")).toBe(1);
    expect(column).not.toContain("side-btn");
    // the run's own timeline holds none of the thread's words
    expect(html.slice(0, html.indexOf('<aside class="side-q'))).not.toContain("500 ms");
  });

  test("marks the side question's tab, and the one on show beside it", () => {
    useStore.setState({ repos: [repo], runs: { p: parent, s1: side }, sideShown: { p: "s1" } });
    const shown = sheet(parent);
    expect(shown).toContain('<span class="rtab-side">btw</span>');
    expect(shown).toMatch(/class="rtab st-idle beside"[^>]*aria-pressed="true"/);
    useStore.setState({ sideShown: {} });
    const closed = sheet(parent);
    expect(closed).toMatch(/class="rtab st-idle"[^>]*aria-pressed="false"/);
    expect(closed).toContain("Show this side question beside its run");
    expect(closed).not.toContain("<aside");
  });

  test("a column whose chat has left the page draws nothing", () => {
    useStore.setState({ repos: [repo], runs: { p: parent }, sideShown: { p: "s1" } });
    expect(sheet(parent)).not.toContain("<aside");
  });
});

describe("a side question's own console", () => {
  test("says what it started from, with its model and a way to its run", () => {
    useStore.setState({ repos: [repo], runs: { p: parent, s1: side } });
    const html = sheet(side);
    expect(html).toContain("a side question, started from: migrate the billing checkout");
    expect(html).toContain(">show beside its run<");
    expect(html).toMatch(/<option value="haiku" selected="">haiku<\/option>/);
    // its box sends to the thread: btw is only a word here
    expect(html).not.toContain("side-btn");
  });

  test("offers no way to its run once that run is gone, or in a window of its own", () => {
    useStore.setState({ repos: [repo], runs: { s1: side } });
    expect(sheet(side)).not.toContain("show beside its run");
    useStore.setState({ repos: [repo], runs: { p: parent, s1: side } });
    expect(drawn(<SideLine run={side} solo={false} />)).toContain("show beside its run");
    expect(drawn(<SideLine run={side} solo />)).not.toContain("show beside its run");
  });

  test("an ended one keeps its line, with the model's select off", () => {
    const ended = { ...side, status: "stopped" as const, endedAt: 20 };
    useStore.setState({ repos: [repo], runs: { p: parent, s1: ended } });
    const html = sheet(ended);
    expect(html).toContain("a side question, started from");
    expect(html).toMatch(/<select[^>]*disabled=""[^>]*aria-label="This side question&#x27;s model"/);
  });
});

test("a coordinator's box offers no side question", () => {
  const coordinator = run("c", { action: "coordinate", verb: "Coordinate", chat: true, status: "idle", tasks: [] });
  useStore.setState({ repos: [repo], runs: { c: coordinator } });
  expect(sheet(coordinator)).not.toContain("side-btn");
});

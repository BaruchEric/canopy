/**
 * The steer box under an agent's screen (FR-066), rendered from the real
 * component with the store seeded the way GateButtons.test.tsx seeds it:
 * an agent at its prompt takes words, one waiting on a choice does not.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentCard, Ask, Repo, TailchanInfo } from "../../../src/core/types";
import { registry, setRegistry } from "../registry";
import { useStore } from "../store";
import { AgentScreen } from "./AgentFocus";

const pristine = useStore.getState();
const pristineRegistry = registry();

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

afterEach(() => {
  setRegistry(pristineRegistry.home, [...pristineRegistry.names]);
  useStore.setState({
    chan: pristine.chan,
    asks: pristine.asks,
    shells: pristine.shells,
    repos: pristine.repos,
    home: pristine.home,
    backendOrder: pristine.backendOrder,
  });
});

const card = (over: Partial<AgentCard> = {}): AgentCard => ({
  id: "claude:s1",
  handle: "claude-s1",
  node: "mini",
  harness: "claude",
  session: "s1",
  origin: "elsewhere",
  cwd: "/r/canopy",
  repo: null,
  branch: null,
  model: null,
  mode: null,
  state: "working",
  waiting: null,
  caps: [],
  offers: [],
  notifyIdle: false,
  where: { os: "linux", container: false, pid: 1, term: null, canopy: null },
  transcript: null,
  startedAt: 0,
  seenAt: 0,
  endedAt: null,
  ...over,
});

const chan: TailchanInfo = { ready: true, as: "eric", bot: "canopy", channel: "canopy", notify: false, who: [], channels: [] };

const ask = (agent: string): Ask => ({
  id: "q1",
  agent,
  handle: "claude-s1",
  node: "mini",
  kind: "permission",
  tool: "Bash",
  title: "Run rm -rf build",
  detail: "",
  route: "remote",
  waitUntil: 10_000,
  state: "open",
  createdAt: 1,
});

const repo: Repo = { id: "canopy", name: "canopy", path: "/r/canopy", group: "dev", source: "/r", status: null };

/** a hooked agent elsewhere, whose box sends a DM */
function dm(c: AgentCard, asks: Record<string, Ask> = {}): string {
  useStore.setState({ chan, asks });
  return renderCurrent(<AgentScreen card={c} live={false} active={false} now={1000} />);
}

/** an agent in a canopy shell on the home backend, whose box types into it */
function shell(c: AgentCard, asks: Record<string, Ask> = {}): string {
  setRegistry("mac", ["mac"]);
  useStore.setState({
    home: "mac",
    backendOrder: ["mac"],
    shells: [{ id: "t1", repoId: "canopy", path: "/r/canopy", place: "strip", attached: false, viewers: [], startedAt: 0 }],
    repos: [repo],
    asks,
  });
  const inShell = { ...c, where: { ...c.where, canopy: { backend: "mac", term: "t1" } } };
  return renderCurrent(<AgentScreen card={inShell} live={false} active={false} now={1000} />);
}

/** the steer box's textarea, the one with a screen reader's name for words to the agent */
function box(html: string): string {
  const m = /<textarea[^>]*aria-label="(?:A DM to|Words to type into)[^"]*"[^>]*>/.exec(html);
  if (!m) throw new Error("no steer box in the markup");
  return m[0];
}

const SHUT = 'placeholder="Claude waits on you: answer above"';

describe("the steer box under an agent's screen", () => {
  test("an agent at its prompt, waiting your turn, takes words: in its shell and as a DM", () => {
    const idle = card({ state: "waiting", waiting: "your turn" });
    for (const html of [shell(idle), dm(idle)]) {
      const b = box(html);
      expect(b).not.toContain("disabled");
      expect(b).not.toContain(SHUT);
    }
    expect(box(shell(idle))).toContain('placeholder="type to Claude in its shell…"');
    expect(box(dm(idle))).toContain('placeholder="a DM to @claude-s1…"');
  });

  test("an agent waiting on a permission, or with no word on what it waits on, takes none", () => {
    for (const waiting of ["permission", null]) {
      const asks = card({ state: "waiting", waiting });
      for (const html of [shell(asks), dm(asks)]) {
        const b = box(html);
        expect(b).toContain('disabled=""');
        expect(b).toContain(SHUT);
      }
    }
  });

  test("an open ask of its shuts the box, as the server refuses words then", () => {
    for (const c of [card({ state: "waiting", waiting: "your turn" }), card({ state: "working" })]) {
      for (const html of [shell(c, { q1: ask(c.id) }), dm(c, { q1: ask(c.id) })]) expect(box(html)).toContain('disabled=""');
      // another agent's ask leaves it open
      expect(box(shell(c, { q1: ask("claude:other") }))).not.toContain("disabled");
      // an ask already answered too
      expect(box(dm(c, { q1: { ...ask(c.id), state: "answered" } }))).not.toContain("disabled");
    }
  });

  test("a working agent takes words", () => {
    expect(box(shell(card()))).not.toContain("disabled");
    expect(box(dm(card()))).not.toContain("disabled");
  });
});

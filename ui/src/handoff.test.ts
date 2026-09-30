import { describe, expect, test } from "bun:test";
import type { AgentCard, Repo } from "../../src/core/types";
import { cardOfShell, handoffFrom, handoffPrompt, handoffRepo, otherHarness } from "./handoff";

const card = (over: Partial<AgentCard> = {}): AgentCard => ({
  id: "claude:s1",
  handle: "app-0123",
  node: "macmini-2018",
  harness: "claude",
  session: "s1",
  origin: "canopy-shell",
  cwd: "/dev/app/src",
  repo: "https://github.com/me/app",
  branch: "main",
  model: null,
  mode: null,
  state: "working",
  waiting: null,
  caps: [],
  offers: [],
  notifyIdle: false,
  where: { os: "linux", container: true, pid: 4, term: null, canopy: { backend: "mini", term: "0123" } },
  transcript: "/home/bun/.claude/projects/-dev-app/s1.jsonl",
  startedAt: 1,
  seenAt: 2,
  endedAt: null,
  ...over,
});

const repo = (id: string, path: string, extra: Partial<Repo> = {}): Repo => ({ id, name: id, path, group: "", source: "launch", status: null, ...extra });

test("the other harness", () => {
  expect(otherHarness("claude")).toBe("codex");
  expect(otherHarness("codex")).toBe("claude");
});

test("handoffPrompt names the transcript, or says nothing without one", () => {
  expect(handoffPrompt("claude", "/t/s1.jsonl")).toBe("Continue the work of the Claude Code session whose transcript is /t/s1.jsonl. Read its last part first.");
  expect(handoffPrompt("codex", "/r.jsonl")).toBe("Continue the work of the Codex session whose transcript is /r.jsonl. Read its last part first.");
  expect(handoffPrompt("claude", null)).toBe("");
});

describe("handoffFrom", () => {
  test("a live canopy shell or run on a backend the page shows", () => {
    expect(handoffFrom(card(), ["mini"])).toEqual({ backend: "mini", harness: "claude" });
    expect(handoffFrom(card({ harness: "codex", where: { ...card().where, canopy: { backend: "mac", run: "r1" } } }), ["mini", "mac"])).toEqual({ backend: "mac", harness: "codex" });
  });
  test("nothing for a card canopy cannot open a shell beside", () => {
    expect(handoffFrom(card(), ["mac"])).toBeNull();
    expect(handoffFrom(card({ state: "ended" }), ["mini"])).toBeNull();
    expect(handoffFrom(card({ harness: "other" }), ["mini"])).toBeNull();
    expect(handoffFrom(card({ where: { ...card().where, canopy: null } }), ["mini"])).toBeNull();
    expect(handoffFrom(card({ where: { ...card().where, canopy: { backend: "mini" } } }), ["mini"])).toBeNull();
  });
});

test("handoffRepo is the deepest local checkout holding the folder, else the one the url names", () => {
  const outer = repo("dev", "/dev");
  const app = repo("app", "/dev/app");
  const other = repo("other", "/elsewhere", { remotes: ["git@github.com:me/app.git"] });
  expect(handoffRepo(card(), [outer, app, other])?.id).toBe("app");
  expect(handoffRepo(card({ cwd: "/tmp/x" }), [outer, app, other])?.id).toBe("other");
  expect(handoffRepo(card({ cwd: "/dev/app" }), [repo("ssh", "/dev/app", { host: "box" })])).toBeUndefined();
});

test("cardOfShell finds the live card a shell's agent registered under", () => {
  const cards = {
    a: card({ id: "a", seenAt: 5 }),
    b: card({ id: "b", seenAt: 9 }),
    c: card({ id: "c", seenAt: 20, state: "ended" }),
    d: card({ id: "d", seenAt: 30, where: { ...card().where, canopy: { backend: "mac", term: "0123" } } }),
  };
  expect(cardOfShell(cards, "mini", "0123")?.id).toBe("b");
  expect(cardOfShell(cards, "mini", "9999")).toBeUndefined();
});

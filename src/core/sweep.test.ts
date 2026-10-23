import { expect, test } from "bun:test";
import { DEFAULT_SWEEP, normalizeSweep, patchSweep, planSweep, type ShellFacts } from "./sweep";
import type { AgentCard, Run } from "./types";

const H = 3_600_000;
const now = Date.UTC(2026, 9, 22, 12);
const base = { serverStart: now - 72 * H, shells: [], runs: [], heldRuns: new Set<string>(), outside: [] };
const shell = (over: Partial<ShellFacts> = {}): ShellFacts =>
  ({ id: "t1", repoId: "dev-tools/canopy", startedAt: now - 48 * H, lastOutput: now - 30 * H, agent: null, ...over });
const run = (over: Partial<Run> = {}): Run => ({
  id: "r1", repoId: "dev-tools/canopy", action: "chat", verb: "Chat", progress: "", expectsChange: false, chat: false, harness: "claude",
  note: "", status: "done", startedAt: now - 100 * H, steps: [], prompt: null, ...over,
});
const card = (over: Partial<AgentCard> = {}): AgentCard => ({
  id: "claude:s1", handle: "h", node: "mac", harness: "claude", session: "s1", origin: "elsewhere", cwd: "/x", repo: null, branch: null, model: null,
  mode: null, state: "idle", waiting: null, caps: [], offers: [], notifyIdle: false,
  where: { os: "darwin", container: false, pid: 1, term: "kitty", canopy: null }, transcript: null, startedAt: now - 30 * H, seenAt: now - 25 * H, endedAt: null, ...over,
});

test("a shell quiet past its span is offered, checked", () => {
  const [it] = planSweep({ ...base, shells: [shell()] }, DEFAULT_SWEEP, now);
  expect(it).toMatchObject({ key: "shell:t1", kind: "shell", closable: true, checked: true, idleSince: now - 30 * H, why: "no input or output for 30h" });
});
test("a keystroke inside the span keeps it", () => {
  expect(planSweep({ ...base, shells: [shell({ lastInput: now - 1 * H })] }, DEFAULT_SWEEP, now)).toEqual([]);
});
test("after a restart idle counts from the start, not from old output", () => {
  expect(planSweep({ ...base, serverStart: now - 2 * H, shells: [shell()] }, DEFAULT_SWEEP, now)).toEqual([]);
});
test("tmux not answering offers no shells", () => {
  expect(planSweep({ ...base, shells: null }, DEFAULT_SWEEP, now)).toEqual([]);
});
test.each([
  ["labelled", { label: "deploy" }], ["task", { task: true }], ["ranger", { ranger: true }], ["mid-move", { moving: true }],
  ["working agent", { agent: { state: "working", session: "s" } }], ["waiting agent", { agent: { state: "waiting", session: "s" } }],
])("a %s shell is never offered", (_n, over) => {
  expect(planSweep({ ...base, shells: [shell(over as Partial<ShellFacts>)] }, DEFAULT_SWEEP, now)).toEqual([]);
});
test("a shell running a quiet program is listed unticked, saying what runs", () => {
  const [it] = planSweep({ ...base, shells: [shell({ command: "vim" })] }, DEFAULT_SWEEP, now);
  expect(it).toMatchObject({ key: "shell:t1", closable: true, checked: false, auto: false, why: "running vim, no input or output for 30h" });
});
test.each(["zsh", "-zsh", "bash", "-bash", "sh", "fish", "dash", "ksh", "tcsh", "nu"])("a shell at its %s prompt is still ticked", (command) => {
  const [it] = planSweep({ ...base, shells: [shell({ command })] }, DEFAULT_SWEEP, now);
  expect(it).toMatchObject({ key: "shell:t1", checked: true, auto: true, why: "no input or output for 30h" });
});
test("an idle agent at its prompt goes with its shell", () => {
  expect(planSweep({ ...base, shells: [shell({ agent: { state: "idle", session: "s" } })] }, DEFAULT_SWEEP, now)).toHaveLength(1);
});
test("an idle Claude chat past 12h is offered; a Codex chat is listed but not closable", () => {
  const at = now - 13 * H;
  const step = { id: "1", at, kind: "text" as const };
  const out = planSweep({
    ...base,
    runs: [
      run({ id: "c1", chat: true, status: "idle", session: "sess", steps: [step] }),
      run({ id: "c2", chat: true, status: "idle", harness: "codex", session: "th", steps: [step] }),
    ],
  }, DEFAULT_SWEEP, now);
  expect(out.map((i) => i.key)).toEqual(["chat:c1", "chat:c2"]);
  expect(out[0]).toMatchObject({ kind: "chat", closable: true, checked: true, idleSince: at, why: "chat quiet for 13h" });
  expect(out[1]).toMatchObject({ kind: "chat", closable: false, checked: false });
});
test("a finished run past 3d is offered unless landing or a flow holds it", () => {
  const r = run({ id: "d1", status: "done", endedAt: now - 4 * 24 * H });
  const [it] = planSweep({ ...base, runs: [r] }, DEFAULT_SWEEP, now);
  expect(it).toMatchObject({ key: "run:d1", kind: "run", closable: true, checked: true, why: "finished 4d ago" });
  expect(planSweep({ ...base, runs: [r], heldRuns: new Set(["d1"]) }, DEFAULT_SWEEP, now)).toEqual([]);
});
test("an outside agent is listed, never closable or checked", () => {
  const [it] = planSweep({ ...base, outside: [card()] }, DEFAULT_SWEEP, now);
  expect(it).toMatchObject({ kind: "outside", closable: false, checked: false, idleSince: now - 25 * H });
  expect(planSweep({ ...base, outside: [card({ where: { os: "linux", container: false, pid: 1, term: null, canopy: { backend: "mini" } } })] }, DEFAULT_SWEEP, now)).toEqual([]);
});
test("normalizeSweep drops a negative span and an unknown auto kind to defaults", () => {
  expect(normalizeSweep({ spans: { shell: -1 }, auto: ["shell", "nope"] })).toMatchObject({ spans: { shell: 24 * H }, auto: ["shell"] });
});
test("patchSweep refuses a cron parseCron rejects", () => {
  expect(typeof patchSweep(DEFAULT_SWEEP, { cron: "every day" })).toBe("string");
});
test("normalizeSweep turns the schedule off for a cron that does not read", () => {
  expect(normalizeSweep({ on: true, cron: "nope" })).toMatchObject({ on: false, cron: "0 4 * * *" });
  expect(normalizeSweep({ on: true, cron: "0 5 * * *" })).toMatchObject({ on: true, cron: "0 5 * * *" });
});
test("a finished chat is a run item; the same chat idle is a chat item", () => {
  const ended = run({ id: "c1", chat: true, status: "done", session: "s", endedAt: now - 4 * 24 * H });
  expect(planSweep({ ...base, runs: [ended] }, DEFAULT_SWEEP, now)).toMatchObject([{ key: "run:c1", kind: "run", closable: true, checked: true }]);
  const idle = run({ id: "c1", chat: true, status: "idle", session: "s", startedAt: now - 4 * 24 * H });
  expect(planSweep({ ...base, runs: [idle] }, DEFAULT_SWEEP, now)).toMatchObject([{ key: "chat:c1", kind: "chat" }]);
});

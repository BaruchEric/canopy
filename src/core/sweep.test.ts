import { expect, test } from "bun:test";
import { DEFAULT_SWEEP, mayClose, normalizeSweep, patchSweep, planSweep, sweepComment, type OutsideFacts, type ShellFacts } from "./sweep";
import type { AuthoredPr, Run, SweepItem } from "./types";

const H = 3_600_000;
const now = Date.UTC(2026, 9, 22, 12);
const base = { serverStart: now - 72 * H, shells: [], runs: [], heldRuns: new Set<string>(), outside: [], prs: [], fixing: new Set<string>(), repos: [] };
const shell = (over: Partial<ShellFacts> = {}): ShellFacts =>
  ({ id: "t1", repoId: "dev-tools/canopy", startedAt: now - 48 * H, lastOutput: now - 30 * H, agent: null, ...over });
const run = (over: Partial<Run> = {}): Run => ({
  id: "r1", repoId: "dev-tools/canopy", action: "chat", verb: "Chat", progress: "", expectsChange: false, chat: false, harness: "claude",
  note: "", status: "done", startedAt: now - 100 * H, steps: [], prompt: null, ...over,
});
const card = (over: Partial<OutsideFacts> = {}): OutsideFacts => ({
  id: "claude:s1", handle: "h", node: "mac", harness: "claude", session: "s1", origin: "elsewhere", cwd: "/x", repo: null, branch: null, model: null,
  mode: null, state: "idle", waiting: null, caps: [], offers: [], notifyIdle: false,
  where: { os: "darwin", container: false, pid: 1, term: "kitty", canopy: null }, transcript: null, startedAt: now - 30 * H, seenAt: now - 25 * H, endedAt: null, idleSince: now - 25 * H, ...over,
});

test("a shell quiet past its span is offered, checked", () => {
  const [it] = planSweep({ ...base, shells: [shell()] }, DEFAULT_SWEEP, now);
  expect(it).toMatchObject({ key: "shell:t1", kind: "shell", closable: true, checked: true, idleSince: now - 30 * H, why: "no input or output for 30h" });
});
test("a span under an hour reads in minutes, never 0h", () => {
  const short = { ...DEFAULT_SWEEP, spans: { ...DEFAULT_SWEEP.spans, shell: 60_000 } };
  const at = (ms: number) => planSweep({ ...base, shells: [shell({ lastOutput: now - ms })] }, short, now)[0]?.why;
  expect(at(45 * 60_000)).toBe("no input or output for 45m");
  expect(at(90_000)).toBe("no input or output for 1m");
  expect(at(3 * H)).toBe("no input or output for 3h");
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
  expect(it).toMatchObject({ key: "shell:t1", closable: true, checked: false, handOnly: true, auto: false, why: "running vim, no input or output for 30h" });
});
test.each(["zsh", "-zsh", "bash", "-bash", "sh", "fish", "dash", "ksh", "tcsh", "nu"])("a shell at its %s prompt is still ticked", (command) => {
  const [it] = planSweep({ ...base, shells: [shell({ command })] }, DEFAULT_SWEEP, now);
  expect(it).toMatchObject({ key: "shell:t1", checked: true, handOnly: false, auto: true, why: "no input or output for 30h" });
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
  expect(out[0]).toMatchObject({ kind: "chat", closable: true, checked: true, handOnly: false, idleSince: at, why: "chat quiet for 13h" });
  expect(out[1]).toMatchObject({ kind: "chat", closable: false, checked: false, handOnly: false });
});
test("a finished run past 3d is offered unless landing or a flow holds it", () => {
  const r = run({ id: "d1", status: "done", endedAt: now - 4 * 24 * H });
  const [it] = planSweep({ ...base, runs: [r] }, DEFAULT_SWEEP, now);
  expect(it).toMatchObject({ key: "run:d1", kind: "run", closable: true, checked: true, handOnly: false, why: "finished 4d ago" });
  expect(planSweep({ ...base, runs: [r], heldRuns: new Set(["d1"]) }, DEFAULT_SWEEP, now)).toEqual([]);
});
test("a limited run is a finished run for sweeping", () => {
  const r = run({ id: "l1", status: "limited", endedAt: now - 4 * 24 * H });
  expect(planSweep({ ...base, runs: [r] }, DEFAULT_SWEEP, now)).toMatchObject([
    { key: "run:l1", kind: "run", closable: true, checked: true, why: "finished 4d ago" },
  ]);
});
test("an outside agent is listed, never closable or checked", () => {
  const [it] = planSweep({ ...base, outside: [card()] }, DEFAULT_SWEEP, now);
  expect(it).toMatchObject({ kind: "outside", closable: false, checked: false, handOnly: false, idleSince: now - 25 * H });
  expect(planSweep({ ...base, outside: [card({ where: { os: "linux", container: false, pid: 1, term: null, canopy: { backend: "mini" } } })] }, DEFAULT_SWEEP, now)).toEqual([]);
});
test("an outside agent's heartbeats do not reset its idle span", () => {
  const idle = { ...card({ seenAt: now }), idleSince: now - 25 * H };
  const out = planSweep({ ...base, outside: [idle] }, DEFAULT_SWEEP, now);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ key: "outside:claude:s1", idleSince: now - 25 * H, why: "idle for 25h, not started by canopy", closable: false });
});
test("normalizeSweep drops a negative span and an unknown auto kind to defaults", () => {
  expect(normalizeSweep({ spans: { shell: -1 }, auto: ["shell", "nope"] })).toMatchObject({ spans: { shell: 24 * H }, auto: ["shell"] });
});
test("patchSweep refuses a cron parseCron rejects", () => {
  expect(typeof patchSweep(DEFAULT_SWEEP, { cron: "every day" })).toBe("string");
});
test("patchSweep refuses a span under 10 minutes, and takes 10 minutes itself", () => {
  expect(patchSweep(DEFAULT_SWEEP, { spans: { shell: 60_000 } })).toBe("a span is at least 10 minutes");
  expect(patchSweep(DEFAULT_SWEEP, { spans: { chat: 10 * 60_000 - 1 } })).toBe("a span is at least 10 minutes");
  expect(patchSweep(DEFAULT_SWEEP, { spans: { run: 10 * 60_000 } })).toMatchObject({ spans: { run: 10 * 60_000 } });
});
test("normalizeSweep keeps a short span a config was given by hand", () => {
  expect(normalizeSweep({ spans: { shell: 1_000 } }).spans.shell).toBe(1_000);
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
test("mayClose: closable and not by hand only, whatever the sheet's default tick", () => {
  const it = (over: Partial<SweepItem>): SweepItem => ({
    key: "pr:1", kind: "pr", id: "1", repoId: "app", where: "o/app", title: "PR 1", idleSince: 0, why: "", closable: true, checked: false, handOnly: false, auto: false, ...over,
  });
  // a PR as phase 3 will plan it: unticked in the sheet, still closable from the ask
  expect(mayClose(it({}))).toBe(true);
  expect(mayClose(it({ kind: "chat", key: "chat:c1", checked: false }))).toBe(true);
  // a shell running a program: only a tick in the sheet closes it
  expect(mayClose(it({ kind: "shell", key: "shell:t1", handOnly: true }))).toBe(false);
  expect(mayClose(it({ kind: "outside", key: "outside:o1", closable: false, checked: true }))).toBe(false);
});

const D = 24 * H;
const authored = (over: Partial<AuthoredPr> = {}): AuthoredPr => ({
  slug: "barucheric/canopy", number: 12, url: "https://github.com/BaruchEric/canopy/pull/12", title: "Fix the tree", branch: "run/fix",
  draft: false, updatedAt: now - 15 * D, autoMerge: false, queued: false, archived: false, ...over,
});
const checkout = { id: "dev-tools/canopy", remotes: ["git@github.com:BaruchEric/canopy.git"] };

test("an authored PR quiet 15 days is offered, unticked", () => {
  const [it] = planSweep({ ...base, prs: [authored()], repos: [checkout] }, DEFAULT_SWEEP, now);
  expect(it).toEqual({
    key: "pr:barucheric/canopy#12", kind: "pr", id: "barucheric/canopy#12", repoId: "dev-tools/canopy", where: "dev-tools/canopy", title: "#12 Fix the tree",
    idleSince: now - 15 * D, why: "no activity for 15d", closable: true, checked: false, handOnly: false, auto: false,
  });
  expect(mayClose(it as SweepItem)).toBe(true);
  // inside the span it waits
  expect(planSweep({ ...base, prs: [authored({ updatedAt: now - 13 * D })] }, DEFAULT_SWEEP, now)).toEqual([]);
  // with pr in auto, the schedule may close it
  expect(planSweep({ ...base, prs: [authored()] }, { ...DEFAULT_SWEEP, auto: ["pr"] }, now)[0]).toMatchObject({ auto: true, checked: false });
});
test("a draft is offered unticked and hand only", () => {
  const [it] = planSweep({ ...base, prs: [authored({ draft: true })] }, { ...DEFAULT_SWEEP, auto: ["pr"] }, now);
  expect(it).toMatchObject({ kind: "pr", closable: true, checked: false, handOnly: true, auto: false, why: "draft, no activity for 15d" });
  expect(mayClose(it as SweepItem)).toBe(false);
});
test("archived, auto-merge, queued and fixing PRs are never offered", () => {
  const prs = [authored({ number: 1, archived: true }), authored({ number: 2, autoMerge: true }), authored({ number: 3, queued: true }), authored({ number: 4 })];
  expect(planSweep({ ...base, prs, fixing: new Set(["barucheric/canopy#4"]) }, DEFAULT_SWEEP, now)).toEqual([]);
});
test("a PR on a repo with no checkout is listed by slug", () => {
  const elsewhere = { id: "web-apps/other", remotes: ["git@github.com:BaruchEric/other.git", "ssh://git@192.168.1.76:2222/eric/canopy.git"] };
  const [it] = planSweep({ ...base, prs: [authored()], repos: [elsewhere, { id: "bare" }] }, DEFAULT_SWEEP, now);
  expect(it).toMatchObject({ key: "pr:barucheric/canopy#12", repoId: null, where: "barucheric/canopy" });
});
test("a checkout on this machine beats one over ssh, whichever the scan lists first", () => {
  const remote = { ...checkout, id: "mini:dev-tools/canopy", host: "mini" };
  const plan = (repos: (typeof checkout & { host?: string })[]) => planSweep({ ...base, prs: [authored()], repos }, DEFAULT_SWEEP, now)[0]?.repoId;
  expect(plan([remote, checkout])).toBe("dev-tools/canopy");
  expect(plan([checkout, remote])).toBe("dev-tools/canopy");
  expect(plan([remote, { ...remote, id: "nas:canopy", host: "nas" }])).toBe("mini:dev-tools/canopy");
});
test("a forge listing is not a checkout, so the PR goes to the clone", () => {
  const listing = { ...checkout, id: "forge:eric/canopy", forge: { kind: "forgejo" as const, slug: "eric/canopy", clone: "", branch: "main", updated: 0, private: false, empty: false } };
  expect(planSweep({ ...base, prs: [authored()], repos: [listing, checkout] }, DEFAULT_SWEEP, now)[0]).toMatchObject({ repoId: "dev-tools/canopy" });
  expect(planSweep({ ...base, prs: [authored()], repos: [listing] }, DEFAULT_SWEEP, now)[0]).toMatchObject({ repoId: null });
});
test("PRs sort after runs and before outside agents, oldest first", () => {
  const out = planSweep({
    ...base,
    prs: [authored({ number: 1, updatedAt: now - 15 * D }), authored({ number: 2, updatedAt: now - 20 * D })],
    runs: [run({ id: "d1", status: "done", endedAt: now - 4 * D })],
    outside: [card()],
  }, DEFAULT_SWEEP, now);
  expect(out.map((i) => i.key)).toEqual(["run:d1", "pr:barucheric/canopy#2", "pr:barucheric/canopy#1", "outside:claude:s1"]);
});

test("sweepComment says the pr span in whole days, else hours, else minutes, rounded down", () => {
  expect(sweepComment(DEFAULT_SWEEP.spans.pr)).toBe("Closed by canopy's sweep after 14 days with no activity. Reopen it to pick it back up.");
  expect(sweepComment(36 * 3_600_000)).toBe("Closed by canopy's sweep after 1 day with no activity. Reopen it to pick it back up.");
  expect(sweepComment(5 * 3_600_000)).toBe("Closed by canopy's sweep after 5 hours with no activity. Reopen it to pick it back up.");
  expect(sweepComment(3_600_000)).toBe("Closed by canopy's sweep after 1 hour with no activity. Reopen it to pick it back up.");
  expect(sweepComment(15 * 60_000)).toBe("Closed by canopy's sweep after 15 minutes with no activity. Reopen it to pick it back up.");
  expect(sweepComment(1_000)).toBe("Closed by canopy's sweep after 1 minute with no activity. Reopen it to pick it back up.");
});

test("prs is off by default, read only as true, and patched only with a boolean", () => {
  expect(DEFAULT_SWEEP.prs).toBe(false);
  expect(normalizeSweep({ prs: "yes" }).prs).toBe(false);
  expect(normalizeSweep({ prs: true }).prs).toBe(true);
  expect(patchSweep(DEFAULT_SWEEP, { prs: 1 })).toBe("prs is true or false");
  expect(patchSweep(DEFAULT_SWEEP, { prs: true })).toMatchObject({ prs: true, auto: DEFAULT_SWEEP.auto });
});

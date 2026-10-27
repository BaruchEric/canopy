import { describe, expect, test } from "bun:test";
import type { RunGroup } from "../../src/core/group";
import type { CostEntry } from "../../src/core/costs";
import { api } from "./api";
import { groupWord, memberColumns, costOfGroup, groupWaiting, canPickMember } from "./groups";
import { repoLanding, chipWords, mergeLanding } from "./landing";
import { mergeInbox as inbox } from "./inbox";
import { qEvent, qGroup } from "./qualify";

const sampleGroup = (over: Partial<RunGroup> = {}): RunGroup => ({ id: "g", repoId: "repo", repoPath: "/repo", action: "ask", note: "make it better", expectedMembers: 2, members: [{ origin: "a", run: "r-a", profile: null }, { origin: "b", run: "r-b", profile: "fast" }], state: "needs-you", autoLand: false, startedAt: 1, scores: { a: { state: "ready", branch: "run/a", base: "base", gates: { ok: true }, verdict: "land", cost: { usd: 2, tokens: 30 } }, b: { state: "ready", branch: "run/b", base: "base", gates: { ok: false, red: "test" } } }, ...over });
const empty = { runs: [], entries: [], orphans: [] };

describe("group display", () => {
  test("words distinguish picked waiting from needs-you and completed work", () => {
    expect(groupWord(sampleGroup())).toBe("ready: pick");
    expect(groupWord(sampleGroup({ state: "picked" }))).toBe("picked, waiting to land");
    expect(groupWord(sampleGroup({ state: "landed" }))).toBe("landed");
  });
  test("columns retain start order, origin scores and profile with no live runs after restart", () => {
    const columns = memberColumns(sampleGroup(), empty);
    expect(columns.map(c => c.member.origin)).toEqual(["a", "b"]);
    expect(columns[0]?.cost).toEqual({ usd: 2, tokens: 30 });
    expect(columns[0]?.run).toBeUndefined();
    expect(columns[1]?.member.profile).toBe("fast");
    expect(canPickMember(sampleGroup(), "a", { ...empty, runs: [landingMember] })).toBe(true);
    expect(canPickMember(sampleGroup(), "b", empty)).toBe(false);
  });
  test("cost rows require both group and run; reviewer cost stays separate", () => {
    const row: CostEntry = { at: 1, service: "codex", provider: "openai", model: null, repo: "/repo", repoName: "repo", run: "r-a", group: "g", label: null, session: null, usd: 2, tokens: { input: 5, output: 3, total: 8, cachedInput: 0, reasoning: 0 }, seconds: null };
    expect(costOfGroup([row, { ...row, run: "review", usd: 20 }, { ...row, group: "other", usd: 40 }], "g", "r-a")).toEqual({ usd: 2, tokens: 8 });
  });
  test("one landing row and card count, ordinary members suppressed", () => {
    const info = { ...empty, groups: [sampleGroup()] };
    expect(repoLanding(info, "repo").groups).toHaveLength(1);
    expect(chipWords(info, "repo")?.text).toBe("1 group");
    expect(mergeLanding({ a: info, b: empty }).groups).toHaveLength(1);
  });
  test("needs-you is an inbox pick; picked manual land is only a waiting turn", () => {
    const ctx = { repos: [], cards: {}, landing: { ...empty, groups: [sampleGroup()] } };
    expect(inbox([], {}, {}, 5, ctx)[0]).toMatchObject({ source: "group", kind: "group", title: "best of 2 ready: pick", id: "g" });
    const picked = sampleGroup({ state: "picked", winner: "a" });
    expect(inbox([], {}, {}, 5, { ...ctx, landing: { ...empty, groups: [picked] } })).toHaveLength(0);
    expect(groupWaiting(picked, empty)).toBe(true);
    expect(groupWaiting(sampleGroup(), empty)).toBe(false);
  });
  test("every foreign group/member/reviewer ID is qualified in GET and SSE, branch names stay plain", () => {
    const group = sampleGroup({ winner: "a", review: { run: "review", ranking: ["run/a"], why: { "run/a": "Best." } }, keptUntil: { b: 99 } });
    const qualified = qGroup(id => `remote|${id}`, group);
    expect(qualified).toMatchObject({ id: "remote|g", repoId: "remote|repo", winner: "remote|a", members: [{ origin: "remote|a", run: "remote|r-a" }, { origin: "remote|b", run: "remote|r-b" }], review: { run: "remote|review", ranking: ["run/a"] }, keptUntil: { "remote|b": 99 } });
    expect(qualified.scores?.["remote|a"]?.branch).toBe("run/a");
    expect(qEvent(id => `remote|${id}`, { type: "landing", landing: { ...empty, groups: [group] } })).toMatchObject({ landing: { groups: [qualified] } });
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupSheet } from "./components/GroupSheet";
import { ParentLine } from "./components/CoordTasks";
import { RunChip } from "./components/RunChip";
import { turnItems, useStore } from "./store";
import type { LandingRun, Run } from "../../src/core/types";

const liveMember: Run = { id: "r-a", repoId: "repo", action: "ask", verb: "ask", progress: "working", expectsChange: true, chat: false, harness: "claude", note: "n", status: "done", startedAt: 1, steps: [], prompt: null, group: "g", branch: { name: "run/a", origin: "a", base: "base", target: "main", dir: "/w/a", state: "ready", group: "g", work: "work-a" } };
const landingMember: LandingRun = { id: "a", runId: "r-a", repoId: "repo", repoPath: "/repo", branch: "run/a", target: "main", base: "base", dir: "/w/a", note: "n", verb: "ask", harness: "claude", state: "ready", startedAt: 1, group: "g", work: "work-a" };

test("picked groups appear as one waiting turn, never member duplicates", () => {
  const state = useStore.getState();
  const info = { ...empty, groups: [sampleGroup({ state: "picked", winner: "a" })], runs: [landingMember] };
  expect(turnItems({ ...state, landing: { "": info } }).filter(t => t.kind === "group")).toMatchObject([{ id: "g", repoId: "repo" }]);
});

test("real group sheet renders origin-scored columns, failed gates and safe winner actions", () => {
  const state = useStore.getState();
  const initial = { ...useStore.getInitialState() };
  const render = (node: ReturnType<typeof createElement>) => {
    Object.assign(useStore.getInitialState(), useStore.getState());
    return renderToStaticMarkup(node);
  };
  useStore.setState({ landing: { "": { ...empty, runs: [landingMember], groups: [sampleGroup()] } }, runs: { "r-a": liveMember } });
  try {
    const html = render(createElement(GroupSheet, { groupId: "g" }));
    expect(html).toContain("best of 2");
    expect(html).toContain("failed: test");
    expect(html.match(/pick this one/g)).toHaveLength(1);
    expect(html).not.toContain("land the winner");
    expect(render(createElement(ParentLine, { run: liveMember }))).toContain("one of 2");
    const chip = render(createElement(RunChip, { run: liveMember }));
    expect(chip).toContain("best of 2: ready: pick");
    expect(chipWords({ ...empty, groups: [sampleGroup()] }, "repo", "g")).toBeNull();
    expect(render(createElement(RunChip, { run: { ...liveMember, group: undefined, branch: undefined } }))).toContain(">done</button>");
    useStore.setState({ landing: { "": { ...empty, runs: [landingMember], groups: [sampleGroup({ state: "picked", winner: "a" })] } } });
    expect(render(createElement(GroupSheet, { groupId: "g" }))).toContain("land the winner");
  } finally { useStore.setState(state); Object.assign(useStore.getInitialState(), initial); }
});

test("land all in a grouped repo sends only eligible origins and never repo-wide losers", async () => {
  const state = useStore.getState();
  const all = api.landAll;
  const land = api.land;
  const calls: string[] = [];
  api.landAll = async () => { calls.push("repo-wide"); return { queued: [], skipped: [] }; };
  api.land = async id => { calls.push(id); };
  useStore.setState({ landing: { "": { ...empty, groups: [sampleGroup({ state: "picked", winner: "a" })], runs: [landingMember, { ...landingMember, id: "b", runId: "r-b" }, { ...landingMember, id: "standalone", group: undefined }] } } });
  try {
    await useStore.getState().landAll("repo");
    expect(calls).toEqual(["a", "standalone"]);
  } finally { api.land = land; api.landAll = all; useStore.setState(state); }
});

test("store group mutations preserve board selection and keep qualified group state", async () => {
  const state = useStore.getState();
  const pick = api.pickRunGroup;
  const review = api.reviewGroup;
  const drop = api.dropGroup;
  const calls: unknown[][] = [];
  const group = sampleGroup({ id: "g" });
  api.pickRunGroup = async (...args) => { calls.push(args); return { ...group, state: "picked", winner: "a" }; };
  api.reviewGroup = async (...args) => { calls.push(args); return { ...group, state: "reviewing" }; };
  api.dropGroup = async (...args) => { calls.push(args); return { ...group, state: "dropped" }; };
  try {
    useStore.getState().pickGroup(["repo"]);
    const selected = useStore.getState().selected;
    await useStore.getState().pickRunGroup("g", "a");
    expect(useStore.getState().landing[""]?.groups?.find(g => g.id === "g")?.winner).toBe("a");
    await useStore.getState().reviewGroup("g");
    await useStore.getState().dropGroup("g", ["b"]);
    expect(calls).toEqual([["g", "a"], ["g"], ["g", ["b"]]]);
    expect(useStore.getState().selected).toEqual(selected);
    expect(useStore.getState().landing[""]?.groups?.find(g => g.id === "g")?.state).toBe("dropped");
  } finally { api.pickRunGroup = pick; api.reviewGroup = review; api.dropGroup = drop; useStore.setState(state); }
});

import { enqueue } from "../../src/core/landing";
import { memberActions } from "./groups";
test("queue and judge holds preserve group action fences; approval never becomes plain land", () => {
  const group = sampleGroup({ state: "picked", winner: "a" });
  const entry = enqueue([], landingMember, 2);
  const queued = { ...empty, runs: [landingMember], entries: entry, groups: [group] };
  const column = memberColumns(group, queued, { "r-a": liveMember })[0];
  if (!column) throw new Error("missing member");
  expect(memberActions(group, column, queued)).toMatchObject({ land: false, fix: false, drop: false });
  expect(canPickMember(group, "a", queued)).toBe(false);
  expect(groupWaiting(group, queued)).toBe(false);
  const judge = { ...queued, entries: entry.map(e => ({ ...e, state: "judge" as const, reason: "judge unavailable" })) };
  expect(memberActions(group, column, judge).land).toBe(false);
  const record = { ...landingMember, review: { verdict: "approve" as const, files: [], base: "b", head: "h", at: 1 } };
  const info = { ...empty, runs: [record] };
  const approval = memberColumns(group, info, { "r-a": liveMember })[0];
  if (!approval) throw new Error("missing approval member");
  expect(memberActions(group, approval, info)).toMatchObject({ land: true, approve: true });
  expect(canPickMember({ ...group, scores: { a: { state: "ready", branch: "run/a", base: "b", gates: { ok: true }, scenarios: { total: 1, passed: 0, score: 0.5 } } } }, "a", info)).toBe(false);
});

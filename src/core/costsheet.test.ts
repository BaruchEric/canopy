import { expect, test } from "bun:test";
import type { HistoryOverview, HistorySession, Repo, RepoHistory } from "./types";
import type { RepoCard } from "./cards";
import { claudeByCard, claudeLeads, costSheet, sessionLines, tokensWord, usageWords, usdWord, type ServedRow } from "./costsheet";

const repo = (id: string): Repo => ({
  id,
  name: id.split(":").pop() ?? id,
  path: `/repo/${id}`,
  group: "",
  source: "launch",
  status: null,
});
const cards: RepoCard[] = [
  { key: "github.com/e/api", name: "api", checkouts: [repo("api"), repo("mini:api")] },
  { key: "github.com/e/web", name: "web", checkouts: [repo("web")] },
];

const hist = (days: number[]): RepoHistory => ({
  project: "fixture",
  sessions: days.length,
  costUsd: days.reduce((total, day) => total + day, 0),
  tokens: 0,
  commits: 0,
  first: null,
  last: null,
  days,
  daySessions: days.map(() => 1),
});
const history: HistoryOverview = {
  available: true,
  days: ["2026-10-18", "2026-10-19", "2026-10-20"],
  maxDay: 5,
  // the mini's archive maps the same sessions to its checkout
  repos: { api: hist([1, 2, 3]), "mini:api": hist([1, 2, 3]), web: hist([0, 0, 0.5]) },
  fetchedAt: 0,
};

const row = (over: Partial<ServedRow>): ServedRow => ({
  at: 1,
  service: "voice",
  provider: "openai",
  model: null,
  repo: null,
  repoName: null,
  run: null,
  label: null,
  session: null,
  usd: null,
  tokens: null,
  seconds: null,
  repoId: null,
  estUsd: null,
  backend: "mac",
  qid: null,
  ...over,
});

test("a card's Claude dollars are its largest checkout's, over the window", () => {
  expect(claudeByCard(history, 1, cards)).toEqual(new Map([["github.com/e/api", 3], ["github.com/e/web", 0.5]]));
  expect(claudeByCard(history, 30, cards).get("github.com/e/api")).toBe(6);
  expect(claudeByCard({ available: false, reason: "no index", fetchedAt: 0 }, 7, cards).size).toBe(0);
});

test("canopy's Claude rows sit on their runs but are not added to the archive's total", () => {
  const rows = [
    row({ service: "claude", provider: "anthropic", usd: 0.4, run: "r1", label: "chat", qid: "api", repoName: "api", at: 5 }),
    row({ service: "codex", provider: "openai", model: "gpt-6", tokens: { input: 900, cachedInput: 0, output: 100, reasoning: 0, total: 1000 }, estUsd: 0.25, run: "r2", label: "fix", qid: "web", at: 6 }),
    row({ service: "voice", provider: "elevenlabs", seconds: 120, run: "r1", label: "voice call", qid: "api", at: 7 }),
    row({ service: "speech", provider: "speech", seconds: 4, label: "dictation", at: 8 }),
  ];
  const sheet = costSheet(rows, history, 1, cards);
  expect(sheet.usd).toBeCloseTo(3.5);
  expect(sheet.est).toBeCloseTo(0.25);
  expect(sheet.unpriced).toBe(2);
  expect(sheet.services.map((l) => l.label)).toEqual(["Claude Code", "Codex · openai", "Voice · elevenlabs", "Dictation · speech"]);
  expect(sheet.services[0]?.detail).toContain("canopy's 1 reply: $0.40");
  expect(sheet.services[1]?.detail).toBe("gpt-6");
  expect(sheet.repos.map((l) => [l.label, l.usd, l.est, l.seconds])).toEqual([
    ["api", 3, 0, 120],
    ["web", 0.5, 0.25, 0],
    ["no repo", 0, 0, 4],
  ]);
  // the voice call made inside the chat lands on the chat's own line
  const chat = sheet.runs.find((l) => l.key === "mac:r1");
  expect(chat).toMatchObject({ label: "chat", usd: 0.4, seconds: 120, detail: "api · Claude Code + Voice" });
});

test("custom providers stay distinct in service and run usage lines", () => {
  const sheet = costSheet(
    [
      row({
        service: "codex",
        provider: "team_1",
        model: "gpt-custom",
        tokens: { input: 1000, cachedInput: 200, output: 100, reasoning: 0, total: 1100 },
        estUsd: 0.04,
        run: "r-custom",
        label: "review",
        qid: "api",
        agentSettings: { harness: "codex", model: "gpt-selected", effort: "high", provider: "team_1" },
        flowStep: { workflow: "release", step: "review", source: "user" },
      }),
    ],
    null,
    7,
    cards,
  );
  expect(sheet.services[0]).toMatchObject({ label: "Codex · team_1", detail: "gpt-custom", tokens: 1100, est: 0.04 });
  expect(sheet.runs[0]).toMatchObject({ label: "review", detail: "api · Codex · team_1 · gpt-custom · high effort · release / review", tokens: 1100, est: 0.04 });
});

test("Claude rows can keep archive dollars and canopy token usage together", () => {
  const sheet = costSheet(
    [row({ service: "claude", provider: "anthropic", tokens: { input: 100, cachedInput: 20, output: 10, reasoning: 0, total: 110 }, run: "r-claude", qid: "api" })],
    history,
    1,
    cards,
  );
  expect(sheet.services[0]).toMatchObject({ label: "Claude Code", usd: 3.5, tokens: 110 });
});

test("custom Claude provider usage is not added twice when its repo is in history", () => {
  const sheet = costSheet(
    [row({ service: "claude", provider: "bedrock", model: "claude-sonnet-5", usd: 0.25, run: "r-bedrock", qid: "api" })],
    history,
    1,
    cards,
  );
  expect(sheet.usd).toBeCloseTo(3.5);
  expect(sheet.services.map((line) => line.label)).toEqual(["Claude Code"]);
  expect(sheet.services[0]?.detail).toContain("across configured providers");
  expect(sheet.runs[0]).toMatchObject({ usd: 0.25, detail: "api · Claude Code · bedrock · claude-sonnet-5" });
  const withoutArchive = costSheet([row({ service: "claude", provider: "bedrock", usd: 0.25 })], null, 1, cards);
  expect(withoutArchive.usd).toBeCloseTo(0.25);
  expect(withoutArchive.services[0]?.label).toBe("Claude Code · bedrock");
});

test("a Claude row the archive has nothing for counts: a repo it does not map, or no repo here", () => {
  const quiet: HistoryOverview = { ...history, repos: { api: hist([0, 0, 2]) } };
  const rows = [
    row({ service: "claude", provider: "anthropic", usd: 0.3, run: "r1", qid: "api" }),
    row({ service: "claude", provider: "anthropic", usd: 0.5, run: "r2", qid: "web" }),
    row({ service: "claude", provider: "anthropic", usd: 0.25, run: "r3", repoName: "gone" }),
  ];
  const sheet = costSheet(rows, quiet, 1, cards);
  expect(sheet.services[0]?.usd).toBeCloseTo(2.75);
  expect(sheet.repos.map((l) => [l.label, l.usd])).toEqual([
    ["api", 2],
    ["web", 0.5],
    ["gone", 0.25],
  ]);
});

test("without the archive, Claude is canopy's own runs", () => {
  const rows = [row({ service: "claude", provider: "anthropic", usd: 0.4, run: "r1", qid: "api" })];
  const sheet = costSheet(rows, { available: false, reason: "down", fetchedAt: 0 }, 7, cards);
  expect(sheet.archive).toBe(false);
  expect(sheet.usd).toBeCloseTo(0.4);
  expect(sheet.repos[0]).toMatchObject({ label: "api", usd: 0.4 });
});

test("usageWords says tokens and minutes", () => {
  expect(usageWords({ tokens: 12_300, seconds: 252 }, (n) => `${n / 1000}k`)).toBe("12.3k tokens · 4.2 min");
  expect(usageWords({ tokens: 0, seconds: 20 }, String)).toBe("20 s");
});

test("the moved currency and token words keep their display format", () => {
  expect([usdWord(null), usdWord(12.345), usdWord(123.45)]).toEqual(["n/a", "$12.35", "$123"]);
  expect([tokensWord(123), tokensWord(1_234), tokensWord(1_234_567), tokensWord(1_234_567_890)]).toEqual(["123", "1.2k", "1.2M", "1.23B"]);
});

test("claudeLeads names each card's costliest checkout, the costliest card first", () => {
  expect(claudeLeads(history, 1, cards).map((l) => [l.name, l.id, l.usd])).toEqual([
    ["api", "api", 3],
    ["web", "web", 0.5],
  ]);
});

const session = (over: Partial<HistorySession>): HistorySession =>
  ({
    id: "s1-aaaa-bbbb",
    host: "mac",
    started_at: "2026-10-20T10:00:00Z",
    ended_at: "2026-10-20T11:00:00Z",
    title: null,
    first_prompt: "fix   the\nbuild",
    turns: 3,
    tool_calls: 0,
    tokens: 5000,
    cost: 1.5,
    subs: 0,
    commits: 0,
    source_present: 1,
    ...over,
  });

test("sessionLines keeps the sessions that began in the window, the costliest first", () => {
  const lead = { key: "github.com/e/api", name: "api", id: "api", usd: 3 };
  const lines = sessionLines(
    [
      {
        lead,
        sessions: [
          session({}),
          session({ id: "s2", title: "Ship the ledger", cost: 2, turns: 1 }),
          session({ id: "s3", started_at: "2026-10-18T10:00:00Z", cost: 9 }),
          session({ id: "s4", cost: 0 }),
        ],
      },
    ],
    Date.parse("2026-10-20T00:00:00Z"),
  );
  expect(lines.map((l) => [l.label, l.detail, l.usd])).toEqual([
    ["Ship the ledger", "api · mac · 1 turn", 2],
    ["fix the build", "api · mac · 3 turns", 1.5],
  ]);
});


test("a run line names its run and backend so the page can open its kept record", () => {
  const sheet = costSheet([row({ backend: "mini", run: "ab12cd34", label: "Build" })], null, 7, []);
  expect(sheet.runs[0]).toMatchObject({ key: "mini:ab12cd34", run: { backend: "mini", id: "ab12cd34" } });
  expect(sheet.services[0]).not.toHaveProperty("run");
  expect(sheet.repos[0]).not.toHaveProperty("run");
});

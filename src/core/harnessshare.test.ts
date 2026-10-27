import { describe, expect, test } from "bun:test";
import type { RepoCard } from "./cards";
import { HARNESS_SHARE_MAX, WEEKS, cardsOf, harnessNames, harnessShare, harnessWeeks, isHarnessCard, weekFrom, weekKey } from "./harnessshare";
import type { CostLine, CostSheet } from "./costsheet";
import type { HistoryOverview, Repo, RepoHistory } from "./types";

const repo = (id: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  name: id.split("|").pop() ?? id,
  path: `/dev/${id}`,
  group: "",
  source: "root",
  status: null,
  ...extra,
});

const canopy = repo("canopy", { harness: true });
const web = repo("web");
const canopyCard: RepoCard = {
  key: "github.com/e/canopy",
  name: "canopy",
  checkouts: [canopy, repo("mini|canopy")],
};
const webCard: RepoCard = {
  key: "github.com/e/web",
  name: "web",
  checkouts: [web],
};
const cards = [canopyCard, webCard];

const days = Array.from({ length: 18 }, (_, index) => `2026-10-${String(index + 10).padStart(2, "0")}`);
const between = (day: string, from: string, to: string): boolean => day >= from && day <= to;

function historyRow(spend: (day: string) => number, sessions: (day: string) => number): RepoHistory {
  const daily = days.map(spend);
  const daySessions = days.map(sessions);
  return {
    project: "fixture",
    sessions: daySessions.reduce((sum, count) => sum + count, 0),
    costUsd: daily.reduce((sum, amount) => sum + amount, 0),
    tokens: 0,
    commits: 0,
    first: null,
    last: null,
    days: daily,
    daySessions,
  };
}

const history: HistoryOverview = {
  available: true,
  days,
  maxDay: 3,
  fetchedAt: 0,
  repos: {
    canopy: historyRow(
      (day) => between(day, "2026-10-12", "2026-10-18") ? 1 : between(day, "2026-10-19", "2026-10-25") ? 3 : day === "2026-10-26" ? 2 : 0,
      (day) => day >= "2026-10-21" ? 2 : 0,
    ),
    // This checkout beats canopy on the Oct 12 week alone but is smaller
    // over the entire overview, so weekly sums use canopy for every week.
    "mini|canopy": historyRow(
      (day) => between(day, "2026-10-12", "2026-10-18") ? 2 : 0,
      () => 1,
    ),
    web: historyRow(
      (day) => day >= "2026-10-12" ? 1 : 0,
      () => 1,
    ),
  },
};

const costLine = (key: string, usd: number, est = 0): CostLine => ({
  key,
  label: key,
  detail: "",
  usd,
  est,
  tokens: 0,
  seconds: 0,
  unpriced: 0,
  at: 0,
});

const sheet: Pick<CostSheet, "repos"> = {
  repos: [
    costLine("github.com/e/canopy", 20, 1),
    costLine("github.com/e/web", 10),
    costLine("\u0000none", 0, 2),
    costLine("name:gone", 0.5),
  ],
};

test("share defaults match the product line", () => {
  expect([WEEKS, HARNESS_SHARE_MAX]).toEqual([8, 25]);
});

describe("harnessShare", () => {
  test("sums reported and estimated line dollars, and window sessions from each card's busiest checkout", () => {
    expect(harnessShare(sheet, history, 7, cards)).toEqual({
      usd: { harness: 21, rest: 12.5 },
      sessions: { harness: 14, rest: 7 },
      share: 21 / 33.5,
      sessionShare: 14 / 21,
    });
  });

  test("one marked checkout makes its entire card harness", () => {
    const markedOnMini: RepoCard = {
      ...canopyCard,
      checkouts: [repo("canopy"), repo("mini|canopy", { harness: true })],
    };
    expect(isHarnessCard(markedOnMini)).toBe(true);
    expect(harnessShare(sheet, history, 7, [markedOnMini, webCard]).usd).toEqual({ harness: 21, rest: 12.5 });
  });

  test("unmapped harness history keeps its dollars and has no sessions", () => {
    const devhub: RepoCard = {
      key: "rel:devhub",
      name: "devhub",
      checkouts: [repo("devhub", { harness: true })],
    };
    const unarchivedSheet: Pick<CostSheet, "repos"> = { repos: [costLine("rel:devhub", 3)] };
    expect(harnessShare(unarchivedSheet, history, 7, [devhub, webCard])).toEqual({
      usd: { harness: 3, rest: 0 },
      sessions: { harness: 0, rest: 7 },
      share: 1,
      sessionShare: 0,
    });
  });

  test("no spending or archive sessions has null shares", () => {
    expect(harnessShare({ repos: [] }, null, 7, cards)).toEqual({
      usd: { harness: 0, rest: 0 },
      sessions: { harness: 0, rest: 0 },
      share: null,
      sessionShare: null,
    });
  });
});

describe("harnessWeeks", () => {
  test("uses Monday boundaries, partial weeks, and one overview-leading checkout", () => {
    expect(harnessWeeks(history, cards)).toEqual([
      { from: "2026-10-05", harness: 0, rest: 0, share: null },
      { from: "2026-10-12", harness: 7, rest: 7, share: 0.5 },
      { from: "2026-10-19", harness: 21, rest: 7, share: 0.75 },
      { from: "2026-10-26", harness: 2, rest: 2, share: 0.5 },
    ]);
  });

  test("custom and default caps retain the newest weeks", () => {
    expect(harnessWeeks(history, cards, 3).map((week) => week.from)).toEqual([
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);

    const longDays = dateRange("2026-01-05", 70);
    const longHistory: HistoryOverview = {
      available: true,
      days: longDays,
      maxDay: 1,
      fetchedAt: 0,
      repos: { canopy: historyForDays(longDays, () => 1) },
    };
    const onlyHarness = { key: "canopy", name: "canopy", checkouts: [canopy] } satisfies RepoCard;
    const newest = harnessWeeks(longHistory, [onlyHarness]);
    expect(newest).toHaveLength(WEEKS);
    expect(newest[0]?.from).toBe("2026-01-19");
    expect(newest.at(-1)?.from).toBe("2026-03-09");
  });

  test("an absent or unavailable overview has no weeks", () => {
    expect(harnessWeeks(null, cards)).toEqual([]);
    expect(harnessWeeks({ available: false, reason: "down", fetchedAt: 0 }, cards)).toEqual([]);
  });
});

describe("week names and cards", () => {
  test("reads local Mondays and ISO week years across New Year", () => {
    expect(weekFrom("2026-10-10")).toBe("2026-10-05");
    expect(weekFrom("2026-10-26")).toBe("2026-10-26");
    expect(weekFrom("2026-11-01")).toBe("2026-10-26");
    expect(weekKey("2026-10-19")).toBe("2026-W43");
    expect(weekKey("2026-10-25")).toBe("2026-W43");
    expect(weekKey("2026-10-26")).toBe("2026-W44");
    expect(weekKey("2025-12-29")).toBe("2026-W01");
    expect(weekKey("2027-01-01")).toBe("2026-W53");
  });

  test("names marked cards and builds one card per backend repo", () => {
    expect(harnessNames(cards)).toEqual(["canopy"]);
    expect(cardsOf([canopy, web]).map((card) => [card.key, card.name, card.checkouts.length, isHarnessCard(card)])).toEqual([
      ["canopy", "canopy", 1, true],
      ["web", "web", 1, false],
    ]);
  });
});

function dateRange(start: string, count: number): string[] {
  const date = localDate(start);
  return Array.from({ length: count }, () => {
    const day = formatDay(date);
    date.setDate(date.getDate() + 1);
    return day;
  });
}

function localDate(day: string): Date {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

function formatDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function historyForDays(days: string[], spend: (day: string) => number): RepoHistory {
  const values = days.map(spend);
  return {
    project: "fixture",
    sessions: 0,
    costUsd: values.reduce((total, amount) => total + amount, 0),
    tokens: 0,
    commits: 0,
    first: null,
    last: null,
    days: values,
    daySessions: days.map(() => 0),
  };
}

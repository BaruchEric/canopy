import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Ask, HistoryOverview, Repo, RepoHistory } from "../../../src/core/types";
import { harnessNoticeOf, useStore } from "../store";
import { InboxPopBody } from "./Inbox";
import { WaitingBody } from "./Waiting";

const pristine = useStore.getState();

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

function setupNotice() {
  const days = Array.from({ length: 16 }, (_, index) => `2026-10-${String(index + 12).padStart(2, "0")}`);
  const weekly = (amount: number) => days.map((day) => (day >= "2026-10-19" && day <= "2026-10-25" ? amount / 7 : 0));
  const archive = (project: string, amounts: number[]): RepoHistory => ({
    project,
    sessions: 0,
    costUsd: amounts.reduce((sum, amount) => sum + amount, 0),
    tokens: 0,
    commits: 0,
    first: null,
    last: null,
    days: amounts,
    daySessions: amounts.map(() => 0),
  });
  const history: HistoryOverview = {
    available: true,
    days,
    maxDay: 1,
    fetchedAt: 1,
    repos: { canopy: archive("canopy", weekly(17)), web: archive("web", weekly(33)) },
  };
  const canopy: Repo = { id: "canopy", name: "canopy", path: "/dev/canopy", group: "", source: "launch", status: null, harness: true };
  const web: Repo = { id: "web", name: "web", path: "/dev/web", group: "", source: "launch", status: null };
  useStore.setState({ repos: [canopy, web], history, harnessSaid: null, asks: {}, asksReady: false, backendOrder: [pristine.home] });
}

const ask: Ask = {
  id: "a1",
  agent: "claude:s1",
  handle: "app-0123",
  node: "macmini-2018",
  kind: "permission",
  tool: "Bash",
  title: "Bash: ls",
  detail: JSON.stringify({ command: "ls" }),
  route: "remote",
  waitUntil: 160_000,
  state: "open",
  createdAt: 100_000,
};

describe("weekly harness line surfaces", () => {
  afterEach(() => {
    useStore.setState({ repos: pristine.repos, history: pristine.history, harnessSaid: pristine.harnessSaid, asks: pristine.asks, asksReady: pristine.asksReady, backendOrder: pristine.backendOrder, settings: pristine.settings, activeWs: pristine.activeWs, workspaces: pristine.workspaces, landing: pristine.landing });
  });

  test("the legacy inbox foot shows the quiet line without adding an ask", () => {
    setupNotice();
    expect(harnessNoticeOf(useStore.getState())).toMatchObject({ key: "2026-W43" });
    const html = renderCurrent(<InboxPopBody />);
    expect(html).toContain("last week 34% of Claude spend went into the harness (canopy)");
    expect(html).toContain("The inbox is empty");
  });

  test("the waiting panel shows it in its empty and regular branches", () => {
    setupNotice();
    expect(harnessNoticeOf(useStore.getState())).toMatchObject({ key: "2026-W43" });
    expect(renderCurrent(<WaitingBody />)).toContain("last week 34% of Claude spend went into the harness (canopy)");

    useStore.setState({ asks: { a1: ask }, asksReady: true });
    const html = renderCurrent(<WaitingBody />);
    expect(html).toContain("last week 34% of Claude spend went into the harness (canopy)");
    expect(html).toContain("asks and prompts");
  });
});

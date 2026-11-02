import { afterEach, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TriggerEvent } from "../../../src/core/trigger";
import type { Repo } from "../../../src/core/types";
import { kbKey, triggerKbId } from "../kbfocus";
import { useStore, type CanopyState } from "../store";
import { RepoGrid } from "./RepoGrid";
import { Sidebar } from "./Sidebar";
import { TriggersView } from "./Triggers";

const pristine = useStore.getState();
afterEach(() => useStore.setState(pristine));

const repo = (name: string): Repo => ({ id: `/dev/${name}`, name, path: `/dev/${name}`, group: "", source: "root", status: null });

const event = (id: string, title: string): TriggerEvent => ({
  id,
  rule: "shop",
  source: "sentry",
  key: `k-${id}`,
  title,
  note: "",
  repoId: "/dev/shop",
  workflow: "sentry-fix",
  status: "working",
  count: 1,
  firstAt: 1000,
  lastAt: 1000,
});

/** server rendering reads the store's initial state, so the state rides there for one render */
function render(state: Partial<CanopyState>, el: ReactElement): string {
  useStore.setState(state);
  const initial = useStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, useStore.getState());
  try {
    return renderToStaticMarkup(el);
  } finally {
    Object.assign(initial, previous);
  }
}

const ringed = (html: string): string[] => [...html.matchAll(/data-kb="([^"]+)"[^>]*data-kb-on=""/g)].map((m) => m[1] ?? "");

test("each trigger row carries its key, and only the ringed one wears the ring", () => {
  const key = kbKey("trigger", triggerKbId("mini", "e2"));
  const triggers = { mini: { rules: [], problems: [], events: [event("e1", "one"), event("e2", "two")], keeping: true } };
  const html = render({ home: "mini", backendOrder: ["mini"], triggers, kbFocus: key, kbRing: true }, <TriggersView />);
  expect(html).toContain(`data-kb="${kbKey("trigger", triggerKbId("mini", "e1"))}"`);
  expect(ringed(html)).toEqual([key]);
});

test("a hidden ring keeps its place but draws nothing", () => {
  const key = kbKey("trigger", triggerKbId("mini", "e1"));
  const triggers = { mini: { rules: [], problems: [], events: [event("e1", "one")], keeping: true } };
  const html = render({ home: "mini", backendOrder: ["mini"], triggers, kbFocus: key, kbRing: false }, <TriggersView />);
  expect(html).toContain(`data-kb="${key}"`);
  expect(ringed(html)).toEqual([]);
});

test("a tree row and its card carry one key, so one press rings both", () => {
  const state = { repos: [repo("shop"), repo("web")], kbFocus: kbKey("repo", "/dev/web"), kbRing: true };
  for (const el of [<Sidebar key="tree" />, <RepoGrid key="grid" />]) {
    const html = render(state, el);
    expect(html).toContain('data-kb="repo:/dev/shop"');
    expect(ringed(html)).toEqual(["repo:/dev/web"]);
  }
});

import { expect, test } from "bun:test";
import { normalizeRoutes, resolveAgent } from "./route";
import { DEFAULT_AGENT } from "./types";

const repo = "/dev/app";
const system = { ...DEFAULT_AGENT, model: "sonnet" };
const workflow = { ...DEFAULT_AGENT, model: "opus" };
const task = { ...DEFAULT_AGENT, model: "haiku" };

test("named workflow and task routes override repo defaults; repo-specific routes win", () => {
  const routes = normalizeRoutes({
    profiles: { default: system, deep: workflow, quick: task },
    roles: { flow: { profile: "quick" } },
    workflows: { ship: { profile: "deep" } },
    tasks: { ask: { profile: "quick" } },
    repos: { [repo]: { all: { profile: "default" }, workflows: { ship: { profile: "quick" } } } },
  });
  expect(resolveAgent(routes, repo, "flow", undefined, { kind: "workflow", name: "ship" })).toMatchObject({ settings: task, from: "repo-workflow" });
  expect(resolveAgent(routes, "/other", "flow", undefined, { kind: "workflow", name: "ship" })).toMatchObject({ settings: workflow, from: "workflow" });
  expect(resolveAgent(routes, repo, "job", undefined, { kind: "task", name: "ask" })).toMatchObject({ settings: task, from: "task" });
  expect(resolveAgent(routes, repo, "flow", { profile: "deep" }, { kind: "workflow", name: "ship" }).from).toBe("explicit");
  expect(resolveAgent(routes, repo, "flow", undefined, { kind: "workflow", name: "other" }).settings).toEqual(system);
  expect(resolveAgent(routes, repo, "job", undefined, { kind: "workflow", name: "ship" })).toMatchObject({ settings: task, from: "repo-workflow" });
  expect(resolveAgent(routes, repo, "job", undefined, { kind: "workflow", name: "other" })).toMatchObject({ settings: task, from: "task" });
});

test("missing scoped profiles fall through and report where they were skipped", () => {
  const routes = normalizeRoutes({ profiles: { default: system }, repos: {}, workflows: { ship: { profile: "gone" } } });
  expect(resolveAgent(routes, repo, "flow", undefined, { kind: "workflow", name: "ship" })).toMatchObject({
    settings: system, from: "default", skipped: [{ from: "workflow", profile: "gone" }],
  });
});

test("scope-only repo entries survive normalization and unsafe names are dropped", () => {
  const routes = normalizeRoutes({ profiles: {}, repos: { [repo]: { tasks: { ask: task } } }, workflows: { "../bad": task, ship: task } });
  expect(routes.repos[repo]).toEqual({ tasks: { ask: task } });
  expect(routes.workflows).toEqual({ ship: task });
});

test("commit suggestions keep the routed provider while using the client's default model and effort", () => {
  const routes = normalizeRoutes({ profiles: { default: { ...DEFAULT_AGENT, harness: "codex", model: "gpt-x", effort: "max", provider: "work" } }, repos: {} });
  const first = resolveAgent(routes, repo, "suggest").settings;
  expect(first).toMatchObject({ harness: "codex", model: "default", effort: "default", provider: "work" });
  expect(resolveAgent(routes, repo, "suggest").settings).toBe(first);
  const other = normalizeRoutes({ profiles: { default: { ...DEFAULT_AGENT, harness: "codex", provider: "personal" } }, repos: {} });
  expect(resolveAgent(other, repo, "suggest").settings.provider).toBe("personal");
});

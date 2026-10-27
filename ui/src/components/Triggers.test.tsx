import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseRules, type TriggerRuleInfo } from "../../../src/core/trigger";
import type { Repo } from "../../../src/core/types";
import { registry, setBase, setRegistry } from "../registry";
import { useStore } from "../store";
import { TriggersView } from "./Triggers";

const pristine = useStore.getState();
const originalRegistry = registry();
const repo = (id: string, name: string, over: Partial<Repo> = {}): Repo => ({ id, name, path: `/dev/${name}`, group: "", source: "root", status: null, ...over });

afterEach(() => {
  useStore.setState(pristine);
  setRegistry(originalRegistry.home, [...originalRegistry.names]);
  setBase("a", "");
  setBase("b", "");
});

function render(rule: TriggerRuleInfo): string {
  setRegistry("a", ["a", "b"]);
  setBase("b", "https://b.test");
  useStore.setState({
    home: "a", backendOrder: ["a", "b"],
    repos: [repo("home-only", "home-only"), repo("b|web/shop", "shop"), repo("b|remote", "remote", { host: "other" }), repo("b|broken", "broken", { error: "unreadable" }), repo("b|_incubator/seed", "seed")],
    triggers: { b: { rules: [rule], events: [], problems: [], keeping: true } },
  });
  const initial = useStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, useStore.getState());
  try { return renderToStaticMarkup(<TriggersView />); }
  finally { Object.assign(initial, previous); }
}

test("a foreign schedule card shows its clock and local choices, with no issue or hook controls", () => {
  const parsed = parseRules(JSON.stringify({ rules: [{ name: "weekly", source: "schedule", cron: "0 5 * * 1", repo: "*", workflow: "spec-converge", only: ["spec-adopted"] }] })).rules[0];
  if (!parsed) throw new Error("invalid schedule fixture");
  const html = render({ ...parsed, secretSet: true, tokenSet: false, agentSet: false, next: Date.now() + 86_400_000, skips: [{ repo: "shop", why: "last run still going", at: 1 }], problem: "another repo requires manual mode" });
  expect(html).toContain("every local repo with a spec");
  expect(html).toContain("0 5 * * 1");
  expect(html).toContain("never fired");
  expect(html).toContain("lands through the queue");
  expect(html).toContain("skipped shop: last run still going");
  expect(html).toContain('aria-label="Which repo to fire"');
  expect(html).toContain('value="b|web/shop"');
  expect(html).not.toContain('<option value="home-only"');
  expect(html).not.toContain('<option value="b|remote"');
  expect(html).not.toContain('<option value="b|broken"');
  expect(html).not.toContain('<option value="b|_incubator/seed"');
  expect(html).not.toContain("Issue title");
  expect(html).not.toContain("secret set");
  expect(html).not.toContain("on label");
  expect(html).not.toContain("writes back");
  expect(html).not.toContain("leaves issues open");
  expect(html).not.toContain("/api/hooks/");
  expect(html).toContain("fire now");
  expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).not.toContain("disabled");
});

test("an issue rule keeps its hook, secret and test-issue controls with its backend's repo name", () => {
  const parsed = parseRules(JSON.stringify({ rules: [{ name: "tracker", source: "github", repo: "web/shop", workflow: "issue-fix", labels: ["canopy"], secretEnv: "CANOPY_TRIGGER_TEST_HOOK" }] })).rules[0];
  if (!parsed) throw new Error("invalid issue fixture");
  const html = render({ ...parsed, hook: "/api/hooks/github/tracker", secretSet: true, tokenSet: false, agentSet: false });
  expect(html).toContain("github → shop");
  expect(html).toContain("on label canopy");
  expect(html).toContain("secret set");
  expect(html).toContain("https://b.test/api/hooks/github/tracker");
  expect(html).toContain("Issue title for a test fire");
  expect(html).toContain("try it");
  expect(html).not.toContain("Which repo to fire");
  expect(html).not.toContain("never fired");
});

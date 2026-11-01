import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BranchTree, Repo } from "../../../src/core/types";
import { registry, setRegistry } from "../registry";
import { useStore } from "../store";
import { TreesChip, TreesSection } from "./Trees";

const pristine = useStore.getState();
const originalRegistry = registry();
const repo: Repo = { id: "b|a", name: "a", path: "/b/a", group: "", source: "b|root", status: null };
const tree = (over: Partial<BranchTree> = {}): BranchTree => ({
  slug: "feat-x",
  dir: "/t/a-abc/feat-x",
  branch: "feat/x",
  base: "main",
  port: 7912,
  madeAt: 0,
  caches: true,
  state: "ready",
  head: "abc1234",
  ahead: 0,
  behind: 0,
  files: 0,
  at: Date.now() - 2 * 3600000,
  shells: 0,
  ...over,
});

afterEach(() => {
  useStore.setState(pristine, true);
  setRegistry(originalRegistry.home, [...originalRegistry.names]);
});

function render(trees: BranchTree[], what: "section" | "chip" = "section"): string {
  setRegistry("a", ["a", "b"]);
  useStore.setState({ home: "a", backendOrder: ["a", "b"], closedSections: {}, trees: { b: { root: "/t", ports: "7900-7949", repos: [{ repoId: repo.id, repoPath: repo.path, trees }] } } });
  const initial = useStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, useStore.getState());
  try { return renderToStaticMarkup(what === "section" ? <TreesSection repo={repo} /> : <TreesChip repoId={repo.id} />); }
  finally { Object.assign(initial, previous); }
}

test("a repo's kept trees render a row each with the branch, its words and the tools", () => {
  const html = render([tree({ ahead: 2, files: 1, shells: 1 })]);
  expect(html).toContain('aria-label="Worktrees"');
  expect(html).toContain("1 tree");
  expect(html).toContain('class="landing-row trees-row"');
  expect(html).toContain('title="/t/a-abc/feat-x"');
  expect(html).toContain("feat/x");
  expect(html).toContain("↑2 ●1 :7912 1 shell");
  expect(html).toContain(" · 2h");
  expect(html).toContain(">shell<");
  expect(html).toContain(">changes<");
  expect(html).toContain(">remove<");
  expect(html).toContain("+ worktree");
  expect(html).not.toContain("remove anyway");
});

test("a failed tree turns rust and keeps the reason as text; a preparing one lichen", () => {
  const html = render([tree({ state: "failed", why: "bun install <exited> 1", at: undefined }), tree({ slug: "b", branch: "b", state: "preparing" })]);
  expect(html).toContain("2 trees, 1 preparing, 1 failed");
  expect(html).toContain('class="landing-row trees-row rust"');
  expect(html).toContain('class="landing-row trees-row lichen"');
  expect(html).toContain('class="trees-why">bun install &lt;exited&gt; 1<');
});

test("a repo with no tree still shows the section with its form button, and no chip", () => {
  const html = render([]);
  expect(html).toContain("none kept");
  expect(html).toContain("+ worktree");
  expect(html).not.toContain("trees-row");
  expect(render([], "chip")).toBe("");
});

test("the chip counts the trees and names each in its title", () => {
  const html = render([tree(), tree({ slug: "fix", branch: "fix", files: 3, port: null })], "chip");
  expect(html).toContain("⑂ 2 trees");
  expect(html).toContain('title="feat/x  clean :7912\nfix  ●3"');
  expect(html).toContain('class="run-chip trees-card"');
  expect(render([tree({ state: "failed" })], "chip")).toContain('class="run-chip trees-card rust"');
});

test("a repo on another host, or a forge's, has no section", () => {
  setRegistry("a", ["a", "b"]);
  useStore.setState({ home: "a", backendOrder: ["a", "b"] });
  expect(renderToStaticMarkup(<TreesSection repo={{ ...repo, host: "gpd" }} />)).toBe("");
  expect(renderToStaticMarkup(<TreesSection repo={{ ...repo, forge: { kind: "forgejo", slug: "eric/a", clone: "ssh://git@git.example/eric/a.git", branch: "main", updated: 0, private: false, empty: false } }} />)).toBe("");
});

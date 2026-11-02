import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BranchTree, Repo } from "../../../src/core/types";
import { registry, setRegistry } from "../registry";
import { useStore } from "../store";
import { CARD_TREES, TreeRows, TreesChip, TreesSection } from "./Trees";

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

function render(trees: BranchTree[], what: "section" | "chip" | "rows" | "rows-selecting" = "section"): string {
  setRegistry("a", ["a", "b"]);
  useStore.setState({ home: "a", backendOrder: ["a", "b"], closedSections: {}, trees: { b: { root: "/t", ports: "7900-7949", repos: [{ repoId: repo.id, repoPath: repo.path, trees }] } } });
  const initial = useStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, useStore.getState());
  const el =
    what === "section" ? <TreesSection repo={repo} />
    : what === "chip" ? <TreesChip repoId={repo.id} />
    : <TreeRows repo={repo} selecting={what === "rows-selecting"} />;
  try { return renderToStaticMarkup(el); }
  finally { Object.assign(initial, previous); }
}

test("a card's rows name each tree with its words and age, a shell into it, and open the section", () => {
  const html = render([tree({ ahead: 2, files: 1 }), tree({ slug: "b", branch: "fix/b", state: "preparing", at: undefined })], "rows");
  expect(html).toContain('class="card-trees" role="group" aria-label="Worktrees kept for a"');
  expect(html).toMatch(/<button[^>]*class="card-tree-name"[^>]*>⑂ feat\/x<\/button>/);
  expect(html).toContain('class="card-tree-words">↑2 ●1 :7912 · 2h<');
  expect(html).toContain('class="card-tree lichen"');
  expect(html).toContain('class="card-tree-words">preparing :7912<');
  expect(html).toContain('title="A shell in /t/a-abc/feat-x"');
  expect(html).not.toContain("more");
});

test("a tree with a card of its own gets open in the section, and the card row's name opens that panel", () => {
  const card: Repo = { id: "b|trees:a-abc/feat-x", name: "a ⑂ feat/x", path: "/t/a-abc/feat-x", group: "", source: "trees", status: null };
  useStore.setState({ repos: [card] });
  const section = render([tree()]);
  expect(section).toContain(">open</button>");
  const rows = render([tree()], "rows");
  expect(rows).toContain("open its own panel");
  useStore.setState({ repos: [] });
  expect(render([tree()])).not.toContain(">open<");
  expect(render([tree()], "rows")).toContain("the worktrees section");
});

test("a card's rows stop at the cap and count the rest; select mode makes them inert", () => {
  const many = Array.from({ length: CARD_TREES + 2 }, (_, i) => tree({ slug: `t${i}`, branch: `t${i}` }));
  const html = render(many, "rows");
  expect(html.match(/class="card-tree-name"/g)).toHaveLength(CARD_TREES);
  expect(html).toMatch(/<button[^>]*class="card-tree-more"[^>]*>2 more<\/button>/);
  const inert = render(many, "rows-selecting");
  expect(inert).not.toContain("<button");
  expect(inert).toContain('<span class="card-tree-name">⑂ t0</span>');
  expect(inert).toContain('<span class="card-tree-more">2 more</span>');
  expect(render([], "rows")).toBe("");
});

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

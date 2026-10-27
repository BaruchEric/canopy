import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LandingRun, Repo, WorktreeRepoInfo } from "../../../src/core/types";
import { registry, setRegistry } from "../registry";
import { useStore } from "../store";
import { LandingSection } from "./Landing";

const pristine = useStore.getState();
const originalRegistry = registry();
const repo: Repo = { id: "b|a", name: "a", path: "/b/a", group: "", source: "b|root", status: null };
const pool = (over: Partial<WorktreeRepoInfo> = {}): WorktreeRepoInfo => ({ repoId: repo.id, repoPath: repo.path, want: 1, runs: [], warm: [], refilling: null, fails: [], orphans: [], ...over });
const tree = { dir: "/w/warm-1", name: "warm-1", base: "base", madeAt: Date.now() - 2 * 3600000, size: 312 * 1048576, lockfile: null };

afterEach(() => {
  useStore.setState(pristine, true);
  setRegistry(originalRegistry.home, [...originalRegistry.names]);
});

function render(r: WorktreeRepoInfo): string {
  setRegistry("a", ["a", "b"]);
  useStore.setState({ home: "a", backendOrder: ["a", "b"], closedSections: {}, worktrees: { b: { root: "/w", free: 1, repos: [r] } } });
  const initial = useStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, useStore.getState());
  try { return renderToStaticMarkup(<LandingSection repo={repo} />); }
  finally { Object.assign(initial, previous); }
}

test("a foreign repo with only warm trees shows the section and its existing row styles", () => {
  const html = render(pool({ warm: [tree] }));
  expect(html).toContain('aria-label="Landing"');
  expect(html).toContain("1 warm");
  expect(html).toContain('class="landing-list landing-warm"');
  expect(html).toContain('class="landing-row"');
  expect(html).toContain("warm-1");
  expect(html).toContain('class="dim">2h · 312 MB');
  expect(html).not.toContain("queue anyway");
  expect(html).not.toContain("orphaned worktree");
});

test("machine warm off hides the section even when the gates file defaults to two", () => {
  expect(render(pool({ want: 0, fileWarm: 2 }))).toBe("");
});

test("refill failures get rust and preserve the reason as text", () => {
  const html = render(pool({ fails: [{ name: "warm-1", why: "setup <failed>", at: 1, fails: 2 }] }));
  expect(html).toContain("0 of 1 warm, refill failed");
  expect(html).toContain('class="landing-row rust"');
  expect(html).toContain("refill failed: setup &lt;failed&gt;");
});

test("warm words join the queue's head and leave group, collision and judge rows available", () => {
  const rec: LandingRun = { id: "b|run", runId: "b|r", repoId: repo.id, repoPath: repo.path, branch: "run/queued", target: "main", base: "base", dir: "/w/run", note: "queued work", verb: "Ask", harness: "claude", state: "ready", startedAt: 1 };
  useStore.setState({ landing: { b: {
    runs: [rec], orphans: [],
    entries: [{ id: rec.id, repoId: repo.id, repoPath: repo.path, branch: rec.branch, target: "main", dir: rec.dir, note: rec.note, state: "judge", tries: 1, queuedAt: 1, updatedAt: 1 }],
    groups: [{ id: "b|g", repoId: repo.id, repoPath: repo.path, action: "ask", note: "group work", expectedMembers: 2, members: [{ run: "b|member", origin: "b|origin", profile: null }], state: "working", autoLand: false, startedAt: 1 }],
    collisions: [{ id: "b|collision", repoId: repo.id, run: rec.runId, name: "run/queued", with: { kind: "checkout" }, paths: ["same.ts"], at: 1 }],
  } } });
  const html = render(pool({ want: 2, warm: [tree], refilling: "warm-2" }));
  expect(html).toContain("1 group · 1 queued");
  expect(html).toContain(" · 1 of 2 warm, refilling");
  expect(html).toContain("best of 2: group work");
  expect(html).toContain("same.ts");
  expect(html).toContain("land anyway");
  expect(html).toContain("warm-2");
  expect(html).toContain("refilling");
});


test("a landing branch whose live run is absent remains a button to its kept record", () => {
  const record: LandingRun = { id: "b|origin", runId: "b|old", repoId: repo.id, repoPath: repo.path, branch: "run/kept", target: "main", base: "base", dir: "/w/old", note: "old work", verb: "Ask", harness: "claude", state: "ready", startedAt: 1 };
  useStore.setState({ runs: {}, landing: { b: { runs: [record], entries: [], orphans: [] } } });
  const html = render(pool());
  expect(html).toMatch(/<button[^>]*class="landing-branch landing-open"[^>]*>run\/kept<\/button>/);
  expect(html).toContain("one a restart took opens from its kept record");
});


test("a retained landing entry without a valid run ID renders branch text without a dead run button", () => {
  for (const runId of [undefined, "", "b|"]) {
    const record: LandingRun = { id: "b|origin", runId: runId ?? "b|old", repoId: repo.id, repoPath: repo.path, branch: "run/retained", target: "main", base: "base", dir: "/w/old", note: "old work", verb: "Ask", harness: "claude", state: "ready", startedAt: 1 };
    useStore.setState({ runs: {}, landing: { b: { runs: runId === undefined ? [] : [record], entries: [{ id: record.id, repoId: repo.id, repoPath: repo.path, branch: record.branch, target: "main", dir: record.dir, note: record.note, state: "queued", tries: 0, queuedAt: 1, updatedAt: 1 }], orphans: [] } } });
    const html = render(pool());
    expect(html).toContain("run/retained");
    expect(html).not.toMatch(/<button[^>]*class="landing-branch landing-open"/);
  }
});

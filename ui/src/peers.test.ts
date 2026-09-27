import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { LAUNCH_SOURCE, type PeerState, type Repo, type Run } from "../../src/core/types";
import { mergeAction, peerable, peerChips, peerLines, peerWipCounts, seenWord } from "./peers";

const repo = (over: Partial<Repo> = {}): Repo => ({
  id: "app",
  name: "app",
  path: "/root/app",
  group: "app",
  source: LAUNCH_SOURCE,
  status: null,
  ...over,
});

// ago() reads Date.now() itself, so every "ago" word here needs the system
// clock pinned to the same instant the fixtures' "at" fields are measured
// against.
const now = 1_790_000_000_000;
const base: PeerState = { moved: [], diverged: [], wip: [], peerOnly: [], onlyHere: false, at: now };

beforeEach(() => setSystemTime(now));
afterEach(() => setSystemTime());

describe("peerable", () => {
  test("a local checkout under the launch root, readable and not on a forge", () => {
    expect(peerable(repo())).toBe(true);
  });
  test("another backend's launch root counts too", () => {
    expect(peerable(repo({ id: "mac|app", source: `mac|${LAUNCH_SOURCE}` }))).toBe(true);
  });
  test("everything else stays out", () => {
    expect(peerable(repo({ source: "extra" }))).toBe(false);
    expect(peerable(repo({ host: "gpd" }))).toBe(false);
    expect(peerable(repo({ forge: { kind: "forgejo", slug: "a/b", clone: "x", branch: "main", updated: 0, private: false, empty: false } }))).toBe(false);
    expect(peerable(repo({ error: "not a repo" }))).toBe(false);
  });
});

describe("peerChips", () => {
  test("nothing to say, no chips", () => {
    expect(peerChips(undefined)).toEqual([]);
    expect(peerChips(base)).toEqual([]);
  });

  test("diverged, WIP and only-here", () => {
    const st: PeerState = {
      ...base,
      diverged: [{ branch: "main", peer: "mini", ahead: 3, behind: 2 }],
      wip: [{ peer: "mac", branch: "main", at: now - 12 * 60_000, parent: "p", hash: "h", files: 4 }],
    };
    expect(peerChips(st)).toEqual([
      { kind: "diverged", text: "⇅ mini ↑2 ↓3", title: "main diverged from mini: 2 commits here, 3 there" },
      { kind: "wip", text: "WIP on mac/main 12m ago", title: "mac has 4 uncommitted files on main, 12m ago" },
    ]);
    expect(peerChips({ ...base, onlyHere: true })).toEqual([
      { kind: "only", text: "only here", title: "no peer has this repo" },
    ]);
  });
});

describe("peerWipCounts", () => {
  test("nothing without a WIP", () => {
    expect(peerWipCounts(undefined)).toEqual([]);
    expect(peerWipCounts(base)).toEqual([]);
  });
  test("one entry per peer, files summed across its branches", () => {
    const st: PeerState = {
      ...base,
      wip: [
        { peer: "mac", branch: "main", at: now, parent: "p", hash: "h1", files: 1 },
        { peer: "mac", branch: "feat", at: now, parent: "p", hash: "h2", files: 3 },
        { peer: "nb", branch: "main", at: now, parent: "p", hash: "h3", files: 1 },
      ],
    };
    expect(peerWipCounts(st)).toEqual([
      { peer: "mac", text: "mac 4", title: "mac has 4 uncommitted files on main, feat" },
      { peer: "nb", text: "nb 1", title: "nb has 1 uncommitted file on main" },
    ]);
  });
});

describe("seenWord", () => {
  test("ok carries an age; offline does not, since its `at` is the failed attempt", () => {
    expect(seenWord({ name: "mini", ok: true, at: now - 3 * 60_000 })).toBe("mini · 3m ago");
    expect(seenWord({ name: "gpd", ok: false, at: now - 6 * 86_400_000 })).toBe("gpd · offline");
  });
});

const run = (status: Run["status"]): Run => ({
  id: "r1",
  repoId: "app",
  action: "chat",
  verb: "chat",
  progress: "chatting",
  expectsChange: false,
  chat: true,
  note: "",
  status,
  startedAt: now,
  steps: [],
  prompt: null,
});

describe("mergeAction", () => {
  test("no active run: start fresh", () => {
    expect(mergeAction(undefined)).toBe("new");
  });
  test("an idle chat between turns: say into it", () => {
    expect(mergeAction(run("idle"))).toBe("say");
  });
  test("a run genuinely in progress: refuse", () => {
    expect(mergeAction(run("working"))).toBe("busy");
    expect(mergeAction(run("waiting"))).toBe("busy");
  });
});

describe("peerLines", () => {
  test("moves, new divergence and new WIP; nothing repeated", () => {
    const next: PeerState = {
      ...base,
      moved: [{ branch: "main", from: "a", to: "bbbbbbbbbb", peer: "mini" }],
      diverged: [{ branch: "feat", peer: "gpd", ahead: 1, behind: 1 }],
      wip: [{ peer: "mac", branch: "main", at: now, parent: "p", hash: "h", files: 2 }],
    };
    expect(peerLines(undefined, next)).toEqual([
      "main fast-forwarded to bbbbbbbb from mini",
      "feat diverged from gpd",
      "WIP from mac on main (2 files)",
    ]);
    expect(peerLines(next, { ...next, moved: [] })).toEqual([]);
  });
});

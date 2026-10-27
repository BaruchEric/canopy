import { describe, expect, test } from "bun:test";
import type { Run } from "../../src/core/types";
import type { InboxItem } from "./inbox";
import { QUIET, snapshot, titled, transitions, watch, type SnapshotInput } from "./notify";
import type { FailedRow, TurnRow } from "./waiting";

const run = (id: string, status: Run["status"]): Run => ({
  id,
  repoId: "r",
  action: "fix the tests",
  verb: "fixing",
  progress: "",
  expectsChange: false,
  chat: false,
  harness: "claude",
  note: "",
  status,
  startedAt: 1,
  steps: [],
  prompt: null,
});

const ask = (id: string): InboxItem => ({
  key: `ask:${id}`,
  source: "ask",
  id,
  kind: "permission",
  repoId: "r",
  repo: "canopy",
  who: "@claude",
  where: "mac",
  title: "run   bun test",
  detail: "",
  at: 1,
  left: null,
  until: null,
});

const chat = (id: string): TurnRow => ({ kind: "chat", id, repoId: "r", what: "done, over to you", at: 1 });
const failed = (id: string): FailedRow => ({ kind: "run", id, repoId: "r", what: "fix the tests", at: 1 });

const input = (p: Partial<SnapshotInput>): SnapshotInput => ({ turns: [], inbox: [], failed: [], runs: [], ...p });
const nameOf = (id: string) => (id === "r" ? "canopy" : "");
const snap = (p: Partial<SnapshotInput>) => snapshot(input(p), nameOf);

describe("transitions", () => {
  test("a new waiting item is told, one already there is not", () => {
    const notes = transitions(snap({ inbox: [ask("a")] }), snap({ inbox: [ask("a"), ask("b")], turns: [chat("c")] }));
    expect(notes.map((n) => n.key)).toEqual(["inbox:ask:b", "turn:chat:c"]);
    expect(notes[0]).toEqual({ key: "inbox:ask:b", title: "Waiting on you · canopy", body: "run bun test", repoId: "r" });
    expect(notes[1]?.title).toBe("Your turn · canopy");
  });
  test("a run going working to done is told; one already done, or stopped, is not", () => {
    const prev = snap({ runs: [run("1", "working"), run("2", "done"), run("3", "working")] });
    const next = snap({ runs: [run("1", "done"), run("2", "done"), run("3", "stopped")] });
    expect(transitions(prev, next)).toEqual([{ key: "done:1", title: "Done · canopy", body: "fix the tests", repoId: "r" }]);
  });
  test("a run that failed is told once, through its failed row", () => {
    const prev = snap({ runs: [run("1", "working")] });
    const next = snap({ runs: [run("1", "failed")], failed: [failed("1")] });
    expect(transitions(prev, next).map((n) => n.key)).toEqual(["failed:run:1"]);
  });
  test("an item that went and came back is news again", () => {
    const a = snap({ turns: [chat("c")] });
    const b = snap({});
    expect(transitions(a, b)).toEqual([]);
    expect(transitions(b, a).map((n) => n.key)).toEqual(["turn:chat:c"]);
  });
});

describe("watch: the burst guard", () => {
  const old = snap({ inbox: [ask("a")], turns: [chat("c")], failed: [failed("f")] });
  const more = snap({ inbox: [ask("a"), ask("b")], turns: [chat("c")], failed: [failed("f")] });

  test("the first full state only seeds", () => {
    const r = watch(null, old, "1|home=online", 0);
    expect(r.notes).toEqual([]);
    expect(r.watch.snap).toBe(old);
  });
  test("a backend connecting, or a stream resyncing, re-seeds and fires nothing", () => {
    const first = watch(null, snap({}), "0|home=offline", 0).watch;
    // the page loads: everything old arrives with the connection
    const loaded = watch(first, old, "1|home=online", QUIET * 5);
    expect(loaded.notes).toEqual([]);
    // the wholesale reads that follow inside the window are not news either
    const reads = watch(loaded.watch, more, "1|home=online", QUIET * 5 + 1000);
    expect(reads.notes).toEqual([]);
    // a drop and resync: offline, then online with whatever the gap brought
    const lost = watch(reads.watch, more, "1|home=offline", QUIET * 10);
    const back = watch(lost.watch, snap({ inbox: [ask("a"), ask("b"), ask("z")] }), "1|home=online", QUIET * 10 + 50);
    expect(lost.notes).toEqual([]);
    expect(back.notes).toEqual([]);
    // a second backend coming up does the same
    const mini = watch(back.watch, snap({ inbox: [ask("m")] }), "1|home=online|mini=online", QUIET * 20);
    expect(mini.notes).toEqual([]);
  });
  test("after the quiet window an incremental change fires", () => {
    const seeded = watch(null, old, "1|home=online", 0).watch;
    const r = watch(seeded, more, "1|home=online", QUIET);
    expect(r.notes.map((n) => n.key)).toEqual(["inbox:ask:b"]);
    // and the same state again is quiet
    expect(watch(r.watch, more, "1|home=online", QUIET + 1).notes).toEqual([]);
  });
});

describe("titled", () => {
  test("a count goes in front, none leaves the title alone", () => {
    expect(titled("canopy", 3)).toBe("(3) canopy");
    expect(titled("api · shell · canopy", 1)).toBe("(1) api · shell · canopy");
    expect(titled("canopy", 0)).toBe("canopy");
  });
});

test("a picked group is one ordinary waiting transition with a group sheet target", () => {
  const before = snapshot({ turns: [], inbox: [], failed: [], runs: [] }, () => "repo");
  const picked = snapshot({ turns: [{ kind: "group", id: "remote|g", repoId: "remote|r", what: "best of 2: repair", at: 1 }], inbox: [], failed: [], runs: [] }, () => "repo");
  expect(transitions(before, picked)).toEqual([{ key: "turn:group:remote|g", title: "Your turn · repo", body: "best of 2: repair", repoId: "remote|r", groupId: "remote|g" }]);
  expect(transitions(picked, picked)).toEqual([]);
});

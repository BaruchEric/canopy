import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PASS_FAILED } from "../core/prscenarios";
import type { PrState, PrWatch } from "../core/types";
import { PrScenarios, type PassChange } from "./prscenarios";
import { setDirOf } from "./scenarios";

let root = "";
let n = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-prscen-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const cmd = (name: string, run: string) => `---\nname: ${name}\nkind: command\nrun: ${run}\n---\n`;
const state = (head: string): PrState => ({ number: 7, url: "", status: "open", draft: false, head, additions: 1, deletions: 0, files: 1, checks: [{ name: "test", state: "pass" }], review: "none", mergeable: "MERGEABLE", mergeState: "CLEAN" });

/** A gate over a repo of its own, with a set when `files` says, a runner
 *  that answers by line (waiting on `wait` first when set), and the watch
 *  as each pass's end leaves it. */
async function rig(files: Record<string, string> = {}, opts: { settings?: string } = {}) {
  const repoPath = join(root, `repo${++n}`);
  await mkdir(join(repoPath, ".canopy"), { recursive: true });
  if (opts.settings !== undefined) await writeFile(join(repoPath, ".canopy", "scenarios.json"), opts.settings);
  const scen = join(root, `scen${n}`);
  if (Object.keys(files).length > 0) {
    await mkdir(setDirOf(scen, repoPath), { recursive: true });
    for (const [f, text] of Object.entries(files)) await writeFile(join(setDirOf(scen, repoPath), f), text);
  }
  const calls: { cwd: string; line: string }[] = [];
  const answers: Record<string, { exit: number; output: string }> = {};
  const r = { wait: null as Promise<void> | null, throws: false };
  let w: PrWatch = { id: `b${n}`, runId: "r1", repoId: "repo", repoPath, branch: "run/x", target: "main", dir: join(root, `wt${n}`), note: "", slug: "o/r", remote: "origin", number: 7, url: "", autoFix: false, autoMerge: true, pushed: "h1", attempts: {}, seenComment: 0, openedAt: 1, updatedAt: 1 };
  const gate = new PrScenarios(
    () => ({
      root: scen,
      judge: null,
      run: async (cwd, line) => {
        calls.push({ cwd, line });
        if (r.wait) await r.wait;
        if (r.throws) throw new Error(`spawn ${scen}/secret-folder failed`);
        return answers[line] ?? { exit: 0, output: "" };
      },
    }),
    () => 50,
    async (_id, change: PassChange) => {
      w = change(w);
    },
  );
  return {
    gate,
    calls,
    answers,
    r,
    get w() {
      return w;
    },
    set w(v: PrWatch) {
      w = v;
    },
    /** one gate over the watch as it is, which the hub would save */
    async read(head: string): Promise<PrWatch> {
      w = await gate.gate(w, state(head));
      return w;
    },
  };
}

test("a repo with no set may go at once, and a running mark no pass stands behind is dropped", async () => {
  const t = await rig();
  t.w = { ...t.w, checking: { head: "h1", since: 1 } };
  expect(await t.read("h1")).not.toHaveProperty("checking");
  expect(t.calls).toEqual([]);
});

test("a pass runs once per head: running, then kept, then the next head runs again", async () => {
  const t = await rig({ "checkout.md": cmd("checkout", "e2e checkout") });
  let release!: () => void;
  t.r.wait = new Promise((res) => (release = res));
  expect((await t.read("h1")).checking).toEqual({ head: "h1", since: 50 });
  // a read while it goes waits on it and runs nothing more
  expect((await t.read("h1")).checking).toEqual({ head: "h1", since: 50 });
  release();
  await t.gate.idle();
  expect(t.calls).toEqual([{ cwd: t.w.dir, line: "e2e checkout" }]);
  expect(t.w.checking).toBeUndefined();
  expect(t.w.scenarios).toMatchObject({ head: "h1", total: 1, passed: 1, score: 1 });
  expect(t.w.approve).toBeUndefined();
  // kept by head: the next read may go and runs nothing
  t.r.wait = null;
  const again = await t.read("h1");
  expect([again.checking, again.approve, t.calls.length]).toEqual([undefined, undefined, 1]);
  // a new head is a new pass
  expect((await t.read("h2")).checking?.head).toBe("h2");
  await t.gate.idle();
  expect([t.w.scenarios?.head, t.calls.length]).toEqual(["h2", 2]);
});

test("a pass going on a head the PR moved past holds the new head until it ends", async () => {
  const t = await rig({ "checkout.md": cmd("checkout", "e2e checkout") });
  let release!: () => void;
  t.r.wait = new Promise((res) => (release = res));
  await t.read("h1");
  expect((await t.read("h2")).checking?.head).toBe("h2");
  release();
  await t.gate.idle();
  expect(t.calls).toHaveLength(1);
  // the old head's pass is kept, holding nothing on the new one
  expect([t.w.scenarios?.head, t.w.checking]).toEqual(["h1", undefined]);
  t.r.wait = null;
  expect((await t.read("h2")).checking?.head).toBe("h2");
  await t.gate.idle();
  expect([t.w.scenarios?.head, t.calls.length]).toEqual(["h2", 2]);
});

test("a red pass holds the head by the scenario's name; read again, it holds without running", async () => {
  const t = await rig({ "checkout.md": cmd("checkout", "e2e checkout") });
  t.answers["e2e checkout"] = { exit: 1, output: "no receipt" };
  await t.read("h1");
  await t.gate.idle();
  expect(t.w.approve).toEqual({ head: "h1", why: "scenario checkout failed", by: "scenarios" });
  expect(t.w.scenarios?.results).toEqual([{ name: "checkout", kind: "command", ok: false, tail: "no receipt" }]);
  // the hub never gates a held head again, but should it, the pass kept still holds
  const { approve: _a, ...lost } = t.w;
  t.w = lost;
  expect((await t.read("h1")).approve?.why).toBe("scenario checkout failed");
  expect(t.calls).toHaveLength(1);
});

test("a broken .canopy/scenarios.json holds with its own words; a pass that throws holds with fixed ones", async () => {
  const bad = await rig({ "checkout.md": cmd("checkout", "e2e checkout") }, { settings: '{"timeout": 99999}' });
  expect((await bad.read("h1")).approve).toEqual({ head: "h1", why: `${PASS_FAILED}: .canopy/scenarios.json: timeout must be at most 1800 seconds`, by: "scenarios" });
  expect(bad.calls).toEqual([]);
  const t = await rig({ "checkout.md": cmd("checkout", "e2e checkout") });
  t.r.throws = true;
  const said = console.error;
  console.error = () => {};
  try {
    await t.read("h1");
    await t.gate.idle();
  } finally {
    console.error = said;
  }
  // the thrown words name the set's folder, which a watch never shows
  expect(t.w.approve).toEqual({ head: "h1", why: PASS_FAILED, by: "scenarios" });
  expect(JSON.stringify(t.w)).not.toContain("secret-folder");
});

test("a judge scenario with no judge holds the head, and its story never reaches the watch", async () => {
  const t = await rig({ "refund.md": "---\nname: refund\nkind: judge\n---\nThe customer reads WHY-THE-REFUND-WENT in one line.\n" });
  await t.read("h1");
  await t.gate.idle();
  expect(t.w.approve).toEqual({ head: "h1", why: "scenario refund needs a judge: no gateway key", by: "scenarios" });
  expect(JSON.stringify(t.w)).not.toContain("WHY-THE-REFUND-WENT");
});

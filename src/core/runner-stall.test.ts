import { describe, expect, test } from "bun:test";
import { ACTIONS } from "./actions";
import type { DriveCtx, RunDriver } from "./driver";
import { Runner } from "./runner";
import { STALL_AFTER, stallStopNote, WRAP_UP_NOTE, wrapUpMessage } from "./stall";
import { DEFAULT_AGENT, type Repo, type Run } from "./types";

const repo: Repo = { id: "api", name: "api", path: "/r/api", group: "", source: "root", status: null };

/** A driver that starts, says one thing, and takes nudges; a stop ends its
 *  process the way a kill does. `nudge: false` is a harness that takes no
 *  message mid-turn, `holding` one waiting on a background subagent. */
function fake(opts: { nudge?: boolean; holding?: () => boolean; tool?: boolean } = {}) {
  const nudged: string[] = [];
  let ctx: DriveCtx | null = null;
  const driver: RunDriver = {
    harness: "claude",
    label: "Claude Code",
    check: () => null,
    start: (c) => {
      ctx = c;
      if (opts.tool) c.step({ kind: "tool", tool: { name: "Bash", title: "bun test", status: "running" } });
      else c.step({ kind: "text", text: "looking" });
      c.changed();
    },
    say: () => {},
    stop: () => queueMicrotask(() => ctx?.exited({ code: null, stderr: "" })),
    ...(opts.nudge === false ? {} : { nudge: (text: string) => (nudged.push(text), true) }),
    ...(opts.holding ? { holding: opts.holding } : {}),
  };
  return { driver, nudged };
}

function start(d: RunDriver, action: "ask" | "chat" = "ask", stage = false): { runner: Runner; run: Run } {
  const runner = new Runner({ onChange: () => {}, onGone: () => {} }, { driver: () => d, stage: () => stage });
  const run = runner.start(repo, action, ACTIONS[action], "fix the thing", DEFAULT_AGENT);
  return { runner, run };
}

const later = (ms = STALL_AFTER + 1000) => Date.now() + ms;

describe("the stall watchdog in the Runner", () => {
  test("quiet past STALL_AFTER with no tool open: one wrap-up message and its note, still working", () => {
    const f = fake();
    const { runner, run } = start(f.driver);
    expect(runner.watchdog(later(STALL_AFTER - 60_000))).toEqual([]);
    expect(f.nudged).toEqual([]);
    expect(runner.watchdog(later())).toEqual([]);
    expect(f.nudged).toEqual([wrapUpMessage()]);
    expect(run.steps.at(-1)).toMatchObject({ kind: "note", text: WRAP_UP_NOTE });
    expect(run.stall?.warned).toBeGreaterThan(0);
    expect(run.status).toBe("working");
    // the note moved the clock: the next look a minute on finds it heard from
    expect(runner.watchdog(Date.now() + 60_000)).toEqual([]);
    expect(f.nudged).toHaveLength(1);
  });

  test("an open tool call is not quiet, however long", () => {
    const f = fake({ tool: true });
    const { runner, run } = start(f.driver);
    expect(runner.watchdog(later(10 * STALL_AFTER))).toEqual([]);
    expect(f.nudged).toEqual([]);
    expect(run.stall).toBeUndefined();
  });

  test("quiet again after the wrap-up: stopped, with the stall marked and said", async () => {
    const f = fake();
    const { runner, run } = start(f.driver);
    runner.watchdog(later());
    const stopped = runner.watchdog(later());
    expect(stopped.map((r) => r.id)).toEqual([run.id]);
    expect(run.stall?.stopped).toBeGreaterThan(0);
    expect(run.steps.some((s) => s.kind === "note" && s.text === stallStopNote())).toBe(true);
    await runner.whenEnded(run.id);
    expect(run.status).toBe("stopped");
    // a stopped run is never looked at again
    expect(runner.watchdog(later(5 * STALL_AFTER))).toEqual([]);
  });

  test("a harness that takes no message mid-turn gets the note alone, then the stop", () => {
    const f = fake({ nudge: false });
    const { runner, run } = start(f.driver);
    expect(runner.watchdog(later())).toEqual([]);
    expect(run.steps.at(-1)?.text).toContain("Claude Code takes no message mid-turn");
    expect(runner.watchdog(later())).toHaveLength(1);
  });

  test("never watched: a chat, an incubator stage's run, a run holding for a subagent", () => {
    const chat = fake();
    // a chat that opened with words is working on its first reply
    const c = start(chat.driver, "chat");
    expect(c.run.status).toBe("working");
    expect(c.runner.watchdog(later(10 * STALL_AFTER))).toEqual([]);
    expect(chat.nudged).toEqual([]);

    const stage = fake();
    const s = start(stage.driver, "ask", true);
    expect(s.runner.watchdog(later(10 * STALL_AFTER))).toEqual([]);
    expect(stage.nudged).toEqual([]);

    let holding = true;
    const held = fake({ holding: () => holding });
    const h = start(held.driver);
    expect(h.runner.watchdog(later())).toEqual([]);
    expect(held.nudged).toEqual([]);
    holding = false;
    h.runner.watchdog(later());
    expect(held.nudged).toHaveLength(1);
  });

  test("whenEnded is null for a run the runner never had", () => {
    const { runner } = start(fake().driver);
    expect(runner.whenEnded("nope")).toBeNull();
  });
});

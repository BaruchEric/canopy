/**
 * A message in a Linear agent session carries its trigger event on with a
 * run on the event's branch (the trigger hub's `followUp`, as the server
 * wires it), and never as a second writer beside one already working
 * there. Real HTTP and git; the agent is a driver that runs nothing, and
 * Linear is never called: the rule's app secret is unset, so its sessions
 * hear nothing.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveCtx, RunDriver } from "../core/driver";
import { exec } from "../core/exec";
import type { TriggerEvent } from "../core/trigger";
import { isRunActive, type Harness, type Run } from "../core/types";
import { startServer } from "./index";

const HOOK = "lin-hook-secret";

/** a driver that keeps its run working until it is stopped */
class Holder implements RunDriver {
  readonly label = "Claude Code";
  ctx: DriveCtx | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx): void {
    this.ctx = ctx;
  }
  say(): void {}
  stop(): void {
    this.ctx?.exited({ code: 0, stderr: "" });
  }
}

let scratch = "";
let previous: string | undefined;
let previousTmux: string | undefined;
let server: Awaited<ReturnType<typeof startServer>>;
const made: Holder[] = [];

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const post = (p: string, body: unknown) => fetch(url(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const runs = async (): Promise<Run[]> => (await (await fetch(url("/api/runs"))).json()) as Run[];
const theEvent = async (): Promise<TriggerEvent | undefined> => ((await (await fetch(url("/api/triggers"))).json()) as { events: TriggerEvent[] }).events.find((e) => e.session === "ses-1");
/** the runs working on a branch */
const writersOn = async (origin: string): Promise<string[]> => (await runs()).filter((r) => r.branch?.origin === origin && isRunActive(r)).map((r) => r.id);
/** a delivery from the session, signed with the rule's hook secret */
const session = (fields: Record<string, unknown>) => {
  const body = JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp: Date.now(), ...fields });
  return fetch(url("/api/hooks/linear/lin"), { method: "POST", body, headers: { "linear-signature": createHmac("sha256", HOOK).update(body).digest("hex") } });
};
const message = (text: string) => session({ action: "prompted", agentSession: { id: "ses-1" }, agentActivity: { body: text } });
/** Waits out the hub's queue: a stop of an event that is not there queues
 *  behind every change asked for before it, the message's follow-up too. */
const settled = async () => expect((await post("/api/triggers/stop", { id: "nope" })).status).toBe(404);

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const begun = Date.now();
  for (;;) {
    const got = await read();
    if (got) return got;
    if (Date.now() - begun > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(20);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-trigger-followup-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  previousTmux = process.env["CANOPY_TMUX"];
  const config = join(scratch, "config");
  process.env["CANOPY_CONFIG_DIR"] = config;
  process.env["CANOPY_TMUX"] = "0";
  const app = join(scratch, "root", "app");
  await mkdir(app, { recursive: true });
  await exec(["git", "init", "-q", "-b", "main", app]);
  await exec(["git", "-C", app, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"]);
  await mkdir(join(config, "workflows"), { recursive: true });
  await writeFile(join(config, "workflows", "fix-it.md"), "---\nblurb: fix it\n---\n\n## Work\nmode: auto\ntools: read\n\nFix the issue.\n");
  // the agent is on (clientId), but its secret is unset, so no token is minted
  await writeFile(join(config, "triggers.json"), JSON.stringify({ rules: [{ name: "lin", source: "linear", repo: "app", workflow: "fix-it", secretEnv: "CANOPY_TRIGGER_LIN_HOOK", clientId: "cid", clientSecretEnv: "CANOPY_TRIGGER_LIN_APP" }] }));
  process.env["CANOPY_TRIGGER_LIN_HOOK"] = HOOK;
  server = await startServer({
    root: join(scratch, "root"),
    port: 0,
    chan: null,
    harnesses: ["claude"],
    incubator: { autostart: false, transcribe: null, notes: null, ship: null, stage: null },
    runner: {
      driver: (h) => {
        const d = new Holder(h);
        made.push(d);
        return d;
      },
    },
  });
});

afterAll(async () => {
  for (const r of await runs()) if (isRunActive(r)) await post("/api/runs/stop", { id: r.id });
  await server.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  if (previousTmux === undefined) delete process.env["CANOPY_TMUX"];
  else process.env["CANOPY_TMUX"] = previousTmux;
  await rm(scratch, { recursive: true, force: true });
});

test("a message while Eric's follow-up works on the event's branch starts nothing; once it ends, a message carries the event on", async () => {
  const created = await session({ action: "created", agentSession: { id: "ses-1", issue: { id: "iss-9", identifier: "ENG-9", title: "Fix the sync badge", team: { key: "ENG" } } } });
  expect(await created.json()).toEqual({ kind: "accepted" });
  const working = await until(async () => {
    const e = await theEvent();
    return e?.status === "working" && e.runId && e.branch ? e : null;
  }, "the event's run to start");
  const origin = working.branch ?? "";
  expect((await post("/api/runs/stop", { id: working.runId })).status).toBe(200);
  await until(async () => (await theEvent())?.status === "stopped", "the event to read stopped");
  // Eric's own follow-up on the branch, from the landing row
  const followed = await post("/api/landing/followup", { id: origin, note: "rename the flag" });
  expect(followed.status).toBe(201);
  const his = ((await followed.json()) as { run: Run }).run;
  const drivers = made.length;
  expect(await (await message("also the tooltip")).json()).toEqual({ kind: "accepted" });
  await settled();
  expect(made.length).toBe(drivers);
  expect(await writersOn(origin)).toEqual([his.id]);
  expect(await theEvent()).toMatchObject({ status: "stopped", runId: working.runId });
  // his run ends: the next message carries the event on, on the same branch
  expect((await post("/api/runs/stop", { id: his.id })).status).toBe(200);
  await until(async () => (await writersOn(origin)).length === 0, "his run to end");
  expect(await (await message("also the tooltip")).json()).toEqual({ kind: "accepted" });
  await settled();
  const carried = await until(async () => {
    const e = await theEvent();
    return e?.status === "working" && e.runId !== working.runId ? e : null;
  }, "the event to follow the run that carries it on");
  expect(made.length).toBe(drivers + 1);
  expect(await writersOn(origin)).toEqual([carried.runId ?? ""]);
}, 30_000);

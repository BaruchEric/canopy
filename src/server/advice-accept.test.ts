/**
 * Accepting a retro lesson on a real server, with no stand-in for the
 * accept: the chat opens idle on canopy's own checkout with the lesson as a
 * draft for the user to read and send, nothing runs until they do, and the
 * agent then starts with yolo off and no extra flags though the route says
 * otherwise. A repo with a run going refuses with 409 and keeps the lesson.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { DriveCtx, RunDriver } from "../core/driver";
import type { AdviceAccepted, AdviceOffer, Harness, Run } from "../core/types";
import { startServer } from "./index";

/** what each run's driver was started with */
const agents: { yolo: boolean; extra: string; cwd: string; message: string }[] = [];

/** a harness that never finishes on its own; a stop ends it */
class HoldingDriver implements RunDriver {
  readonly label = "Claude Code";
  private ctx: DriveCtx | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx, message: string): void {
    this.ctx = ctx;
    agents.push({ yolo: ctx.agent.yolo, extra: ctx.agent.extra, cwd: ctx.cwd, message });
  }
  say(): void {}
  stop(): void {
    this.ctx?.exited({ code: null, stderr: "" });
  }
}

let scratch: string;
let root: string;
let previous: string | undefined;
let server: { port: number; stop: () => void };
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const postJson = (path: string, body: unknown) =>
  fetch(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-accept-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  const config = join(scratch, "config");
  process.env["CANOPY_CONFIG_DIR"] = config;
  root = join(scratch, "root");
  // canopy's checkout, found by a remote naming the homepage's repo
  const checkout = join(root, "canopy");
  await mkdir(checkout, { recursive: true });
  await Bun.$`git -C ${checkout} init -q && git -C ${checkout} remote add origin git@github.com:BaruchEric/canopy.git`.quiet();
  // a default profile that would bypass permissions twice over
  await mkdir(join(config, "incubator"), { recursive: true });
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({ profiles: { default: { harness: "claude", model: "default", effort: "default", yolo: true, extra: "--dangerously-skip-permissions" } } }),
  );
  const from = [{ id: "sp_000000000001", title: "Coin counter", at: 1 }];
  await writeFile(
    join(config, "incubator", "improvements.json"),
    JSON.stringify({
      entries: {
        "clarify-asks-less": { key: "clarify-asks-less", lesson: "Clarify asked what the brief said.", file: "clarify", edit: "Read brief.md first.", from },
        "scout-reads-npm": { key: "scout-reads-npm", lesson: "Scout should read npm.", from },
      },
    }),
  );
  const tmp = await realpath(tmpdir());
  if (!(await realpath(config)).startsWith(tmp + sep)) throw new Error(`CANOPY_CONFIG_DIR is not under ${tmp}`);
  server = await startServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    incubator: { autostart: false, transcribe: null, notes: null, ship: null, stage: null },
    runner: { driver: (h) => new HoldingDriver(h) },
  });
});

afterAll(async () => {
  server.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("an accepted lesson opens an idle chat with a draft; sent, it runs with yolo off and no extra flags; a busy repo refuses", async () => {
  const res = await postJson("/api/incubator/advice", { key: "clarify-asks-less", accept: true });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { advice: AdviceOffer[]; accepted?: AdviceAccepted };
  const a = body.accepted;
  if (a?.kind !== "chat") throw new Error(`expected a chat, got ${JSON.stringify(a)}`);
  expect(a.repoId).toBe("canopy");
  expect(a.run?.status).toBe("idle");
  expect(a.run?.steps).toEqual([]);
  expect(a.draft).toContain("Clarify asked what the brief said.");
  expect(a.draft).toContain("Read brief.md first.");
  expect(a.draft).toContain(join("lib", "workflows", "clarify.md"));
  // nothing runs until the user sends the draft
  await Bun.sleep(200);
  expect(agents).toHaveLength(0);
  expect(body.advice.map((o) => o.key)).toEqual(["scout-reads-npm"]);

  const said = await postJson("/api/runs/say", { id: a.runId, text: a.draft });
  expect(said.status).toBe(200);
  await until(() => agents.length > 0, "the chat's agent to start");
  expect(agents[0]).toMatchObject({ yolo: false, extra: "" });
  expect(agents[0]?.cwd).toBe(join(await realpath(root), "canopy"));

  // the chat is going: another lesson cannot open one, and stays on offer
  const busy = await postJson("/api/incubator/advice", { key: "scout-reads-npm", accept: true });
  expect(busy.status).toBe(409);
  const offers = (await (await fetch(url("/api/incubator/advice"))).json()) as AdviceOffer[];
  expect(offers.map((o) => o.key)).toEqual(["scout-reads-npm"]);

  const stopped = (await (await postJson("/api/runs/stop", { id: a.runId })).json()) as Run;
  expect(stopped.id).toBe(a.runId);
}, 60_000);

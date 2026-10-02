/**
 * The incubator on a real server with autostart on and a stand-in agent:
 * every clarify run starts with permissions asked, never bypassed, though
 * the default route says yolo (fresh, and again after a restart reruns the
 * flow), and a server stopping mid-clarify parks nothing.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { DriveCtx, RunDriver } from "../core/driver";
import type { Harness, Sprout } from "../core/types";
import { startServer } from "./index";

/** what each run's driver was started with */
const agents: { yolo: boolean; cwd: string }[] = [];

/** a harness that never finishes on its own; a stop ends it */
class HoldingDriver implements RunDriver {
  readonly label = "Claude Code";
  private ctx: DriveCtx | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx): void {
    this.ctx = ctx;
    agents.push({ yolo: ctx.agent.yolo, cwd: ctx.cwd });
  }
  say(): void {}
  stop(): void {
    this.ctx?.exited({ code: null, stderr: "" });
  }
}

let scratch: string;
let root: string;
let previous: string | undefined;

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

async function server(): Promise<{ port: number; stop: () => void }> {
  const dir = process.env["CANOPY_CONFIG_DIR"];
  if (!dir) throw new Error("CANOPY_CONFIG_DIR is not set; refusing to start a server on the real config");
  await mkdir(dir, { recursive: true });
  const tmp = await realpath(tmpdir());
  if (!(await realpath(dir)).startsWith(tmp + sep)) throw new Error(`CANOPY_CONFIG_DIR is not under ${tmp}: ${dir}`);
  return startServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    incubator: { autostart: true, transcribe: null, notes: null },
    runner: { driver: (h) => new HoldingDriver(h) },
  });
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-incrun-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("clarify runs with yolo off, fresh and after a restart, and a stop parks nothing", async () => {
  const first = await server();
  let second: { port: number; stop: () => void } | null = null;
  try {
    const f = new FormData();
    f.append("text", "A tally for the coin machines");
    const res = await fetch(`http://127.0.0.1:${first.port}/api/incubator`, { method: "POST", body: f });
    expect(res.status).toBe(201);
    const s = (await res.json()) as Sprout;
    await until(() => agents.length > 0, "clarify's run to start");
    expect(agents[0]?.yolo).toBe(false);
    expect(agents[0]?.cwd).toContain(join("_incubator", s.slug));
    const record = join(process.env["CANOPY_CONFIG_DIR"] ?? "", "incubator", s.id, "sprout.json");
    await until(async () => ((JSON.parse(await readFile(record, "utf8")) as Sprout).status === "clarifying"), "the record to say clarifying");

    // a redeploy: the flows end as the server stops, and the sprout is left as it was
    first.stop();
    await Bun.sleep(300);
    const after = JSON.parse(await readFile(record, "utf8")) as Sprout;
    expect(after.status).toBe("clarifying");
    expect(after.parked).toBeUndefined();

    // the next server takes the flow back and reruns its step, still with yolo off
    second = await server();
    await until(() => agents.length > 1, "the restored flow's run");
    expect(agents[1]?.yolo).toBe(false);
    expect(agents[1]?.cwd).toContain(join("_incubator", s.slug));
  } finally {
    second?.stop();
  }
}, 60_000);

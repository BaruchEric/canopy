/**
 * One server owns the flows folder: a second canopy on the same config dir
 * and root (another port) neither takes the first one's flows back nor
 * writes over their records.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowFile } from "../core/flowstore";
import { killServer, tmuxBase } from "../core/tmux";
import type { Flow } from "../core/types";
import { parseWorkflow } from "../core/workflow";
import { startServer } from "./index";

const e = parseWorkflow(`---\nname: two\nverb: do two\nblurb: b\n---\n\n## First\ngate: ask\n\nOne.\n\n## Second\n\nTwo.\n`, {
  name: "two",
  source: "bundled",
  file: "/two.md",
});
if (!e.ok) throw new Error(e.error);
const TWO = e.workflow;

let scratch: string;
let previous: string | undefined;
let root: string;
let flowsDir: string;
const servers: { port: number; stop: () => void }[] = [];

const flowsOn = async (port: number): Promise<Flow[]> => (await (await fetch(`http://127.0.0.1:${port}/api/flows`)).json()) as Flow[];
async function folder(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(flowsDir)).sort()) out[name] = await readFile(join(flowsDir, name), "utf8");
  return out;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-flows-lock-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  flowsDir = join(scratch, "config", "flows");
  await mkdir(flowsDir, { recursive: true });
  await mkdir(join(scratch, "root"));
  root = await realpath(join(scratch, "root"));
  await mkdir(join(root, "app"));
  await Bun.$`git -C ${join(root, "app")} init -q`.quiet();
  const rec: FlowFile = {
    v: 1,
    before: "",
    savedAt: 0,
    workflow: TWO,
    repoPath: join(root, "app"),
    root,
    flow: {
      id: "abcdef01",
      repoId: "app",
      workflow: "two",
      verb: "do two",
      note: "",
      status: "gated",
      steps: [
        { name: "First", status: "gated", reason: "this step asks before the next one starts" },
        { name: "Second", status: "pending" },
      ],
      current: 0,
      startedAt: 0,
    },
  };
  await writeFile(join(flowsDir, "abcdef01.json"), JSON.stringify(rec));
});

afterAll(async () => {
  for (const s of servers) s.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("a second server on the same config dir leaves the first one's flows and records alone", async () => {
  const first = await startServer({ root, port: 0, harnesses: ["claude"] });
  servers.push(first);
  expect((await flowsOn(first.port)).map((f) => f.id)).toEqual(["abcdef01"]);
  const before = await folder();
  const logged: string[] = [];
  const log = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  let second: { port: number; stop: () => void };
  try {
    second = await startServer({ root, port: 0, harnesses: ["claude"] });
  } finally {
    log.mockRestore();
  }
  servers.push(second);
  expect(second.port).not.toBe(first.port);
  expect(await flowsOn(second.port)).toEqual([]);
  expect(logged.some((l) => l.includes(`canopy pid ${process.pid} keeps the records`))).toBe(true);
  second.stop();
  await Bun.sleep(100);
  expect(await folder()).toEqual(before);
});

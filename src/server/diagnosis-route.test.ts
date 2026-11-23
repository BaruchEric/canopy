/**
 * `/api/repos/diagnosis` on a real server (FR-075): the read says none, a
 * run starts canopy's own copy of Archify's Code Analysis in the background
 * and answers 202, a second waits on it, the read then holds the counts,
 * the page comes back as sandboxed text, a remove takes the folder, and bad
 * acts and languages refuse. No model and no agent run.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosisInfo } from "../core/diagnosis";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let app = "";
let server: { port: number; stop: () => void };
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const post = (body: unknown) => fetch(url("/api/repos/diagnosis?id=app"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async () => (await (await fetch(url("/api/repos/diagnosis?id=app"))).json()) as DiagnosisInfo;
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;

/** reads until the analysis ends */
async function ended(): Promise<DiagnosisInfo> {
  for (let i = 0; i < 600; i++) {
    const info = await read();
    if (info.running === null) return info;
    await Bun.sleep(100);
  }
  throw new Error("the analysis never ended");
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-diagnosis-route-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  app = join(root, "app");
  mkdirSync(join(app, "src"), { recursive: true });
  writeFileSync(join(app, "src", "a.ts"), 'import { b } from "./b";\nexport const a = (n: number): number => (n > 0 ? b(n - 1) : 0);\n');
  writeFileSync(join(app, "src", "b.ts"), 'import { a } from "./a";\nexport const b = (n: number): number => (n > 0 ? a(n - 1) : 1);\n');
  await Bun.$`git -C ${app} init -q && git -C ${app} add -A && git -C ${app} -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q -m init`.quiet();
  app = await realpath(app);
  server = await startServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    incubator: { autostart: false, transcribe: null, notes: null, ship: null, stage: null },
  });
});

afterAll(async () => {
  server.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("a run analyzes in the background; the read holds the counts; the page is sandboxed text; a remove takes it", async () => {
  expect(await read()).toEqual({ report: null, running: null, failed: null, settings: { language: null, exclude: [] } });
  expect((await fetch(url("/api/repos/diagnosis?id=app&page=1"))).status).toBe(400);

  const bad = await post({ act: "analyze" });
  expect(bad.status).toBe(400);
  expect(await errorOf(bad)).toBe("act is run or remove");
  const cobol = await post({ act: "run", language: "cobol" });
  expect(cobol.status).toBe(400);
  expect(await errorOf(cobol)).toContain("language is auto or one of ts, py");
  expect((await post({ act: "remove" })).status).toBe(400);

  const started = await post({ act: "run" });
  expect(started.status).toBe(202);
  const { running } = (await started.json()) as { running: number };
  expect((await read()).running).toBe(running);
  // one at a time: a second run and a remove wait on the first
  expect((await post({ act: "run", language: "ts" })).status).toBe(409);
  expect((await post({ act: "remove" })).status).toBe(409);

  const info = await ended();
  expect(info.failed).toBeNull();
  expect(info.report?.facts).toMatchObject({ language: "ts", files: 2 });
  expect(info.report?.facts?.leads.some((l) => l.code === "coupling/import-cycle")).toBe(true);

  const page = await fetch(url("/api/repos/diagnosis?id=app&page=1"));
  expect(page.status).toBe(200);
  // text and a sandbox: this address never runs the page at canopy's origin
  expect(page.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(page.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(await page.text()).toContain("Code Analysis");

  const removed = await post({ act: "remove" });
  expect(removed.status).toBe(200);
  expect(existsSync(join(app, ".archify", "diagnosis"))).toBe(false);
  expect((await read()).report).toBeNull();
  expect((await fetch(url("/api/repos/diagnosis?id=app"), { method: "DELETE" })).status).toBe(405);
}, 120_000);

test("a repo the backend does not scan is a 404", async () => {
  expect((await fetch(url("/api/repos/diagnosis?id=nope"))).status).toBe(404);
});

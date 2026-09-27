import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index";

let scratch: string;
let server: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};
const backends = [{ name: "mini", public: "https://canopy.beric.ca" }];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-backends-"));
  for (const k of ["CANOPY_CONFIG_DIR", "CANOPY_TMUX"]) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CANOPY_TMUX"] = "0";
  await mkdir(join(scratch, "config"), { recursive: true });
  await writeFile(join(scratch, "config", "config.json"), JSON.stringify({ self: "mac", backends: [...backends, { name: "bad" }] }));
  await mkdir(join(scratch, "root"), { recursive: true });
  server = await startServer({ root: join(scratch, "root"), port: 0, chan: null });
});

afterAll(async () => {
  server.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

test("GET /api/backends names this backend and the valid entries", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/backends`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ self: "mac", backends });
});

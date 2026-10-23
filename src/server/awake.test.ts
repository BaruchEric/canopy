/**
 * Keep awake's routes against a real server on a scratch config dir. A test
 * server never arms the hold, so "always" is saved and reported but nothing
 * is spawned (core/awake.test.ts covers the hold itself).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/store";
import type { AwakeInfo } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let server: { port: number; stop: () => Promise<void> };

const api = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (body: unknown) => fetch(api("/api/awake"), { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-awake-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  await mkdir(root, { recursive: true });
  server = await startServer({ root, port: 0, harnesses: ["claude"] });
});

afterAll(async () => {
  await server.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

describe("/api/awake", () => {
  test("off by default, holding nothing", async () => {
    const info = (await (await fetch(api("/api/awake"))).json()) as AwakeInfo;
    expect(info).toMatchObject({ mode: "off", holding: false, working: 0 });
  });

  test("a mode is saved to the config and answered whole; a test server still holds nothing", async () => {
    const res = await post({ mode: "always" });
    expect(res.status).toBe(200);
    expect((await res.json()) as AwakeInfo).toMatchObject({ mode: "always", holding: false });
    expect((await loadConfig()).awake).toBe("always");
    expect(((await (await fetch(api("/api/awake"))).json()) as AwakeInfo).mode).toBe("always");
  });

  test("a mode it does not know is refused", async () => {
    const res = await post({ mode: "sometimes" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("mode must be one of off, always, working");
  });
});

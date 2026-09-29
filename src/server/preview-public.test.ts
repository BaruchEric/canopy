/**
 * The ports route tells the panel the backend's public preview names, so a
 * page on canopy's public https address can frame a preview.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PortsResult } from "../core/types";
import { startServer } from "./index";

let scratch: string;
const saved: Record<string, string | undefined> = {};
let server: { port: number; stop: () => void };
const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_PREVIEW_PORTS", "CANOPY_PREVIEW_PUBLIC"];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-pubprev-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const slot = 30000 + Math.floor(Math.random() * 20000);
  process.env["CANOPY_PREVIEW_PORTS"] = `${slot}-${slot + 1}`;
  process.env["CANOPY_PREVIEW_PUBLIC"] = "https://canopy-p{slot}.example.com/";
  const root = join(scratch, "root");
  await Bun.$`mkdir -p ${root}`.quiet();
  server = await startServer({ root, port: 0 });
});

afterAll(async () => {
  server.stop();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(scratch, { recursive: true, force: true });
});

test("the ports route names the public preview template", async () => {
  const r = (await (await fetch(`http://127.0.0.1:${server.port}/api/ports`)).json()) as PortsResult;
  expect(r.public).toBe("https://canopy-p{slot}.example.com");
});

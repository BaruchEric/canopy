/**
 * A picture taken in the preview's design mode (FR-029) lands beside the
 * pasted images under the config dir, named for the repo's agent to read,
 * and anything but an image of a known local repo is refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index";

let scratch: string;
let server: { port: number; stop: () => void };
let saved: string | undefined;
const clip = (type: string, body: Uint8Array, id = "app") =>
  fetch(`http://127.0.0.1:${server.port}/api/repos/clip?id=${id}`, { method: "POST", headers: { "content-type": type }, body });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-clip-"));
  saved = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} && git -C ${join(root, "app")} init -q`.quiet();
  server = await startServer({ root, port: 0 });
});

afterAll(async () => {
  server.stop();
  if (saved === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = saved;
  await rm(scratch, { recursive: true, force: true });
});

describe("a design-mode picture", () => {
  test("is saved under pastes/ and answered with its path", async () => {
    const res = await clip("image/png", png);
    expect(res.status).toBe(201);
    const { path, text } = (await res.json()) as { path: string; text: string };
    expect(path.startsWith(join(scratch, "config", "pastes", "design-"))).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(text).toBe(path);
    expect([...new Uint8Array(await Bun.file(path).arrayBuffer())]).toEqual([...png]);
  });

  test("refuses what is not an image, an empty one, and an unknown repo", async () => {
    expect((await clip("text/plain", png)).status).toBe(415);
    expect((await clip("image/png", new Uint8Array())).status).toBe(400);
    expect((await clip("image/png", png, "nope")).status).toBe(404);
  });
});

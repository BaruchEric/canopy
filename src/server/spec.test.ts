/**
 * `POST /api/repos/spec`: the UI's `canopy spec sync`. It writes the shared
 * spec's blocks into a checkout, answers what it wrote, and puts the new
 * spec state on the repo the page holds.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let root: string;
let server: { port: number; stop: () => void };
let saved: string | undefined;
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const sync = (id: string, body: unknown) =>
  fetch(url(`/api/repos/spec?id=${id}`), { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-spec-"));
  saved = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} && git -C ${join(root, "app")} init -q`.quiet();
  server = await startServer({ root, port: 0 });
});

afterAll(async () => {
  server.stop();
  if (saved === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = saved;
  await rm(scratch, { recursive: true, force: true });
});

describe("syncing the shared spec", () => {
  test("refuses halves that are not the doc, or the doc and the visual", async () => {
    expect((await sync("app", { halves: [] })).status).toBe(400);
    expect((await sync("app", { halves: ["visual"] })).status).toBe(400);
    expect((await sync("app", { halves: ["doc", "logo"] })).status).toBe(400);
    expect((await sync("app", { halves: "doc" })).status).toBe(400);
  });

  test("adopts the spec, then finds nothing left to write", async () => {
    const tree = (await (await fetch(url("/api/tree"))).json()) as { repos: Repo[] };
    expect(tree.repos.find((r) => r.id === "app")?.spec).toBe("not-adopted");

    const res = await sync("app", { halves: ["doc", "visual"] });
    expect(res.status).toBe(200);
    const got = (await res.json()) as { written: string[]; halves: string[]; repo: Repo };
    expect(got.written).toContain("SPEC.md");
    expect(got.written).toContain("DESIGN.md");
    expect(got.halves).toEqual(["doc", "visual"]);
    expect(got.repo.spec).toBe("in-sync");
    expect(await Bun.file(join(root, "app", ".canopy/spec.json")).exists()).toBe(true);

    const again = (await (await sync("app", {})).json()) as { written: string[]; halves: string[] };
    expect(again.written).toEqual([]);
    expect(again.halves).toEqual(["doc", "visual"]);
  });
});

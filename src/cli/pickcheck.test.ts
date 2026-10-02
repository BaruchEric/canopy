import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANOPY_CLI_PATH } from "../core/cli";

const dir = mkdtempSync(join(tmpdir(), "canopy-pickcheck-"));
mkdirSync(join(dir, ".canopy"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = async (files: Record<string, string | null>): Promise<{ code: number; err: string; out: string }> => {
  for (const [rel, text] of Object.entries(files)) {
    rmSync(join(dir, rel), { force: true });
    if (text !== null) writeFileSync(join(dir, rel), text);
  }
  const p = Bun.spawn([CANOPY_CLI_PATH, "incubator", "pick-check"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
};

test("a sound pick and its research pass", async () => {
  const r = await run({ ".canopy/research.md": "# Research\n", ".canopy/pick.json": JSON.stringify({ kind: "new", host: "vercel", why: "w" }) });
  expect(r.code).toBe(0);
  expect(r.out).toContain("pick ok: new on vercel");
});

test("no pick, a bad pick, a refused license and no research each say why", async () => {
  expect((await run({ ".canopy/pick.json": null })).err).toContain(".canopy/pick.json is missing");
  expect((await run({ ".canopy/pick.json": "{" })).err).toContain("pick.json is not JSON");
  const agpl = JSON.stringify({ kind: "renovate", host: "vercel", why: "w", target: "https://github.com/a/b", license: "AGPL-3.0" });
  const r = await run({ ".canopy/pick.json": agpl });
  expect(r.code).toBe(1);
  expect(r.err).toContain("AGPL-3.0 is not on the allowed license list");
  expect((await run({ ".canopy/pick.json": JSON.stringify({ kind: "new", host: "vercel", why: "w" }), ".canopy/research.md": null })).err).toContain(".canopy/research.md is missing");
});

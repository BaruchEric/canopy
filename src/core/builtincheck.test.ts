import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinCheck, isBuiltinCheck } from "./builtincheck";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-builtin-"));
  await mkdir(join(dir, ".canopy"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
const put = (rel: string, text: string) => writeFile(join(dir, rel), text);

describe("built-in checks", () => {
  test("a line starting with @ is one", () => {
    expect(isBuiltinCheck("@pick-check")).toBe(true);
    expect(isBuiltinCheck("@anything; rm -rf x")).toBe(true);
    expect(isBuiltinCheck(" @pick-check")).toBe(false);
    expect(isBuiltinCheck("bun test")).toBe(false);
  });

  test("@pick-check: missing, bad, refused, then ok", async () => {
    expect((await builtinCheck("@pick-check", dir)).output).toContain("pick.json is missing");
    await put(".canopy/pick.json", "{");
    expect((await builtinCheck("@pick-check", dir)).exit).toBe(1);
    await put(".canopy/pick.json", JSON.stringify({ kind: "renovate", host: "vercel", why: "x", target: "https://github.com/a/b" }));
    expect((await builtinCheck("@pick-check", dir)).output).toContain("SPDX");
    await put(".canopy/pick.json", JSON.stringify({ kind: "new", host: "vercel", why: "nothing close" }));
    expect((await builtinCheck("@pick-check", dir)).output).toContain("research.md is missing");
    await put(".canopy/research.md", "# research\n");
    expect(await builtinCheck("@pick-check", dir)).toEqual({ exit: 0, output: "pick ok: new on vercel" });
  });

  test("@questions: absent is fine, a bad list is not", async () => {
    expect((await builtinCheck("@questions", dir)).exit).toBe(0);
    await put(".canopy/questions.json", '[{"q": 1}]');
    expect((await builtinCheck("@questions", dir)).exit).toBe(1);
    await put(".canopy/questions.json", '[{"question": "who is it for?"}]');
    expect((await builtinCheck("@questions", dir)).exit).toBe(0);
  });

  test("a seed's bunfig preload never runs: nothing here starts bun", async () => {
    await put("bunfig.toml", 'preload = ["./p.ts"]\n');
    await put("p.ts", `await Bun.write(${JSON.stringify(join(dir, "ran"))}, "x");\n`);
    await builtinCheck("@pick-check", dir);
    await builtinCheck("@questions", dir);
    expect(await Bun.file(join(dir, "ran")).exists()).toBe(false);
  });

  test("an unknown name says so", async () => {
    expect(await builtinCheck("@nope", dir)).toEqual({ exit: 2, output: "no built-in check @nope" });
    expect(await builtinCheck("@pick-check; echo hi", dir)).toEqual({ exit: 2, output: "no built-in check @pick-check; echo hi" });
  });

  test("a symlinked or oversize file fails the check instead of throwing", async () => {
    const d = await mkdtemp(join(tmpdir(), "canopy-builtin-bad-"));
    try {
      await mkdir(join(d, ".canopy"));
      await writeFile(join(d, "elsewhere"), "{}");
      await symlink(join(d, "elsewhere"), join(d, ".canopy", "pick.json"));
      const link = await builtinCheck("@pick-check", d);
      expect(link.exit).toBe(1);
      expect(link.output).toContain("pick.json");
      await writeFile(join(d, ".canopy", "questions.json"), "x".repeat(300 * 1024));
      const big = await builtinCheck("@questions", d);
      expect(big.exit).toBe(1);
      expect(big.output).toContain("questions.json");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

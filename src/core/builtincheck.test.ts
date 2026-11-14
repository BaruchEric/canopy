import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinCheck, isBuiltinCheck } from "./builtincheck";
import { CONVEX_PARKED } from "./sprout";
import type { SproutPick } from "./types";

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

  test("@pick-check: a host this phase cannot deploy, and what the backend would refuse later, fail it before the judge", async () => {
    const d = await mkdtemp(join(tmpdir(), "canopy-builtin-pick-"));
    try {
      await mkdir(join(d, ".canopy"));
      await writeFile(join(d, ".canopy", "research.md"), "# research\n");
      await writeFile(join(d, ".canopy", "pick.json"), JSON.stringify({ kind: "new", host: "vercel+convex", why: "it needs a database" }));
      expect(await builtinCheck("@pick-check", d)).toEqual({ exit: 1, output: `.canopy/pick.json: ${CONVEX_PARKED}` });
      const pick = { kind: "renovate", host: "vercel", why: "a maintained fork", target: "https://github.com/up/lib", license: "MIT" };
      await writeFile(join(d, ".canopy", "pick.json"), JSON.stringify(pick));
      const asked: SproutPick[] = [];
      const refused = await builtinCheck("@pick-check", d, {
        pick: async (p) => {
          asked.push(p);
          return "GitHub says https://github.com/up/lib is GPL-3.0, not the MIT scout read";
        },
      });
      expect(refused).toEqual({ exit: 1, output: ".canopy/pick.json: GitHub says https://github.com/up/lib is GPL-3.0, not the MIT scout read" });
      expect(asked).toEqual([pick as SproutPick]);
      expect(await builtinCheck("@pick-check", d, { pick: async () => null })).toEqual({ exit: 0, output: "pick ok: renovate on vercel" });
      // a seed no sprout of this server's holds has nothing more to ask
      expect(await builtinCheck("@pick-check", d, { pick: async () => undefined })).toEqual({ exit: 0, output: "pick ok: renovate on vercel" });
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("@questions: intent.md and questions.json both written, and a list canopy can read", async () => {
    const d = await mkdtemp(join(tmpdir(), "canopy-builtin-questions-"));
    try {
      await mkdir(join(d, ".canopy"));
      const run = () => builtinCheck("@questions", d);
      expect(await run()).toEqual({ exit: 1, output: ".canopy/intent.md is missing: clarify writes it before its questions" });
      await writeFile(join(d, ".canopy", "intent.md"), "# Intent\n");
      expect(await run()).toEqual({ exit: 1, output: ".canopy/questions.json is missing: write [] when nothing needs asking" });
      await writeFile(join(d, ".canopy", "questions.json"), '[{"q": 1}]');
      expect((await run()).exit).toBe(1);
      await writeFile(join(d, ".canopy", "questions.json"), "[]");
      expect(await run()).toEqual({ exit: 0, output: "0 questions" });
      await writeFile(join(d, ".canopy", "questions.json"), '[{"question": "who is it for?"}]');
      expect(await run()).toEqual({ exit: 0, output: "1 questions" });
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("@advice: retro.md first, then a list canopy can read", async () => {
    const d = await mkdtemp(join(tmpdir(), "canopy-builtin-advice-"));
    try {
      await mkdir(join(d, ".canopy"));
      const run = () => builtinCheck("@advice", d);
      expect((await run()).output).toContain("retro.md is missing");
      await writeFile(join(d, ".canopy", "retro.md"), "# Retro\n");
      expect((await run()).output).toContain("advice.json is missing");
      await writeFile(join(d, ".canopy", "advice.json"), '[{"key": "Not A Slug", "lesson": "x"}]');
      const bad = await run();
      expect(bad.exit).toBe(1);
      expect(bad.output).toContain(".canopy/advice.json: advice 1: key");
      await writeFile(join(d, ".canopy", "advice.json"), "[]");
      expect(await run()).toEqual({ exit: 0, output: "no advice" });
      await writeFile(
        join(d, ".canopy", "advice.json"),
        JSON.stringify([
          { key: "a", lesson: "one" },
          { key: "b", lesson: "two", file: "scout" },
        ]),
      );
      expect(await run()).toEqual({ exit: 0, output: "2 pieces of advice" });
    } finally {
      await rm(d, { recursive: true, force: true });
    }
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
      await writeFile(join(d, ".canopy", "intent.md"), "# Intent\n");
      await writeFile(join(d, ".canopy", "questions.json"), "x".repeat(300 * 1024));
      const big = await builtinCheck("@questions", d);
      expect(big.exit).toBe(1);
      expect(big.output).toContain("questions.json");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

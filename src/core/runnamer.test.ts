import { expect, test } from "bun:test";
import type { ExecResult } from "./exec";
import { makeNamer, modelName, NAME_MODEL, nameArgs, NAMERS_AT_ONCE, NAMERS_WAITING } from "./runnamer";

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const which = () => "/bin/claude";

test("the namer's line names the small model and leaves it no tools, hooks or session", () => {
  const argv = nameArgs("the prompt");
  expect(argv.slice(0, 2)).toEqual(["-p", "the prompt"]);
  expect(argv[argv.indexOf("--model") + 1]).toBe(NAME_MODEL);
  expect(argv[argv.indexOf("--tools") + 1]).toBe("");
  expect(argv).toContain("--strict-mcp-config");
  expect(argv).toContain("--no-session-persistence");
  expect(JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "")).toEqual({ disableAllHooks: true });
});

test("the model's answer becomes the name, asked away from any repo", async () => {
  const seen: { argv: string[]; cwd?: string }[] = [];
  const name = await modelName("Please fix the top bar on a phone", {
    which,
    run: async (argv, opts) => {
      seen.push({ argv, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
      return ok("Fix phone top bar.\n");
    },
  });
  expect(name).toBe("fix phone top bar");
  expect(seen[0]?.argv[0]).toBe("/bin/claude");
  expect(seen[0]?.argv[2]).toContain("Task:\nPlease fix the top bar on a phone");
  expect(seen[0]?.cwd).toBeDefined();
});

test("no claude, no words, a failure or a throw all give no name", async () => {
  let ran = 0;
  const run = async () => ((ran += 1), ok("a name"));
  expect(await modelName("words", { which: () => null, run })).toBeNull();
  expect(await modelName("   ", { which, run })).toBeNull();
  expect(ran).toBe(0);
  expect(await modelName("words", { which, run: async () => ({ code: 1, stdout: "a name", stderr: "" }) })).toBeNull();
  expect(await modelName("words", { which, run: async () => { throw new Error("spawn failed"); } })).toBeNull();
  expect(await modelName("words", { which, run: async () => ok("This is a whole sentence about what the task might be, not a name") })).toBeNull();
});

test("a burst runs a few namers at once, queues some and gives the rest no name", async () => {
  let going = 0;
  let most = 0;
  const release: (() => void)[] = [];
  const namer = makeNamer({
    which,
    run: async () => {
      going += 1;
      most = Math.max(most, going);
      await new Promise<void>((r) => release.push(r));
      going -= 1;
      return ok("a name");
    },
  });
  const all = Array.from({ length: NAMERS_AT_ONCE + NAMERS_WAITING + 3 }, (_, i) => namer(`task ${i}`));
  await Promise.resolve();
  // the ones past the queue answer at once
  const late = await Promise.all(all.slice(NAMERS_AT_ONCE + NAMERS_WAITING));
  expect(late).toEqual([null, null, null]);
  while (release.length || going) {
    release.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
  }
  const rest = await Promise.all(all.slice(0, NAMERS_AT_ONCE + NAMERS_WAITING));
  expect(rest.every((n) => n === "a name")).toBe(true);
  expect(most).toBe(NAMERS_AT_ONCE);
});

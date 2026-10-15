import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { applyKeys } from "./sinks";

const WRAPPER = join(import.meta.dir, "..", "..", "scripts", "canopy-mcp-env");
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "mcpenv-"));
  dirs.push(h);
  mkdirSync(join(h, ".claude", "mcp-env"), { recursive: true });
  return h;
}

// one value per branch of quoteDotenv: bare, single quoted, double quoted
const AWKWARD: Record<string, string> = {
  BARE: "plain-value_1.2:3@x+y,z=w",
  SPACED: "two words $HOME `id` \\back = sign",
  DQ: 'it\'s "quoted"\nsecond\tline\\ end',
  TRAIL: "ends with a newline\n",
  CMD: "$(touch PWNED) ; `touch PWNED2`",
};
const PRINT = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(AWKWARD))}.map((k) => [k, process.env[k]]))))`;

test("passes every value through unchanged, and never runs one", async () => {
  const h = home();
  const t = applyKeys(null, "dotenv", AWKWARD);
  if ("error" in t) throw new Error(t.error);
  // a comment, and no newline after the last pair: the reader takes both
  writeFileSync(join(h, ".claude", "mcp-env", "demo.env"), `# written by canopy\n${t.text.replace(/\n$/, "")}`, { mode: 0o600 });
  for (const sh of ["sh", ...(Bun.which("dash") ? ["dash"] : [])]) {
    const r = await exec([sh, WRAPPER, "demo", "--", process.execPath, "-e", PRINT], { cwd: h, env: { HOME: h } });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual(AWKWARD);
  }
  expect(existsSync(join(h, "PWNED"))).toBe(false);
  expect(existsSync(join(h, "PWNED2"))).toBe(false);
});

test("--headers prints the headers file as it is", async () => {
  const h = home();
  writeFileSync(join(h, ".claude", "mcp-env", "hook.headers.json"), '{"Authorization":"x"}\n');
  const r = await exec(["sh", WRAPPER, "--headers", "hook"], { env: { HOME: h } });
  expect(r).toMatchObject({ code: 0, stdout: '{"Authorization":"x"}\n' });
});

test("a missing file and a bad call exit 1 with one line naming the file, and print nothing", async () => {
  const h = home();
  const r = await exec(["sh", WRAPPER, "gone", "--", "true"], { env: { HOME: h } });
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe(`canopy-mcp-env: cannot read ${join(h, ".claude", "mcp-env", "gone.env")}\n`);
  expect((await exec(["sh", WRAPPER, "../etc", "--", "true"], { env: { HOME: h } })).stderr).toContain("usage");
  expect((await exec(["sh", WRAPPER, "demo", "true"], { env: { HOME: h } })).stderr).toContain("usage");
});

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

const REFUSED = ["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_FRAMEWORK_PATH", "BASH_ENV", "ENV", "IFS", "SHELLOPTS", "BASHOPTS", "PS4", "NODE_OPTIONS", "BUN_OPTIONS"];

test("a name that changes how the server starts is refused, naming the variable and the file, never a value", async () => {
  for (const name of REFUSED) {
    const h = home();
    const file = join(h, ".claude", "mcp-env", "demo.env");
    writeFileSync(file, `OK=fine\n${name}=/tmp/hostile-value\n`);
    const marker = join(h, "reached");
    const r = await exec(["sh", WRAPPER, "demo", "--", "sh", "-c", `echo reached > ${marker}`], { env: { HOME: h } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`canopy-mcp-env: refusing ${name} in ${file}\n`);
    expect(existsSync(marker)).toBe(false);
  }
});

test("a malformed name never reaches the server, and a normal name still does", async () => {
  const h = home();
  const dir = join(h, ".claude", "mcp-env");
  writeFileSync(join(dir, "bad.env"), "A B=1\n'A=B'=2\n1X=3\nA-B=4\n=5\nGOOD=yes\n");
  const probe = `process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => /^(A B|A|1X|A-B|)$|=|^'/.test(k) || k === "GOOD").sort().concat(String(process.env.A))))`;
  const r = await exec(["sh", WRAPPER, "bad", "--", process.execPath, "-e", probe], { env: { HOME: h } });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(["GOOD", "undefined"]);
  writeFileSync(join(dir, "good.env"), "GOOD=yes\n");
  const g = await exec(["sh", WRAPPER, "good", "--", process.execPath, "-e", "process.stdout.write(process.env.GOOD ?? '')"], { env: { HOME: h } });
  expect(g.stdout).toBe("yes");
});

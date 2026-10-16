import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, onHost, type ExecResult } from "./exec";
import { sshSinks } from "./sinkssh";

const SECRET = 'p@$$ "w0rd" = \\ `x` $(id)';

let dir = "";
let calls: { cmd: string[]; input: string | undefined }[] = [];

/** runs the scripts here, as ssh would there, and records argv and stdin */
const local = (_host: string | null, cmd: string[], opts: { timeoutMs?: number; input?: string }): Promise<ExecResult> => {
  calls.push({ cmd, input: opts.input });
  return onHost(null, cmd, opts);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-sinkssh-"));
  calls = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sshSinks", () => {
  test("probe answers with the machine's home, or why it is away", async () => {
    expect(await sshSinks("gpd", "gpd", local).probe()).toEqual({ home: process.env["HOME"] ?? "" });
    const down = async (): Promise<ExecResult> => ({ code: 255, stdout: "", stderr: "ssh: connect to host gpd port 22: Operation timed out\n" });
    expect(await sshSinks("gpd", "gpd", down).probe()).toEqual({ away: "ssh: connect to host gpd port 22: Operation timed out" });
    const silent = async (): Promise<ExecResult> => ({ code: 124, stdout: "", stderr: "" });
    expect(await sshSinks("gpd", "gpd", silent).probe()).toEqual({ away: "no answer from gpd within 20 s" });
  });

  test("a write sends the text on stdin, never as an argument, and reads back unchanged at 0600", async () => {
    const s = sshSinks("gpd", "gpd", local);
    const path = join(dir, "app.env");
    const text = `KEEP=1\nTOKEN='${SECRET}'\n`;
    await s.io.write(path, text);
    expect(await readFile(path, "utf8")).toBe(text);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await s.io.read(path)).toEqual({ text });
    for (const c of calls) expect(c.cmd.join(" ")).not.toContain(SECRET);
    expect(calls.some((c) => c.input !== undefined && !c.input.includes(SECRET))).toBe(true);
    // no temp file left behind
    expect((await readdir(dir)).sort()).toEqual(["app.env"]);
  });

  test("a missing file reads null, an empty one empty, and a symlink is refused both ways", async () => {
    const s = sshSinks("gpd", "gpd", local);
    expect(await s.io.read(join(dir, "none.env"))).toEqual({ text: null });
    await writeFile(join(dir, "empty.env"), "");
    expect(await s.io.read(join(dir, "empty.env"))).toEqual({ text: "" });
    await symlink(join(dir, "empty.env"), join(dir, "link.env"));
    expect(await s.io.read(join(dir, "link.env"))).toEqual({ error: `${join(dir, "link.env")} is a symlink on gpd; canopy writes only plain files` });
    await expect(s.io.write(join(dir, "link.env"), "A=1\n")).rejects.toThrow("is a symlink");
  });

  test("the write makes a missing mcp-env folder 0700 and no other folder", async () => {
    const s = sshSinks("gpd", "gpd", local);
    await s.io.write(join(dir, "mcp-env", "github.env"), "T=1\n");
    expect((await lstat(join(dir, "mcp-env"))).mode & 0o777).toBe(0o700);
    await expect(s.io.write(join(dir, "other", "x.env"), "T=1\n")).rejects.toThrow(`no folder ${join(dir, "other")}`);
  });

  test("a path in a work tree that does not ignore it is refused; an ignored one or one outside a repo is not", async () => {
    const s = sshSinks("gpd", "gpd", local);
    expect(await s.refusal(join(dir, "loose.env"))).toBeNull();
    const repo = join(dir, "repo");
    await mkdir(repo);
    await exec(["git", "init", "-q", repo]);
    await writeFile(join(repo, ".gitignore"), "mcp-env/\n");
    expect(await s.refusal(join(repo, "mcp-env", "github.env"))).toBeNull();
    expect(await s.refusal(join(repo, ".env"))).toContain(`is inside the repo`);
  });

  test("prune removes the kit's env files no sink keeps, and nothing else", async () => {
    const s = sshSinks("gpd", "gpd", local);
    const d = join(dir, "mcp-env");
    await mkdir(d);
    for (const n of ["github.env", "old.env", "old.headers.json", "notes.txt", "Bad.env"]) await writeFile(join(d, n), "x");
    const r = await s.prune(d, [join(d, "github.env")]);
    expect(r).toEqual({ removed: ["old.env", "old.headers.json"], failed: [] });
    expect((await readdir(d)).sort()).toEqual(["Bad.env", "github.env", "notes.txt"]);
    expect(await s.prune(join(dir, "missing"), [])).toEqual({ removed: [], failed: [] });
  });
});

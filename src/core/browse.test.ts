import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseCommand, browseLocal, parseBrowse } from "./browse";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-browse-"));
  await mkdir(join(root, "b-repo/.git"), { recursive: true });
  await mkdir(join(root, "a-plain"), { recursive: true });
  await mkdir(join(root, ".hidden"), { recursive: true });
  await mkdir(join(root, ".dotrepo/.git"), { recursive: true });
  await writeFile(join(root, "file.txt"), "x");
  await symlink(join(root, "b-repo"), join(root, "c-link"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("browseLocal", () => {
  test("lists visible folders a to z, flags repos, follows links", async () => {
    const l = await browseLocal(root);
    expect(l.path).toBe(root);
    expect(l.parent).toBe(join(root, ".."));
    expect(l.dirs).toEqual([
      { name: "a-plain", repo: false },
      { name: "b-repo", repo: true },
      { name: "c-link", repo: true },
    ]);
  });

  test("hidden folders join the list when asked for, ahead of the rest", async () => {
    const l = await browseLocal(root, { hidden: true });
    expect(l.dirs).toEqual([
      { name: ".dotrepo", repo: true },
      { name: ".hidden", repo: false },
      { name: "a-plain", repo: false },
      { name: "b-repo", repo: true },
      { name: "c-link", repo: true },
    ]);
    // a hidden folder opens like any other, asked for or not
    expect((await browseLocal(join(root, ".hidden"))).parent).toBe(root);
  });

  test("the root has no parent; a file is not a folder", async () => {
    expect((await browseLocal("/")).parent).toBeNull();
    await expect(browseLocal(join(root, "file.txt"))).rejects.toThrow("not a folder");
  });
});

describe("remote listing", () => {
  test("one sh script: the real path, then r/d lines", () => {
    const cmd = browseCommand("~/dev");
    expect(cmd.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(cmd[2]).toStartWith("cd ~/'dev' && pwd -P");
  });

  test("the script globs dot-folders only when asked, and never . or ..", () => {
    expect(browseCommand("~/dev")[2]).not.toContain(".*/");
    const script = browseCommand("~/dev", { hidden: true })[2] ?? "";
    expect(script).toContain("for d in */ .*/;");
    expect(script).toContain("case $d in .|..) continue;; esac");
  });

  test("the hidden script lists what the local listing does", async () => {
    const [sh = "", flag = "", script = ""] = browseCommand(root, { hidden: true });
    const out = await new Response(Bun.spawn([sh, flag, script]).stdout).text();
    expect(parseBrowse(out).dirs).toEqual((await browseLocal(root, { hidden: true })).dirs);
    const plain = browseCommand(root);
    const seen = await new Response(Bun.spawn(plain).stdout).text();
    expect(parseBrowse(seen).dirs).toEqual((await browseLocal(root)).dirs);
  });

  test("parses the lines and sorts them", () => {
    const l = parseBrowse("/home/me/dev\nr zeta\nd alpha\nr beta\n");
    expect(l).toEqual({
      path: "/home/me/dev",
      parent: "/home/me",
      dirs: [
        { name: "alpha", repo: false },
        { name: "beta", repo: true },
        { name: "zeta", repo: true },
      ],
    });
    expect(() => parseBrowse("bash: cd: nope\n")).toThrow();
  });
});

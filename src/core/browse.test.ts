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

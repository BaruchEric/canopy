import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shareInputs, shareWorkspace, unshare } from "./stageshare";

let root = "";
let outside = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-share-"));
  outside = await mkdtemp(join(tmpdir(), "canopy-share-out-"));
  await mkdir(join(root, "_devhub"), { recursive: true });
  await mkdir(join(root, "web-apps", "tally"), { recursive: true });
  await mkdir(join(root, "dev-tools", "canopy"), { recursive: true });
  await writeFile(join(root, ".env"), "GH_TOKEN=secret\n");
  await writeFile(join(root, "web-apps", "tally", "README.md"), "# tally\n");
  await writeFile(join(root, "dev-tools", "canopy", "README.md"), "# canopy\n");
  await symlink(join(root, ".env"), join(root, "web-apps", "tally", "LINK.md"));
  await writeFile(join(outside, "README.md"), "# outside GH_TOKEN\n");
  await symlink(outside, join(root, "web-apps", "escape"));
  await writeFile(
    join(root, "_devhub", "manifest.json"),
    JSON.stringify({
      categories: {
        "web-apps": {
          projects: [
            { name: "tally", path: "web-apps/tally" },
            { name: "x", path: "../../etc" },
            { name: "escape", path: "web-apps/escape" },
          ],
        },
        "dev-tools": { projects: [{ name: "canopy", path: "dev-tools/canopy" }] },
      },
    }),
  );
  await writeFile(join(root, "_devhub", "references.json"), "{}");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("stage share", () => {
  test("the workspace snapshot holds the two indexes and each listed project's README, nothing else", async () => {
    const dir = await shareWorkspace(join(root, "_incubator"), root, "sp_a");
    expect(dir).toBe(join(root, "_incubator", ".shared", "workspace", "sp_a"));
    expect((await readdir(dir)).sort()).toEqual(["READMEs", "manifest.json", "references.json"]);
    expect((await readdir(join(dir, "READMEs"))).sort()).toEqual(["dev-tools__canopy.md", "web-apps__tally.md"]);
  });

  test("a README that is a symlink, a path out of the root or the .env never lands", async () => {
    const dir = await shareWorkspace(join(root, "_incubator"), root, "sp_a");
    const all = await readdir(join(dir, "READMEs"));
    expect(all).not.toContain("web-apps__escape.md");
    for (const f of all) expect(await Bun.file(join(dir, "READMEs", f)).text()).not.toContain("GH_TOKEN");
  });

  test("the cap holds", async () => {
    const dir = await shareWorkspace(join(root, "_incubator"), root, "sp_a", { files: 1, bytes: 1_000_000 });
    expect(await readdir(join(dir, "READMEs"))).toHaveLength(1);
  });

  test("two shares at once for different sprouts both finish whole, and no scratch is left", async () => {
    const seeds = join(root, "_incubator");
    const [a, b] = await Promise.all([shareWorkspace(seeds, root, "sp_b"), shareWorkspace(seeds, root, "sp_c")]);
    expect(a).not.toBe(b);
    for (const d of [a, b]) {
      expect((await readdir(d)).sort()).toEqual(["READMEs", "manifest.json", "references.json"]);
      expect(await readdir(join(d, "READMEs"))).toHaveLength(2);
    }
    expect((await readdir(join(seeds, ".shared"))).filter((n) => n.startsWith(".tmp"))).toEqual([]);
  });

  test("inputs are copied, replaced on the next share, and never follow a symlink", async () => {
    const from = join(root, "inputs-src");
    await mkdir(from, { recursive: true });
    await writeFile(join(from, "1.txt"), "an idea");
    await symlink(join(root, ".env"), join(from, "2.txt"));
    const to = await shareInputs(join(root, "_incubator"), "abc123", from);
    expect(await readdir(to)).toEqual(["1.txt"]);
    await writeFile(join(from, "3.txt"), "more");
    expect((await readdir(await shareInputs(join(root, "_incubator"), "abc123", from))).sort()).toEqual(["1.txt", "3.txt"]);
  });

  test("unshare removes one sprout's copies and leaves another's", async () => {
    const seeds = join(root, "_incubator");
    await shareWorkspace(seeds, root, "sp_x");
    await shareWorkspace(seeds, root, "sp_y");
    await unshare(seeds, "sp_x");
    expect(await readdir(join(seeds, ".shared", "workspace"))).not.toContain("sp_x");
    expect(await readdir(join(seeds, ".shared", "workspace"))).toContain("sp_y");
  });
});

import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropSeedProjects, sweepCodexTrust } from "./codextrust";

const TRUSTED = '[projects."/w/_incubator/coin"]\ntrust_level = "trusted"\n';

describe("codex never trusts a seed", () => {
  test("the sweep rewrites the file only when a seed's table is there, and leaves no temp file", async () => {
    const home = await mkdtemp(join(tmpdir(), "canopy-codexhome-"));
    const file = join(home, "config.toml");
    await writeFile(file, '[projects."/w/_incubator/coin"]\ntrust_level = "trusted"\n');
    expect(await sweepCodexTrust(home, "/w/_incubator")).toBe(true);
    expect(await Bun.file(file).text()).not.toContain("_incubator");
    expect(await readdir(home)).toEqual(["config.toml"]);
    expect(await sweepCodexTrust(home, "/w/_incubator")).toBe(false);
    expect(await sweepCodexTrust(join(home, "none"), "/w/_incubator")).toBe(false);
    await rm(home, { recursive: true, force: true });
  });
  test("the rewritten file keeps the mode it had", async () => {
    const home = await mkdtemp(join(tmpdir(), "canopy-codexhome-"));
    const file = join(home, "config.toml");
    await writeFile(file, TRUSTED);
    await chmod(file, 0o640);
    expect(await sweepCodexTrust(home, "/w/_incubator")).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    await rm(home, { recursive: true, force: true });
  });
  test("a link at config.toml, or at a temp name, is never followed", async () => {
    const home = await mkdtemp(join(tmpdir(), "canopy-codexhome-"));
    const outside = join(home, "outside");
    await writeFile(outside, TRUSTED);
    await chmod(outside, 0o644);
    // config.toml a link to a file the sweep's user could write
    await symlink(outside, join(home, "config.toml"));
    expect(await sweepCodexTrust(home, "/w/_incubator")).toBe(false);
    expect(await readFile(outside, "utf8")).toBe(TRUSTED);
    expect((await lstat(join(home, "config.toml"))).isSymbolicLink()).toBe(true);
    // a plain config.toml, with a link planted at the temp name the sweep once used
    await rm(join(home, "config.toml"));
    await writeFile(join(home, "config.toml"), TRUSTED);
    await symlink(outside, join(home, `config.toml.canopy-${process.pid}.tmp`));
    expect(await sweepCodexTrust(home, "/w/_incubator")).toBe(true);
    expect(await readFile(outside, "utf8")).toBe(TRUSTED);
    expect((await stat(outside)).mode & 0o777).toBe(0o644);
    expect(await readFile(join(home, "config.toml"), "utf8")).not.toContain("_incubator");
    await rm(home, { recursive: true, force: true });
  });
  test("the sweep drops a seed's project table and keeps the rest byte for byte", () => {
    const toml = [
      'model = "gpt-5"',
      "",
      '[projects."/w/dev/canopy"]',
      'trust_level = "trusted"',
      "",
      '[projects."/w/_incubator/coin"]',
      'trust_level = "trusted"',
      "",
      "[tui]",
      "x = 1",
      "",
    ].join("\n");
    const out = dropSeedProjects(toml, "/w/_incubator");
    expect(out).toContain('[projects."/w/dev/canopy"]');
    expect(out).not.toContain("_incubator");
    expect(out).toContain("[tui]\nx = 1");
    expect(dropSeedProjects(out, "/w/_incubator")).toBe(out);
  });
});

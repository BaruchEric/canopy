import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropSeedProjects, sweepCodexTrust } from "./codextrust";

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

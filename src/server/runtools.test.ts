import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsDir } from "../core/runlog";
import { BUNDLED_TOOLS_BRIEF, canopyMcpCommand, flowToolsId, mcpConfigPath, removeMcpConfig, removeRunSettings, runConfigLaunch, settingsPath, sweepMcpConfigs, toolsBrief, writeMcpConfig, writeRunSettings } from "./runtools";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "canopy-runtools-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const entry = { canopy: { command: "/bin/bun", args: ["x", "mcp"], env: { CANOPY_TOKEN: "t" } } };

describe("what a run with tools is told", () => {
  test("the bundled brief says where a run stops, and the config dir's copy replaces it", async () => {
    const bundled = await toolsBrief(dir);
    expect(bundled).toBe((await readFile(BUNDLED_TOOLS_BRIEF, "utf8")).trim());
    for (const words of ["canopy_run_start", "canopy_work_note", "landing queue", "never pushes", "must stand alone", "no right to land"]) expect(bundled).toContain(words);
    await writeFile(join(dir, "canopy-tools.md"), "mine\n");
    expect(await toolsBrief(dir)).toBe("mine");
  });

  test("Codex's launch line ends in the path, with no token in it", () => {
    const { args, command } = runConfigLaunch("/c/run-tools/a.mcp.json");
    expect(command).toBe(process.execPath);
    expect(args.slice(-3)).toEqual(["mcp", "--run-config", "/c/run-tools/a.mcp.json"]);
  });
});

describe("a run's mcp.json", () => {
  test("is 0600 in a 0700 folder and holds the entry", async () => {
    const file = await writeMcpConfig("aaaa1111", entry, dir);
    expect(file).toBe(mcpConfigPath("aaaa1111", dir));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(file, "utf8")).mcpServers.canopy.env.CANOPY_TOKEN).toBe("t");
  });

  test("never sits in a run's transcript folder, which the log may remove whole", () => {
    expect(mcpConfigPath("aaaa1111").startsWith(join(runsDir(), "aaaa1111"))).toBe(false);
  });

  test("a loose folder is tightened, and a link in the file's place is refused", async () => {
    await chmod(dir, 0o755);
    await writeMcpConfig("bbbb2222", entry, dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    await symlink(join(dir, "elsewhere"), mcpConfigPath("cccc3333", dir));
    await expect(writeMcpConfig("cccc3333", entry, dir)).rejects.toThrow();
    expect(existsSync(join(dir, "elsewhere"))).toBe(false);
  });

  test("going removes the file, and a file already gone is nothing", async () => {
    await writeMcpConfig("aaaa1111", entry, dir);
    await removeMcpConfig("aaaa1111", dir);
    expect(existsSync(mcpConfigPath("aaaa1111", dir))).toBe(false);
    await removeMcpConfig("never000", dir);
  });

  test("the sweep clears every run's file and nothing else; a missing folder is nothing", async () => {
    await writeMcpConfig("aaaa1111", entry, dir);
    await writeMcpConfig("bbbb2222", entry, dir);
    await writeFile(join(dir, "note.txt"), "x");
    await sweepMcpConfigs(dir);
    expect(existsSync(mcpConfigPath("aaaa1111", dir))).toBe(false);
    expect(existsSync(mcpConfigPath("bbbb2222", dir))).toBe(false);
    expect(existsSync(join(dir, "note.txt"))).toBe(true);
    await sweepMcpConfigs(join(dir, "nothing"));
  });
});

test("the command is this bun and canopy's own MCP entry, on no PATH", async () => {
  const { command, args } = canopyMcpCommand();
  expect(command).toBe(process.execPath);
  expect(args[1]).toBe("mcp");
  expect(existsSync(args[0] as string)).toBe(true);
});

test("a run's settings file is 0600 and goes with removeRunSettings and the sweep", async () => {
  const file = await writeRunSettings("r1", { skillOverrides: { ripe: "off" } }, dir);
  expect(file).toBe(settingsPath("r1", dir));
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ skillOverrides: { ripe: "off" } });
  await removeRunSettings("r1", dir);
  expect(existsSync(file)).toBe(false);
  await writeRunSettings("r2", {}, dir);
  await sweepMcpConfigs(dir);
  expect(existsSync(settingsPath("r2", dir))).toBe(false);
});

test("the sweep leaves a card flow's files, which its steps read after a restart", async () => {
  const id = flowToolsId("0123abcd");
  expect(id).toBe("flow-0123abcd");
  await writeRunSettings(id, {}, dir);
  await writeMcpConfig(id, {}, dir);
  await sweepMcpConfigs(dir);
  expect(existsSync(settingsPath(id, dir))).toBe(true);
  expect(existsSync(mcpConfigPath(id, dir))).toBe(true);
});

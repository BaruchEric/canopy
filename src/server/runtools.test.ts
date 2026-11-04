import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canopyMcpCommand, mcpConfigPath, removeMcpConfig, sweepMcpConfigs, writeMcpConfig } from "./runtools";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "canopy-runtools-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const entry = { command: "/bin/bun", args: ["x", "mcp"], env: { CANOPY_TOKEN: "t" } };

describe("a run's mcp.json", () => {
  test("is 0600 in a 0700 folder and holds the entry", async () => {
    const file = await writeMcpConfig("aaaa1111", entry, dir);
    expect(file).toBe(mcpConfigPath("aaaa1111", dir));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "aaaa1111")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(file, "utf8")).mcpServers.canopy.env.CANOPY_TOKEN).toBe("t");
  });

  test("a loose folder is tightened, and a link in the file's place is refused", async () => {
    await mkdir(join(dir, "bbbb2222"), { mode: 0o755 });
    await writeMcpConfig("bbbb2222", entry, dir);
    expect(statSync(join(dir, "bbbb2222")).mode & 0o777).toBe(0o700);
    await mkdir(join(dir, "cccc3333"));
    await symlink(join(dir, "elsewhere"), join(dir, "cccc3333", "mcp.json"));
    await expect(writeMcpConfig("cccc3333", entry, dir)).rejects.toThrow();
    expect(existsSync(join(dir, "elsewhere"))).toBe(false);
  });

  test("going leaves a transcript where it is and an empty folder gone", async () => {
    await writeMcpConfig("aaaa1111", entry, dir);
    await writeFile(join(dir, "aaaa1111", "wire.jsonl"), "x");
    await removeMcpConfig("aaaa1111", dir);
    expect(existsSync(mcpConfigPath("aaaa1111", dir))).toBe(false);
    expect(existsSync(join(dir, "aaaa1111", "wire.jsonl"))).toBe(true);
    await writeMcpConfig("bbbb2222", entry, dir);
    await removeMcpConfig("bbbb2222", dir);
    expect(existsSync(join(dir, "bbbb2222"))).toBe(false);
    await removeMcpConfig("never000", dir);
  });

  test("the sweep clears every file and no transcript; a missing folder is nothing", async () => {
    await writeMcpConfig("aaaa1111", entry, dir);
    await writeMcpConfig("bbbb2222", entry, dir);
    await writeFile(join(dir, "aaaa1111", "run.json"), "{}");
    await writeFile(join(dir, "index.json"), "{}");
    await sweepMcpConfigs(dir);
    expect(existsSync(mcpConfigPath("aaaa1111", dir))).toBe(false);
    expect(existsSync(mcpConfigPath("bbbb2222", dir))).toBe(false);
    expect(existsSync(join(dir, "aaaa1111", "run.json"))).toBe(true);
    expect(existsSync(join(dir, "index.json"))).toBe(true);
    await sweepMcpConfigs(join(dir, "nothing"));
  });
});

test("the command is this bun and canopy's own MCP entry, on no PATH", async () => {
  const { command, args } = canopyMcpCommand();
  expect(command).toBe(process.execPath);
  expect(args[1]).toBe("mcp");
  expect(existsSync(args[0] as string)).toBe(true);
});

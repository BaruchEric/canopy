import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFile } from "./secretfile";
import { mcpEnvKeep, pruneMcpEnv } from "./sinksync";

describe("pruneMcpEnv", () => {
  test("deletes the env and headers files no sink names, and nothing else", async () => {
    const d = mkdtempSync(join(tmpdir(), "prune-"));
    try {
      for (const n of ["github.env", "old.env", "old.headers.json", "notes.txt", "Mixed.env"]) writeFileSync(join(d, n), "x");
      const f = emptyFile({});
      f.sinks["mcp-github-mac"] = { machine: "mac", path: join(d, "github.env"), format: "dotenv", keys: {} };
      f.sinks["mcp-github-mini"] = { machine: "mini", path: join(d, "old.env"), format: "dotenv", keys: {} };
      const keep = mcpEnvKeep(f, "mac", d);
      expect(keep).toEqual([join(d, "github.env")]);
      expect(await pruneMcpEnv(d, keep)).toEqual({ removed: ["old.env", "old.headers.json"], failed: [] });
      expect(readdirSync(d).sort()).toEqual(["Mixed.env", "github.env", "notes.txt"]);
      expect(await pruneMcpEnv(join(d, "missing"), [])).toEqual({ removed: [], failed: [] });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("leaves a directory and a symlink of a sink's name alone, and never follows the link", async () => {
    const d = mkdtempSync(join(tmpdir(), "prune-"));
    try {
      const mcp = join(d, "mcp-env");
      mkdirSync(join(mcp, "stale.env"), { recursive: true });
      writeFileSync(join(mcp, "stale.env", "inside"), "x");
      writeFileSync(join(d, "elsewhere"), "kept");
      symlinkSync(join(d, "elsewhere"), join(mcp, "linked.env"));
      writeFileSync(join(mcp, "old.env"), "x");
      expect(await pruneMcpEnv(mcp, [])).toEqual({ removed: ["old.env"], failed: [] });
      expect(readdirSync(mcp).sort()).toEqual(["linked.env", "stale.env"]);
      expect(readdirSync(join(mcp, "stale.env"))).toEqual(["inside"]);
      expect(readFileSync(join(d, "elsewhere"), "utf8")).toBe("kept");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("a file it cannot remove is reported, and the prune still resolves", async () => {
    const d = mkdtempSync(join(tmpdir(), "prune-"));
    try {
      writeFileSync(join(d, "old.env"), "x");
      writeFileSync(join(d, "older.env"), "x");
      chmodSync(d, 0o500);
      expect(await pruneMcpEnv(d, [])).toEqual({ removed: [], failed: ["old.env", "older.env"] });
    } finally {
      chmodSync(d, 0o700);
      rmSync(d, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
      expect((await pruneMcpEnv(d, keep)).sort()).toEqual(["old.env", "old.headers.json"]);
      expect(readdirSync(d).sort()).toEqual(["Mixed.env", "github.env", "notes.txt"]);
      expect(await pruneMcpEnv(join(d, "missing"), [])).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

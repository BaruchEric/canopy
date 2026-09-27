// Which canopy this checkout is, read once: package.json's version and git's
// HEAD. Plain node APIs rather than Bun's, since vite.config.ts stamps the UI
// bundle through this too and vite may run it on node.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildInfo } from "./types";
import { buildFrom } from "./version";

/** canopy's own checkout, two folders up from this file */
export const CANOPY_DIR = join(import.meta.dirname, "..", "..");

interface Pkg {
  version?: string;
  homepage?: string;
}

export function readPkg(dir = CANOPY_DIR): Pkg {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Pkg;
  } catch {
    return {};
  }
}

function gitOut(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

function readHead(dir: string): { commit: string | null; committedAt: string | null; dirty: boolean } | null {
  const line = gitOut(dir, ["log", "-1", "--format=%H %cI"]);
  if (!line) return null;
  const [commit = null, committedAt = null] = line.split(" ");
  const status = gitOut(dir, ["status", "--porcelain", "--untracked-files=no"]);
  return { commit, committedAt, dirty: !!status };
}

export function readBuild(dir = CANOPY_DIR, env: Record<string, string | undefined> = process.env): BuildInfo {
  return buildFrom(readPkg(dir).version ?? "0.0.0", env, env["CANOPY_COMMIT"] ? null : readHead(dir));
}

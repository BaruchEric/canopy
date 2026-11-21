/**
 * The pure half of `bun run understand:update` (scripts/understand-update.ts),
 * which pulls a newer Understand-Anything release into lib/understand-anything
 * and carries canopy's own edits over with a three-way merge per file, as
 * floorplan:update does for Floorplan (the release tags, the pin and the
 * per-file plan are floorplanvendor.ts's). Here: where each upstream file
 * lands in canopy's copy, what canopy leaves out, and the version line.
 * No I/O. Tested in understandvendor.test.ts.
 */

/** where canopy's copy of Understand-Anything comes from */
export const UNDERSTAND_UPSTREAM = "https://github.com/Egonex-AI/Understand-Anything";

/** the plugin's folder upstream, which canopy's copy holds the inside of */
export const UNDERSTAND_PLUGIN_DIR = "understand-anything-plugin";

/** upstream files outside the plugin's folder that canopy keeps, at the top of its copy */
export const UNDERSTAND_TOP = ["LICENSE"] as const;

/** Paths inside the plugin's folder that canopy leaves out (VENDOR.md,
 *  "What is here"): the hooks, which would run on every Bash call of a
 *  graph run; the MCP server, which canopy does not serve and whose link
 *  back to the plugin bun cannot install; and pnpm's lockfile and
 *  workspace, since canopy installs with bun from its own bun.lock. */
export const UNDERSTAND_LEFT_OUT = ["hooks/", "packages/mcp/", "pnpm-lock.yaml", "pnpm-workspace.yaml"] as const;

/** canopy's own files inside lib/understand-anything, which a merge never touches */
export const UNDERSTAND_OWN = ["VENDOR.md", "bun.lock"] as const;

/** Where an upstream file lands in canopy's copy, relative to it, or null
 *  when canopy does not keep it. */
export function localPath(upstream: string): string | null {
  if ((UNDERSTAND_TOP as readonly string[]).includes(upstream)) return upstream;
  const prefix = `${UNDERSTAND_PLUGIN_DIR}/`;
  if (!upstream.startsWith(prefix)) return null;
  const rel = upstream.slice(prefix.length);
  if (!rel || UNDERSTAND_LEFT_OUT.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p))) return null;
  if ((UNDERSTAND_OWN as readonly string[]).includes(rel)) return null;
  return rel;
}

/** The upstream path a file of canopy's copy came from. */
export function upstreamPath(local: string): string {
  return (UNDERSTAND_TOP as readonly string[]).includes(local) ? local : `${UNDERSTAND_PLUGIN_DIR}/${local}`;
}

const VERSION_CONST = /(export const UNDERSTAND_VERSION = ")(\d+\.\d+\.\d+)(";)/;

/** src/core/understand.ts with UNDERSTAND_VERSION set; throws when the line is gone. */
export function writeVersionConst(source: string, version: string): string {
  if (!VERSION_CONST.test(source)) throw new Error("src/core/understand.ts has no UNDERSTAND_VERSION line");
  return source.replace(VERSION_CONST, `$1${version}$3`);
}

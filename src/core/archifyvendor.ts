/**
 * What is Archify's own in `bun run archify:update`
 * (scripts/archify-update.ts, FR-071), which pulls a newer Archify release
 * into lib/archify: where it comes from, how upstream's `archify/` folder
 * maps onto canopy's `skills/archify/`, what canopy leaves out, and the
 * plugin manifest's version. The pin, the release tags, the per-file plan,
 * the addresses and the changelog are shared with Floorplan's updater in
 * floorplanvendor.ts. No I/O. Tested in archifyvendor.test.ts.
 */

/** where canopy's copy of Archify comes from */
export const ARCHIFY_UPSTREAM = "https://github.com/tt-a1i/archify";

/** the folder upstream keeps the skill in: the package its installer copies */
export const ARCHIFY_SOURCE = "archify";

/** where that folder sits inside lib/archify */
export const ARCHIFY_SKILL_PATH = "skills/archify";

/** Whether canopy leaves a file of upstream's `archify/` out, by its path
 *  inside that folder: the rendered example pages `examples/*.html`, about
 *  830 KB each, which nothing at run time reads (VENDOR.md, "What is
 *  here"). The example JSON files stay. */
export function isLeftOut(path: string): boolean {
  return /^examples\/[^/]+\.html$/.test(path);
}

/** the files whose change means the license may have changed */
export const LICENSE_FILES = ["LICENSE", "LICENSE-MIT", "NOTICE"] as const;

const PLUGIN_VERSION = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/;

/** canopy's `.claude-plugin/plugin.json` with its version set, the rest as
 *  it was; throws when it has no version. */
export function writePluginVersion(json: string, version: string): string {
  if (!PLUGIN_VERSION.test(json)) throw new Error("lib/archify/.claude-plugin/plugin.json has no version");
  return json.replace(PLUGIN_VERSION, `$1${version}$3`);
}

/** The x.y.z a package.json names, or null. */
export function packageVersion(json: string): string | null {
  try {
    const pkg: unknown = JSON.parse(json);
    if (typeof pkg !== "object" || pkg === null || !("version" in pkg)) return null;
    const v = pkg.version;
    return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

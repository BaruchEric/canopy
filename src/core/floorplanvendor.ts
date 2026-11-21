/**
 * The pure half of `bun run floorplan:update` (scripts/floorplan-update.ts),
 * which pulls a newer Floorplan release into lib/floorplan and carries
 * canopy's own edits over to it with a three-way merge per file. Here: the
 * pin VENDOR.md holds, the release tags, what to do with each file, the web
 * addresses a release adds, and its changelog's headlines. No I/O.
 * Tested in floorplanvendor.test.ts.
 */

/** where canopy's copy of Floorplan comes from */
export const FLOORPLAN_UPSTREAM = "https://github.com/haydenschmitty/floorplan";

/** the upstream paths canopy keeps, as upstream lays them out (VENDOR.md, "What is here") */
export const FLOORPLAN_KEPT = [".claude-plugin/plugin.json", "LICENSE", "skills/floorplan"] as const;

/** canopy's own files inside lib/floorplan, which a merge never touches */
export const FLOORPLAN_OWN = ["VENDOR.md"] as const;

/** the release and commit lib/floorplan holds */
export interface VendorPin {
  version: string;
  commit: string;
  /** the commit's date, YYYY-MM-DD */
  date: string;
}

const PIN = /at \*\*(\d+\.\d+\.\d+)\*\*, commit `([0-9a-f]{40})` \((\d{4}-\d{2}-\d{2})\)/;

/** The pin in VENDOR.md's first paragraph, or null when the line is gone. */
export function readPin(vendorMd: string): VendorPin | null {
  const m = PIN.exec(vendorMd);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { version: m[1], commit: m[2], date: m[3] };
}

/** VENDOR.md with its pin moved to `pin`; throws when it has no pin line. */
export function writePin(vendorMd: string, pin: VendorPin): string {
  if (!PIN.test(vendorMd)) throw new Error("VENDOR.md has no line naming the release and commit");
  return vendorMd.replace(PIN, `at **${pin.version}**, commit \`${pin.commit}\` (${pin.date})`);
}

const VERSION_CONST = /(export const FLOORPLAN_VERSION = ")(\d+\.\d+\.\d+)(";)/;

/** src/core/floorplan.ts with FLOORPLAN_VERSION set; throws when the line is gone. */
export function writeVersionConst(source: string, version: string): string {
  if (!VERSION_CONST.test(source)) throw new Error("src/core/floorplan.ts has no FLOORPLAN_VERSION line");
  return source.replace(VERSION_CONST, `$1${version}$3`);
}

type Triple = [number, number, number];

function parts(version: string): Triple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Below zero when `a` is the older release. Versions are x.y.z. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a) ?? [0, 0, 0];
  const y = parts(b) ?? [0, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** a release tag and the version it names */
export interface Release {
  tag: string;
  version: string;
}

/** Upstream tags its releases `floorplan--v0.11.0`; a plain `v0.11.0` counts too. */
const RELEASE_TAG = /(?:^|--)v(\d+\.\d+\.\d+)$/;

/** The newest release among tag names, or null when none names one. */
export function newestRelease(tags: readonly string[]): Release | null {
  let best: Release | null = null;
  for (const tag of tags) {
    const version = RELEASE_TAG.exec(tag.trim())?.[1];
    if (version && (!best || compareVersions(version, best.version) > 0)) best = { tag: tag.trim(), version };
  }
  return best;
}

/**
 * What a file needs, from its bytes at the pinned commit (`base`), in
 * canopy (`ours`) and at the new commit (`theirs`); null where it is not.
 * - same: nothing to do
 * - add / take / remove: canopy never changed it, so upstream's goes in
 * - keep: canopy changed it and upstream did not, so canopy's stays
 * - merge: both changed it; a three-way merge carries canopy's edit over
 * - conflict: both changed it and one side removed it, or both added it
 */
export type FileStep = "same" | "add" | "take" | "remove" | "keep" | "merge" | "conflict";

export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function planFile(base: Uint8Array | null, ours: Uint8Array | null, theirs: Uint8Array | null): FileStep {
  if (sameBytes(ours, theirs)) return "same";
  if (sameBytes(ours, base)) {
    if (theirs === null) return "remove";
    return ours === null ? "add" : "take";
  }
  if (sameBytes(base, theirs)) return "keep";
  if (base === null || ours === null || theirs === null) return "conflict";
  return "merge";
}

/** whether bytes look like text: no NUL in the first 8000, as git judges it */
export function isText(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return false;
  return true;
}

const ADDRESS = /https?:\/\/[^\s'"`<>)\]}]+/g;

/** The web addresses in a text, without trailing punctuation, each once. */
export function addressesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ADDRESS)) out.add(m[0].replace(/[.,;:!?]+$/, ""));
  return [...out];
}

/** The addresses `after` holds that `before` did not, sorted. */
export function newAddresses(before: Iterable<string>, after: Iterable<string>): string[] {
  const had = new Set(before);
  return [...new Set(after)].filter((a) => !had.has(a)).sort();
}

/**
 * The changelog's releases after `from` up to and including `to`, newest
 * first, each as its heading and the bold title of each bullet. Upstream's
 * headings read `## 0.11.0 (2026-11-16)` and its bullets `- **Title:** …`.
 */
export function changelogHeadlines(changelog: string, from: string, to: string): string[] {
  const out: string[] = [];
  let keep = false;
  for (const line of changelog.split("\n")) {
    const head = /^## (\d+\.\d+\.\d+)\b/.exec(line);
    if (head?.[1]) {
      keep = compareVersions(head[1], from) > 0 && compareVersions(head[1], to) <= 0;
      if (keep) out.push(line.trim());
      continue;
    }
    if (!keep) continue;
    const title = /^- \*\*(.+?):?\*\*/.exec(line)?.[1];
    if (title) out.push(`  - ${title.replace(/:$/, "")}`);
  }
  return out;
}

import type { ScanResult } from "../core/types";
import { treeLines, type Line, type Seg, type Tone } from "../core/treelines";

const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const paint = (rgb: [number, number, number], s: string): string =>
  useColor ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[0m` : s;

// the canopy palette
export const moss = (s: string): string => paint([147, 201, 139], s);
export const lichen = (s: string): string => paint([217, 179, 107], s);
export const rust = (s: string): string => paint([201, 123, 95], s);
export const sky = (s: string): string => paint([127, 180, 201], s);
export const dim = (s: string): string =>
  useColor ? `\x1b[2m${s}\x1b[0m` : s;
export const bold = (s: string): string =>
  useColor ? `\x1b[1m${s}\x1b[0m` : s;

const TONES: Record<Tone, (s: string) => string> = { moss, lichen, rust, sky, dim, bold };

/** a line of toned segments (core/treelines.ts) as terminal text */
export const paintLine = (line: Line): string =>
  line.map((s: Seg) => (s.tone ? TONES[s.tone](s.text) : s.text)).join("");

export function renderTree(
  result: ScanResult,
  opts: { dirtyOnly?: boolean } = {},
): string {
  return treeLines(result.root, result.repos, opts).map(paintLine).join("\n");
}

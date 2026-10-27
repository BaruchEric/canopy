/** Render checked-in app icons from the favicon SVGs. Only changed SVGs
 * need ImageMagick; builds use the PNGs already under ui/public/icons. */
import { join } from "node:path";

export interface Icon {
  src: "canopy.svg" | "canopy-maskable.svg";
  out: string;
  size: number;
}

export const ICONS: readonly Icon[] = [
  { src: "canopy.svg", out: "canopy-192.png", size: 192 },
  { src: "canopy.svg", out: "canopy-512.png", size: 512 },
  { src: "canopy.svg", out: "canopy-180.png", size: 180 },
  { src: "canopy-maskable.svg", out: "canopy-512-maskable.png", size: 512 },
];

export function magickArgs(dir: string, icon: Icon): string[] {
  return ["-background", "none", "-density", String(3 * icon.size), join(dir, icon.src), "-resize", `${icon.size}x${icon.size}`, "-depth", "8", join(dir, icon.out)];
}

if (import.meta.main) {
  const hint = "scripts/icons.ts needs ImageMagick's magick on PATH (brew install imagemagick); the PNGs are checked in, so only a changed SVG needs it";
  if (!Bun.which("magick")) {
    console.error(hint);
    process.exit(1);
  }
  const dir = join(import.meta.dir, "../ui/public/icons");
  for (const icon of ICONS) {
    const result = Bun.spawnSync(["magick", ...magickArgs(dir, icon)]);
    if (result.exitCode !== 0) {
      console.error(hint);
      console.error(result.stderr.toString());
      process.exit(1);
    }
  }
}

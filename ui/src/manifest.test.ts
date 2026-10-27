import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

test("the install manifest opens the root and every advertised icon matches its PNG", () => {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  if (!isRecord(manifest) || !Array.isArray(manifest["icons"])) throw new Error("invalid app manifest");
  expect(manifest).toMatchObject({ name: "canopy", short_name: "canopy", start_url: "/", scope: "/", display: "standalone", background_color: "#fafbf8", theme_color: "#fafbf8" });
  const icons: unknown[] = manifest["icons"];
  expect(icons).toHaveLength(3);
  for (const value of icons) {
    if (!isRecord(value) || typeof value["src"] !== "string" || typeof value["sizes"] !== "string") throw new Error("invalid icon entry");
    const bytes = readFileSync(new URL(`../public${value["src"]}`, import.meta.url));
    expect(value["type"]).toBe("image/png");
    expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(value["sizes"]);
  }
  expect(icons).toContainEqual({ src: "/icons/canopy-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" });
});

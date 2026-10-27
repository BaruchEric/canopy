import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ICONS } from "../../scripts/icons";

test("every app icon is a small PNG of its advertised dimensions", () => {
  for (const icon of ICONS) {
    const bytes = readFileSync(new URL(`../public/icons/${icon.out}`, import.meta.url));
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([icon.size, icon.size]);
    expect(bytes.length).toBeLessThan(40_000);
  }
});

/**
 * The plugins view's rescan: a backend that fails is said, the rest still
 * scan, and nothing is left to reject unheard.
 */
import { describe, expect, test } from "bun:test";
import { rescanPlugins } from "./Plugins";

describe("rescan", () => {
  test("every backend scans, and one that fails says why by its name", async () => {
    const scanned: string[] = [];
    const scan = async (b: string): Promise<void> => {
      scanned.push(b);
      if (b === "mini") throw new Error("kit scan failed: 502");
    };
    expect(await rescanPlugins(["mac", "mini", "desoto"], scan)).toBe("mini: rescan: kit scan failed: 502");
    expect(scanned).toEqual(["mac", "mini", "desoto"]);
  });

  test("a scan that throws before it returns a promise is said too", async () => {
    const scan = (b: string): Promise<void> => {
      if (b === "mini") throw new Error("no token");
      return Promise.resolve();
    };
    expect(await rescanPlugins(["mac", "mini"], scan)).toBe("mini: rescan: no token");
  });

  test("all green says nothing", async () => {
    expect(await rescanPlugins(["mac"], async () => {})).toBeNull();
  });
});

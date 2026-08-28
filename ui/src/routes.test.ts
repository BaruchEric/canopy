import { describe, expect, test } from "bun:test";
import { parseRoute, popupFeatures } from "./routes";

const features = (w: number, h: number): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const part of popupFeatures({ width: w, height: h }).split(",")) {
    const [k = "", v = ""] = part.split("=");
    if (k !== "popup") out[k] = Number(v);
  }
  return out;
};

describe("parseRoute", () => {
  test("reads the repo and the solo view", () => {
    expect(parseRoute("?repo=web-apps/ripe&view=solo")).toEqual({
      repo: "web-apps/ripe",
      solo: true,
    });
    expect(parseRoute("?repo=web-apps/ripe")).toEqual({
      repo: "web-apps/ripe",
      solo: false,
    });
    // solo needs a repo to be solo about
    expect(parseRoute("?view=solo")).toEqual({ repo: null, solo: false });
    expect(parseRoute("")).toEqual({ repo: null, solo: false });
  });
});

describe("popupFeatures", () => {
  test("takes a wide slice of the screen and all of its usable height", () => {
    const f = features(1512, 945);
    expect(f.width).toBe(832);
    expect(f.height).toBe(945);
    expect(f.left).toBe(340);
    expect(f.top).toBe(0);
  });

  test("stops growing on a very large display", () => {
    const f = features(5120, 2880);
    expect(f.width).toBe(1200);
    expect(f.height).toBe(1500);
  });

  test("never opens a window larger than the screen", () => {
    for (const [w, h] of [
      [1280, 800],
      [800, 600],
      [640, 480],
    ] as const) {
      const f = features(w, h);
      expect(f.width).toBeLessThanOrEqual(w);
      expect(f.height).toBeLessThanOrEqual(h);
      expect(f.left).toBeGreaterThanOrEqual(0);
      expect(f.top).toBeGreaterThanOrEqual(0);
    }
  });
});

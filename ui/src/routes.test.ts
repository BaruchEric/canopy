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
  test("reads a section window's section, when it is one", () => {
    expect(parseRoute("?repo=web-apps/ripe&view=section&section=history").section).toBe("history");
    expect(parseRoute("?repo=web-apps/ripe&view=section&section=shell").section).toBeNull();
    // only a section window names a section
    expect(parseRoute("?repo=web-apps/ripe&view=solo&section=history").section).toBeNull();
    expect(parseRoute("?view=section&section=history").section).toBeNull();
  });
  const none = { repo: null, solo: false, shell: false, term: null, section: null, task: null };
  test("reads the repo and the shell view", () => {
    expect(parseRoute("?repo=web-apps/ripe&view=shell")).toEqual({
      repo: "web-apps/ripe",
      solo: false,
      shell: true,
      term: null,
      section: null,
      task: null,
    });
    expect(parseRoute("?view=shell")).toEqual(none);
  });
  test("a shell window's shell is named in the url, when well formed", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(parseRoute(`?repo=web-apps/ripe&view=shell&term=${id}`).term).toBe(id);
    expect(parseRoute("?repo=web-apps/ripe&view=shell&term=t1").term).toBeNull();
    // another backend's shell carries its name
    expect(parseRoute(`?repo=mini|web-apps/ripe&view=shell&term=mini|${id}`).term).toBe(`mini|${id}`);
    expect(parseRoute(`?repo=x&view=shell&term=Mini|${id}`).term).toBeNull();
    expect(parseRoute(`?repo=x&view=shell&term=a|b|${id}`).term).toBeNull();
    // only a shell window has one shell to name
    expect(parseRoute(`?repo=web-apps/ripe&view=solo&term=${id}`).term).toBeNull();
  });
  test("reads the repo and the solo view", () => {
    expect(parseRoute("?repo=web-apps/ripe&view=solo")).toEqual({
      repo: "web-apps/ripe",
      solo: true,
      shell: false,
      term: null,
      section: null,
      task: null,
    });
    expect(parseRoute("?repo=web-apps/ripe")).toEqual({
      repo: "web-apps/ripe",
      solo: false,
      shell: false,
      term: null,
      section: null,
      task: null,
    });
    // solo needs a repo to be solo about
    expect(parseRoute("?view=solo")).toEqual(none);
    expect(parseRoute("")).toEqual(none);
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

test("a task window names its task", () => {
  const r = parseRoute(`?repo=app&view=shell&term=${"a".repeat(32)}&task=dev`);
  expect(r.term).toBe("a".repeat(32));
  expect(r.task).toBe("dev");
  expect(parseRoute("?repo=app&view=shell&task=Bad").task).toBeNull();
  expect(parseRoute("?repo=app").task).toBeNull();
});

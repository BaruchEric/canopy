import { describe, expect, test } from "bun:test";
import { parseRoute, popupFeatures, runUrl, soloUrl, sproutHere } from "./routes";

const features = (w: number, h: number): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const part of popupFeatures({ width: w, height: h }).split(",")) {
    const [k = "", v = ""] = part.split("=");
    if (k !== "popup") out[k] = Number(v);
  }
  return out;
};

describe("parseRoute", () => {
  test("an agent window: the card it starts on and whether it follows the board", () => {
    expect(parseRoute("?view=agent&card=claude:abc-123&follow=1").agent).toEqual({ card: "claude:abc-123", follow: true });
    expect(parseRoute("?view=agent").agent).toEqual({ card: null, follow: false });
    expect(parseRoute("?view=agent&card=../../x").agent).toEqual({ card: null, follow: false });
    // a repo's views are never an agent window
    expect(parseRoute("?repo=a/b&view=agent").agent).toBeNull();
    expect(parseRoute("?view=agents").agent).toBeNull();
  });

  test("the agents view's ask link, the one the broker's away DM carries", () => {
    expect(parseRoute("?view=agents&ask=6b72e2c4-1f0a-4c1e-9a55-1b8f4f9d2a10").ask).toBe("6b72e2c4-1f0a-4c1e-9a55-1b8f4f9d2a10");
    // only on the agents view, and only an id the broker could have made
    expect(parseRoute("?ask=6b72").ask).toBeNull();
    expect(parseRoute("?view=git&ask=6b72").ask).toBeNull();
    expect(parseRoute("?view=agents&ask=../x").ask).toBeNull();
    expect(parseRoute(`?view=agents&ask=${"a".repeat(65)}`).ask).toBeNull();
  });
  test("reads a section window's section, when it is one", () => {
    expect(parseRoute("?repo=web-apps/ripe&view=section&section=history").section).toBe("history");
    expect(parseRoute("?repo=web-apps/ripe&view=section&section=shell").section).toBeNull();
    // only a section window names a section
    expect(parseRoute("?repo=web-apps/ripe&view=solo&section=history").section).toBeNull();
    expect(parseRoute("?view=section&section=history").section).toBeNull();
  });
  const none = { repo: null, solo: false, shell: false, term: null, section: null, task: null, ask: null, popped: false, agent: null, run: null };
  test("reads the repo and the shell view", () => {
    expect(parseRoute("?repo=web-apps/ripe&view=shell")).toEqual({
      repo: "web-apps/ripe",
      solo: false,
      shell: true,
      term: null,
      section: null,
      task: null,
      ask: null,
      popped: false,
      agent: null,
      run: null,
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
      ask: null,
      popped: false,
      agent: null,
      run: null,
    });
    expect(parseRoute("?repo=web-apps/ripe")).toEqual({
      repo: "web-apps/ripe",
      solo: false,
      shell: false,
      term: null,
      section: null,
      task: null,
      ask: null,
      popped: false,
      agent: null,
      run: null,
    });
    // solo needs a repo to be solo about
    expect(parseRoute("?view=solo")).toEqual(none);
    expect(parseRoute("")).toEqual(none);
  });
});

test("a chat's window names its run, and is popped only when it says so (FR-047)", () => {
  expect(parseRoute("?view=run&run=1a2b3c4d").run).toBe("1a2b3c4d");
  expect(parseRoute("?view=run&run=1a2b3c4d").popped).toBe(false);
  expect(parseRoute("?view=run&run=1a2b3c4d&popped=1").popped).toBe(true);
  // another backend's run carries its name
  expect(parseRoute("?view=run&run=mini|1a2b3c4d").run).toBe("mini|1a2b3c4d");
  expect(parseRoute("?view=run").run).toBeNull();
  expect(parseRoute("?view=run&run=../x").run).toBeNull();
  expect(parseRoute("?view=run&run=").popped).toBe(false);
  // a repo's window is never a chat's
  expect(parseRoute("?repo=a/b&view=run&run=1a2b3c4d").run).toBeNull();
  expect(parseRoute("?view=solo&run=1a2b3c4d").run).toBeNull();
  const g = globalThis as unknown as { window?: unknown };
  g.window = { location: { href: "http://x/" } };
  try {
    const u = new URL(runUrl("1a2b3c4d", { popped: true }));
    expect([u.searchParams.get("view"), u.searchParams.get("run"), u.searchParams.get("popped")]).toEqual(["run", "1a2b3c4d", "1"]);
    expect(parseRoute(u.search)).toMatchObject({ run: "1a2b3c4d", popped: true, repo: null, solo: false });
    expect(parseRoute(new URL(runUrl("1a2b3c4d")).search).popped).toBe(false);
  } finally {
    delete g.window;
  }
});

test("a popped solo window says so in its URL, and only then", () => {
  // soloUrl builds on this window's address, and bun test has no window
  const g = globalThis as unknown as { window?: unknown };
  g.window = { location: { href: "http://x/" } };
  try {
    expect(parseRoute(new URL(soloUrl("a/b", { popped: true }), "http://x").search).popped).toBe(true);
    expect(parseRoute(new URL(soloUrl("a/b"), "http://x").search).popped).toBe(false);
    // the marker means nothing outside a solo window
    expect(parseRoute("?repo=a/b&view=shell&popped=1").popped).toBe(false);
  } finally {
    delete g.window;
  }
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

describe("sproutHere", () => {
  test("the incubator view's sprout, and nothing else", () => {
    expect(sproutHere("?view=incubator&sprout=sp_0123456789ab")).toBe("sp_0123456789ab");
    expect(sproutHere("?view=git&sprout=sp_0123456789ab")).toBeNull();
    expect(sproutHere("?view=incubator&sprout=../x")).toBeNull();
  });
});

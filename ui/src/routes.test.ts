import { describe, expect, test } from "bun:test";
import {
  agentUrl,
  isOwnWindow,
  itemWindow,
  managerHere,
  managerNew,
  managerUrl,
  newKindHere,
  pageUrl,
  parseRoute,
  popupFeatures,
  popupUrl,
  runUrl,
  soloUrl,
  sproutHere,
  viewOf,
} from "./routes";

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
  const none = { repo: null, solo: false, shell: false, term: null, section: null, task: null, ask: null, popped: false, agent: null, run: null, popup: null };
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
      popup: null,
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
      popup: null,
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
      popup: null,
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

describe("a popup's window (FR-084)", () => {
  test("names its popup, and only one the top bar has", () => {
    expect(parseRoute("?view=popup&popup=inbox").popup).toBe("inbox");
    expect(parseRoute("?view=popup&popup=waiting").popup).toBe("waiting");
    expect(parseRoute("?view=popup&popup=weather").popup).toBeNull();
    expect(parseRoute("?view=popup").popup).toBeNull();
    // a repo's window is never a popup's, and neither is another view
    expect(parseRoute("?repo=a/b&view=popup&popup=inbox").popup).toBeNull();
    expect(parseRoute("?view=health&popup=inbox").popup).toBeNull();
  });

  test("is popped only when it says so", () => {
    expect(parseRoute("?view=popup&popup=inbox").popped).toBe(false);
    expect(parseRoute("?view=popup&popup=inbox&popped=1").popped).toBe(true);
    expect(parseRoute("?view=popup&popup=weather&popped=1").popped).toBe(false);
  });
});

test("an agent's window is a dock panel's on one agent, never the board's focus pane", () => {
  expect(parseRoute("?view=agent&card=claude:abc&popped=1").popped).toBe(true);
  expect(parseRoute("?view=agent&card=claude:abc").popped).toBe(false);
  expect(parseRoute("?view=agent&card=claude:abc&follow=1&popped=1").popped).toBe(false);
  expect(parseRoute("?view=agent&popped=1").popped).toBe(false);
});

test("isOwnWindow: a window of one thing, and not the whole page on a view", () => {
  for (const q of [
    "?repo=a/b&view=solo",
    "?repo=a/b&view=shell",
    "?repo=a/b&view=section&section=history",
    "?view=run&run=1a2b3c4d",
    "?view=agent&card=claude:abc",
    "?view=agent&follow=1",
    "?view=popup&popup=tasks",
  ]) {
    expect(isOwnWindow(parseRoute(q))).toBe(true);
  }
  for (const q of ["", "?view=agents", "?repo=a/b", "?view=manager&run=1a2b3c4d", "?view=popup&popup=weather"]) {
    expect(isOwnWindow(parseRoute(q))).toBe(false);
  }
});

describe("an item's window (FR-084)", () => {
  const withWindow = (fn: () => void) => {
    const g = globalThis as unknown as { window?: unknown };
    g.window = { location: { href: "http://x/?view=agents&ask=1#frag" } };
    try {
      fn();
    } finally {
      delete g.window;
    }
  };

  test("each kind's address reads back as that window, with nothing of this page's", () => {
    withWindow(() => {
      expect(agentUrl("claude:abc")).toBe("http://x/?view=agent&card=claude%3Aabc");
      expect(parseRoute(new URL(agentUrl("claude:abc")).search).agent).toEqual({ card: "claude:abc", follow: false });
      expect(parseRoute(new URL(agentUrl("claude:abc", { popped: true })).search).popped).toBe(true);
      expect(popupUrl("tasks")).toBe("http://x/?view=popup&popup=tasks");
      expect(parseRoute(new URL(popupUrl("tasks", { popped: true })).search)).toMatchObject({ popup: "tasks", popped: true });
    });
  });

  test("a plain window and a popped one keep apart by name, so neither takes the other's place", () => {
    withWindow(() => {
      expect(itemWindow({ kind: "run", ref: "r1" })).toEqual({ name: "canopy:run:r1", url: "http://x/?view=run&run=r1", slim: false });
      // the name a chat's popped window had before every item got one
      expect(itemWindow({ kind: "run", ref: "r1" }, true)).toEqual({ name: "canopy:pop:run:r1", url: "http://x/?view=run&run=r1&popped=1", slim: false });
      expect(itemWindow({ kind: "agent", ref: "claude:abc" })?.name).toBe("canopy:agent:claude:abc");
      expect(itemWindow({ kind: "popup", ref: "inbox" })).toEqual({ name: "canopy:popup:inbox", url: "http://x/?view=popup&popup=inbox", slim: true });
      expect(itemWindow({ kind: "popup", ref: "inbox" }, true)?.url).toBe("http://x/?view=popup&popup=inbox&popped=1");
    });
  });

  test("a popup by a name the top bar has not has no window", () => {
    withWindow(() => {
      expect(itemWindow({ kind: "popup", ref: "weather" })).toBeNull();
    });
  });

  test("a view's window is the whole page on that view, the grove with no view named", () => {
    withWindow(() => {
      expect(pageUrl("agents")).toBe("http://x/?view=agents");
      expect(pageUrl("git")).toBe("http://x/");
    });
  });
});

describe("popupFeatures", () => {
  test("a list's window is a column wide, on any screen", () => {
    const slim = (w: number, h: number): number => Number(/width=(\d+)/.exec(popupFeatures({ width: w, height: h }, true))?.[1]);
    expect(slim(1512, 945)).toBe(440);
    expect(slim(2560, 1440)).toBe(640);
    expect(slim(1920, 1080)).toBe(538);
  });

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
  test("the overview's sprout, the incubator's old address too, and nothing else", () => {
    expect(sproutHere("?view=manager&sprout=sp_0123456789ab")).toBe("sp_0123456789ab");
    // the link canopy new prints, from before the incubator joined the manager
    expect(sproutHere("?view=incubator&sprout=sp_0123456789ab")).toBe("sp_0123456789ab");
    expect(sproutHere("?view=git&sprout=sp_0123456789ab")).toBeNull();
    expect(sproutHere("?view=incubator&sprout=../x")).toBeNull();
  });

  test("the incubator's view is the manager's now, and every other view is its own", () => {
    expect(viewOf("incubator")).toBe("manager");
    expect(viewOf("manager")).toBe("manager");
    expect(viewOf("git")).toBe("git");
  });
});

describe("managerHere", () => {
  test("the manager view's run, decoded, and nothing else", () => {
    expect(managerHere("?view=manager&run=mini%7Ced71ddfb")).toBe("mini|ed71ddfb");
    expect(managerHere("?view=manager&run=ed71ddfb")).toBe("ed71ddfb");
    expect(managerHere("?view=manager")).toBeNull();
    expect(managerHere("?view=run&run=ed71ddfb")).toBeNull();
    expect(managerHere("?view=manager&run=../x")).toBeNull();
  });

  test("a manager link is not a chat's window", () => {
    expect(parseRoute("?view=manager&run=mini%7Ced71ddfb").run).toBeNull();
  });
});

describe("managerNew", () => {
  test("the manager view's new box, and nothing else", () => {
    expect(managerNew("?view=manager&new=1")).toBe(true);
    expect(managerNew("?view=manager")).toBe(false);
    expect(managerNew("?view=manager&new=0")).toBe(false);
    expect(managerNew("?view=git&new=1")).toBe(false);
  });

  test("the kind the box starts on, only beside new=1", () => {
    expect(newKindHere("?view=manager&new=1&kind=project")).toBe("project");
    expect(newKindHere("?view=manager&new=1&kind=goal")).toBe("goal");
    expect(newKindHere("?view=manager&new=1")).toBeNull();
    expect(newKindHere("?view=manager&new=1&kind=repo")).toBeNull();
    expect(newKindHere("?view=manager&kind=project")).toBeNull();
  });

  test("the address that opens it", () => {
    // managerUrl builds on this page's path, and bun test has no location
    const g = globalThis as unknown as { location?: unknown };
    g.location = { pathname: "/" };
    try {
      expect(managerUrl(null, { new: true }).endsWith("?view=manager&new=1")).toBe(true);
      expect(managerNew(new URL(managerUrl(null, { new: true }), "http://x").search)).toBe(true);
      expect(managerUrl(null, { new: true, kind: "project" })).toBe("/?view=manager&new=1&kind=project");
      expect(managerUrl(null)).toBe("/?view=manager");
      expect(managerUrl("mini|ed71ddfb")).toBe("/?view=manager&run=mini%7Ced71ddfb");
    } finally {
      delete g.location;
    }
  });
});

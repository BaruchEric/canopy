import { describe, expect, test } from "bun:test";
import {
  EDGE,
  ctxLink,
  ctxSkip,
  ctxSubjects,
  factLabel,
  fuzzy,
  headingInto,
  inTriangle,
  isFact,
  placeAt,
  placeSub,
  placeUnder,
  searchItems,
  stepActive,
  type CtxGroup,
  type CtxNode,
} from "./ctxmenu";

const view = { w: 1000, h: 800 };
const node = (tag: string, cls: string[] = [], attrs: Record<string, string> = {}): CtxNode => ({ tag, cls, attrs });

describe("placeAt", () => {
  test("puts the corner on the point where it fits, growing from that corner", () => {
    expect(placeAt({ x: 100, y: 120 }, { w: 240, h: 300 }, view)).toEqual({ left: 100, top: 120, ox: 0, oy: 0 });
  });
  test("flips left of the point near the right edge and grows from its right", () => {
    const p = placeAt({ x: 900, y: 100 }, { w: 240, h: 300 }, view);
    expect(p.left).toBe(660);
    expect(p.ox).toBe(240);
  });
  test("flips above the point near the bottom", () => {
    const p = placeAt({ x: 100, y: 700 }, { w: 240, h: 300 }, view);
    expect(p.top).toBe(400);
    expect(p.oy).toBe(300);
  });
  test("holds a menu taller than the room 8px inside the window", () => {
    const p = placeAt({ x: 100, y: 400 }, { w: 240, h: 790 }, view);
    expect(p.top).toBe(EDGE);
    const wide = placeAt({ x: 5, y: 10 }, { w: 240, h: 100 }, view);
    expect(wide.left).toBe(EDGE);
  });
});

describe("placeUnder", () => {
  test("drops under the element, or above it with no room below", () => {
    const r = { left: 50, top: 100, right: 250, bottom: 130 };
    expect(placeUnder(r, { w: 200, h: 300 }, view)).toMatchObject({ left: 50, top: 132 });
    const low = { left: 50, top: 600, right: 250, bottom: 630 };
    expect(placeUnder(low, { w: 200, h: 300 }, view).top).toBe(298);
  });
});

describe("placeSub", () => {
  const row = { left: 100, top: 200, right: 340, bottom: 226 };
  const parent = { left: 100, top: 150, right: 340, bottom: 500 };
  test("sits off the parent's right edge, level with its row", () => {
    expect(placeSub(row, parent, { w: 200, h: 150 }, view)).toEqual({ left: 338, top: 196, side: "right" });
  });
  test("goes to the left where the right has no room", () => {
    const far = { left: 700, top: 150, right: 940, bottom: 500 };
    const p = placeSub({ ...row, left: 700, right: 940 }, far, { w: 200, h: 150 }, view);
    expect(p.side).toBe("left");
    expect(p.left).toBe(502);
  });
  test("moves up to stay inside the window", () => {
    const low = { left: 100, top: 760, right: 340, bottom: 786 };
    expect(placeSub(low, parent, { w: 200, h: 150 }, view).top).toBe(800 - 150 - EDGE);
  });
});

describe("the path into a submenu", () => {
  test("inTriangle counts the inside and the edges, not the outside", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    const c = { x: 0, y: 10 };
    expect(inTriangle({ x: 2, y: 2 }, a, b, c)).toBe(true);
    expect(inTriangle({ x: 5, y: 0 }, a, b, c)).toBe(true);
    expect(inTriangle({ x: 8, y: 8 }, a, b, c)).toBe(false);
  });
  const sub = { left: 340, top: 180, right: 540, bottom: 400 };
  test("a diagonal toward an open submenu on the right is on its way", () => {
    expect(headingInto({ x: 200, y: 210 }, { x: 260, y: 240 }, sub, "right")).toBe(true);
  });
  test("moving away, or straight down past it, is not", () => {
    expect(headingInto({ x: 200, y: 210 }, { x: 180, y: 220 }, sub, "right")).toBe(false);
    expect(headingInto({ x: 200, y: 210 }, { x: 201, y: 420 }, sub, "right")).toBe(false);
  });
  test("a submenu on the left is reached leftward", () => {
    const left = { left: 0, top: 180, right: 200, bottom: 400 };
    expect(headingInto({ x: 300, y: 210 }, { x: 260, y: 230 }, left, "left")).toBe(true);
    expect(headingInto({ x: 300, y: 210 }, { x: 320, y: 230 }, left, "left")).toBe(false);
  });
});

describe("fuzzy", () => {
  test("matches characters in order, case and accents aside", () => {
    expect(fuzzy("Bring the project to the front", "bpf")).not.toBeNull();
    expect(fuzzy("Café shell", "cafe")).not.toBeNull();
    expect(fuzzy("copy", "cpx")).toBeNull();
  });
  test("ranks a substring over scattered letters, and a word start over a middle", () => {
    const score = (text: string, q: string) => fuzzy(text, q) ?? -Infinity;
    expect(score("new shell", "shell")).toBeGreaterThan(score("show hell", "shell"));
    expect(score("copy path", "path")).toBeGreaterThan(score("copy xpath", "path"));
  });
  test("an empty query matches everything", () => {
    expect(fuzzy("anything", "  ")).toBe(0);
  });
});

describe("searchItems", () => {
  const run = () => undefined;
  const groups: CtxGroup[] = [
    {
      items: [
        { kind: "run", id: "shell", label: "new shell", run },
        {
          kind: "sub",
          id: "copy",
          label: "copy",
          sub: [
            { kind: "run", id: "copy:path", label: "path", fact: { code: "/u/dev/canopy" }, run },
            { kind: "run", id: "copy:branch", label: "branch", fact: { code: "main" }, run },
            { kind: "run", id: "copy:pr", label: "PR link", off: "none", run },
          ],
        },
      ],
    },
  ];
  test("finds a submenu's rows with the submenu's label in front", () => {
    const hits = searchItems(groups, "copy branch");
    expect(hits[0]?.item.id).toBe("copy:branch");
    expect(hits[0]?.path).toEqual(["copy"]);
  });
  test("never returns a submenu row itself", () => {
    expect(searchItems(groups, "copy").map((h) => h.item.id)).not.toContain("copy");
  });
  test("matches a row's fact", () => {
    expect(searchItems(groups, "main").map((h) => h.item.id)).toEqual(["copy:branch"]);
  });
  test("sorts a dimmed row after the live ones", () => {
    const ids = searchItems(groups, "p").map((h) => h.item.id);
    expect(ids.indexOf("copy:pr")).toBe(ids.length - 1);
  });
});

describe("stepActive", () => {
  test("steps and wraps, skipping dimmed rows", () => {
    const off = (i: number) => i === 1;
    expect(stepActive(4, 0, 1, off)).toBe(2);
    expect(stepActive(4, 3, 1, off)).toBe(0);
    expect(stepActive(4, 2, -1, off)).toBe(0);
  });
  test("starts at the first or the last with nothing active", () => {
    expect(stepActive(3, -1, 1)).toBe(0);
    expect(stepActive(3, -1, -1)).toBe(2);
  });
  test("has nothing to land on when every row is dimmed or there are none", () => {
    expect(stepActive(0, -1, 1)).toBe(-1);
    expect(stepActive(2, 0, 1, () => true)).toBe(-1);
  });
});

describe("ctxSkip", () => {
  const card = [node("span", ["card-name"]), node("article", ["card"], { "data-kb": "repo:a|x" })];
  test("answers a card", () => {
    expect(ctxSkip(card, false)).toBeNull();
  });
  test("Shift always leaves the browser's menu", () => {
    expect(ctxSkip(card, true)).toBe("shift");
  });
  test("leaves text boxes, shells, pictures, the Secrets view and marked things alone", () => {
    expect(ctxSkip([node("input"), ...card], false)).toBe("typing");
    expect(ctxSkip([node("div", [], { contenteditable: "true" })], false)).toBe("typing");
    expect(ctxSkip([node("div", [], { contenteditable: "false" })], false)).toBeNull();
    expect(ctxSkip([node("canvas"), node("div", ["xterm"]), node("div", ["term-view"])], false)).toBe("media");
    expect(ctxSkip([node("div", ["xterm-rows"]), node("div", ["term-view"])], false)).toBe("shell");
    expect(ctxSkip([node("img"), ...card], false)).toBe("media");
    expect(ctxSkip([node("td"), node("section", ["secrets-view"])], false)).toBe("secrets");
    expect(ctxSkip([node("div", [], { "data-native-menu": "" })], false)).toBe("native");
  });
  test("swallows a right-click inside an open menu", () => {
    expect(ctxSkip([node("button", ["menu-item"]), node("div", ["menu"], { role: "menu" })], false)).toBe("menu");
  });
});

describe("ctxSubjects", () => {
  test("a card or a tree row is its repo", () => {
    expect(ctxSubjects([node("span"), node("button", ["tree-item"], { "data-kb": "repo:mac|/u/dev/x" })])).toEqual([{ kind: "repo", id: "mac|/u/dev/x" }]);
  });
  test("a section inside a repo panel names both, innermost first", () => {
    const chain = [
      node("div", ["section-main"]),
      node("section", ["surface"], { "data-section": "changes" }),
      node("div", ["panel-body"]),
      node("section", ["panel", "s-dirty"], { "data-repo": "mac|/r" }),
    ];
    expect(ctxSubjects(chain)).toEqual([
      { kind: "section", key: "changes", repo: "mac|/r" },
      { kind: "panel", id: "mac|/r", head: false },
    ]);
  });
  test("the panel's head is told apart from its body", () => {
    const chain = [node("span", ["panel-name"]), node("header", ["panel-head"]), node("div", ["panel-body"]), node("section", ["panel"], { "data-repo": "r" })];
    expect(ctxSubjects(chain)).toEqual([{ kind: "panel", id: "r", head: true }]);
  });
  test("a dock tab, an inbox row, a trigger row and a board card", () => {
    expect(ctxSubjects([node("div", ["dock-tab"], { "data-id": "r" })])).toEqual([{ kind: "tab", id: "r" }]);
    expect(ctxSubjects([node("li", ["inbox-item"], { "data-kb": "inbox:run:a|1" })])).toEqual([{ kind: "inbox", key: "run:a|1" }]);
    expect(ctxSubjects([node("li", [], { "data-kb": "trigger:mac:e1" })])).toEqual([{ kind: "trigger", id: "mac:e1" }]);
    expect(ctxSubjects([node("article", ["bt"], { "data-card": "c1" })])).toEqual([{ kind: "agent", id: "c1" }]);
  });
  test("an inbox row in the dock's waiting panel is the row, not a repo panel", () => {
    const chain = [node("li", ["inbox-item"], { "data-kb": "inbox:ask:9" }), node("section", ["panel", "waiting-panel"])];
    expect(ctxSubjects(chain)).toEqual([{ kind: "inbox", key: "ask:9" }]);
  });
  test("nothing known is nothing", () => {
    expect(ctxSubjects([node("div"), node("main", ["main"])])).toEqual([]);
  });
});

describe("links and facts", () => {
  test("a web link is offered; a page-internal or script link is not", () => {
    expect(ctxLink([node("span"), node("a", [], { href: "https://github.com/x/y" })])).toBe("https://github.com/x/y");
    expect(ctxLink([node("a", [], { href: "#top" })])).toBeNull();
    expect(ctxLink([node("a", [], { href: "javascript:void 0" })])).toBeNull();
  });
  test("code, a branch and anything marked data-copy are facts", () => {
    expect(isFact(node("code"))).toBe(true);
    expect(isFact(node("span", ["branch"]))).toBe(true);
    expect(isFact(node("span", [], { "data-copy": "abc" }))).toBe(true);
    expect(isFact(node("span", ["card-name"]))).toBe(false);
  });
  test("a fact's label is one line, cut with an ellipsis", () => {
    expect(factLabel("  a\n  b  ")).toBe("a b");
    expect(factLabel("x".repeat(40), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

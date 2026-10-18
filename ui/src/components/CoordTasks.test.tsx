import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoordTask, Run } from "../../../src/core/types";
import { CoordTasks, type CoordLayout } from "./CoordTasks";
import { Console } from "./RunSheet";

const card = (id: string, state: CoordTask["state"], over: Partial<CoordTask> = {}): CoordTask => ({
  id,
  title: `card ${id}`,
  repo: "canopy",
  note: `the note for ${id}`,
  action: "ask",
  state,
  ...over,
});

/** The run seen live on 2026-10-17: four cards, one proposed, two done, one failed. */
const coordinator = (over: Partial<Run> = {}): Run => ({
  id: "c1",
  repoId: "canopy",
  action: "coordinate",
  verb: "Coordinate",
  progress: "idle",
  expectsChange: false,
  chat: true,
  harness: "claude",
  note: "split the work",
  status: "idle",
  startedAt: 1,
  steps: [{ id: "s1", at: 1, kind: "text", text: "I proposed four cards." }],
  prompt: null,
  tasks: [card("t1", "done", { outcome: "landed" }), card("t2", "done", { outcome: "landed" }), card("t3", "failed", { outcome: "failed" }), card("t4", "proposed")],
  ...over,
});

// Bun has no matchMedia; each test that stubs it takes it away again, so
// no later file sees a stub.
const hadMatchMedia = "matchMedia" in globalThis;
const realMatchMedia = globalThis.matchMedia;
afterEach(() => {
  if (hadMatchMedia) globalThis.matchMedia = realMatchMedia;
  else Reflect.deleteProperty(globalThis, "matchMedia");
});

/** useMedia reads matchMedia as it first renders, so this decides the layout. */
function screen(phone: boolean): void {
  globalThis.matchMedia = ((query: string) => ({
    matches: phone,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof globalThis.matchMedia;
}

const sheet = (run: Run): string => renderToStaticMarkup(<Console run={run} repo={undefined} />);

/** Where each part of the sheet starts, -1 when it is not there. */
const parts = (html: string) => ({
  timeline: html.indexOf('class="sheet-body console"'),
  cards: html.indexOf('class="coord-tasks'),
  composer: html.indexOf('class="composer"'),
});

const tag = (html: string, start: string): string => {
  const at = html.indexOf(start);
  return at < 0 ? "" : html.slice(at, html.indexOf(">", at) + 1);
};

describe("a coordinator's sheet, wide", () => {
  test("the timeline, the cards under it with a fold, and the composer", () => {
    screen(false);
    const html = sheet(coordinator());
    const p = parts(html);
    expect(p.timeline).toBeGreaterThan(-1);
    expect(p.cards).toBeGreaterThan(p.timeline);
    expect(p.composer).toBeGreaterThan(p.cards);
    expect(tag(html, '<section class="coord-tasks')).toBe('<section class="coord-tasks" aria-label="The coordinator&#x27;s cards">');
    expect(html).toContain("4 cards · 1 proposed, 2 done, 1 failed");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(">hide cards</button>");
    expect(html).not.toContain("coord-views");
    expect(tag(html, '<ol class="coord-list"')).not.toContain("hidden");
    expect(tag(html, '<div class="composer"')).not.toContain("hidden");
  });

  test("folded, only the head shows, start these still in it", () => {
    const layout: CoordLayout = { kind: "wide", folded: true, onFold: () => {} };
    const html = renderToStaticMarkup(<CoordTasks run={coordinator()} act={async () => {}} layout={layout} />);
    expect(tag(html, '<ol class="coord-list"')).toContain("hidden");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">show cards</button>");
    expect(html).toContain(">start these</button>");
  });

  test("no fold while there are no cards to fold", () => {
    const layout: CoordLayout = { kind: "wide", folded: false, onFold: () => {} };
    const html = renderToStaticMarkup(<CoordTasks run={coordinator({ tasks: [] })} act={async () => {}} layout={layout} />);
    expect(html).toContain("No cards yet.");
    expect(html).not.toContain("aria-expanded");
  });
});

describe("a coordinator's sheet on a phone", () => {
  test("idle with a card proposed, it opens on the cards: no timeline, the composer kept but hidden", () => {
    screen(true);
    const html = sheet(coordinator());
    const p = parts(html);
    expect(p.timeline).toBe(-1);
    expect(tag(html, '<section class="coord-tasks')).toContain('class="coord-tasks phone fill"');
    expect(tag(html, '<ol class="coord-list"')).not.toContain("hidden");
    expect(tag(html, '<div class="composer"')).toContain("hidden");
    expect(html).toContain('<div class="coord-views" role="group" aria-label="Show"><button type="button" class="mini on" aria-pressed="true">cards</button><button type="button" class="mini" aria-pressed="false">chat</button></div>');
    expect(html).not.toContain("aria-expanded");
  });

  test("working on cards already started, it opens on the chat with the cards' head between it and the composer", () => {
    screen(true);
    const run = coordinator({ status: "working", tasks: [card("t1", "running", { run: "k1" }), card("t2", "done", { outcome: "landed" })] });
    const html = sheet(run);
    const p = parts(html);
    expect(p.timeline).toBeGreaterThan(-1);
    expect(p.cards).toBeGreaterThan(p.timeline);
    expect(p.composer).toBeGreaterThan(p.cards);
    expect(tag(html, '<section class="coord-tasks')).toContain('class="coord-tasks phone"');
    expect(tag(html, '<ol class="coord-list"')).toContain("hidden");
    expect(tag(html, '<div class="composer"')).not.toContain("hidden");
    expect(html).toContain('class="mini on" aria-pressed="true">chat</button>');
  });

  test("the cards view shows the sheet's error, since the timeline that holds it is gone", () => {
    const layout: CoordLayout = { kind: "phone", view: "cards", onView: () => {} };
    const html = renderToStaticMarkup(<CoordTasks run={coordinator()} act={async () => {}} layout={layout} error="start refused" />);
    expect(html).toContain('<p class="note err">start refused</p>');
  });

  test("an ended coordinator with no cards shows the timeline alone", () => {
    screen(true);
    const html = sheet(coordinator({ status: "done", tasks: [] }));
    const p = parts(html);
    expect(p.timeline).toBeGreaterThan(-1);
    expect(p.cards).toBe(-1);
  });
});

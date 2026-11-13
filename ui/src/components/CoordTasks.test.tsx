import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoordTask, KitInfo, Loadout, Run } from "../../../src/core/types";
import { api } from "../api";
import { cardDraft, cardEdit } from "../coord";
import { useStore } from "../store";
import { qualify, type Reg } from "../backends";
import { qRun } from "../qualify";
import { CardForm, CoordTasks, FlowButton, HoldButton, StartButton, type CoordLayout } from "./CoordTasks";
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

test("a member without a coordinator still shows its group parent entrypoint in the console", () => {
  screen(false);
  const initial = useStore.getInitialState();
  const prior = initial.landing;
  initial.landing = { "": { runs: [], entries: [], orphans: [], groups: [{ id: "g", repoId: "canopy", repoPath: "/canopy", action: "ask", note: "n", expectedMembers: 2, members: [], state: "working", autoLand: false, startedAt: 1 }] } };
  try {
    const member = coordinator({ id: "member", action: "ask", group: "g", chat: false, tasks: undefined, parent: undefined });
    expect(sheet(member)).toContain("one of 2");
  } finally { initial.landing = prior; }
});

const wide: CoordLayout = { kind: "wide", folded: false, onFold: () => {} };
const list = (run: Run): string => renderToStaticMarkup(<CoordTasks run={run} act={async () => {}} layout={wide} />);
/** every small button's words, in order */
const words = (html: string): string[] => [...html.matchAll(/<button[^>]*class="mini[^"]*"[^>]*>([^<]*)<\/button>/g)].map((m) => (m[1] ?? "").trim());
/** an act that runs the write at once, as the sheet's does */
const now = async (fn: () => Promise<void>): Promise<void> => {
  await fn();
};
/** presses a button a hook-free piece drew */
const press = (el: unknown): void => (el as { props: { onClick: () => void } }).props.onClick();

describe("what a card carries", () => {
  test("the facts line shows its loadout, workflow and after, the detail in the loadout's title", () => {
    const run = coordinator({
      tasks: [card("t1", "done", { outcome: "landed" }), card("t2", "proposed", { equip: { loadout: "feature", model: "sonnet" }, workflow: "review", after: ["t1", "t3"] }), card("t3", "proposed")],
    });
    const html = list(run);
    expect(html).toContain('title="loadout feature; model sonnet">feature, changed</span>');
    expect(html).toContain(">review</span>");
    expect(html).toContain(">after t1, t3</span>");
  });
});

describe("hold and resume", () => {
  test("a held coordinator's head says held and offers resume; one not held offers hold", () => {
    const held = list(coordinator({ held: true }));
    expect(held).toContain(">held</span>");
    expect(words(held)).toContain("resume");
    expect(words(held)).not.toContain("hold");
    const going = list(coordinator());
    expect(words(going)).toContain("hold");
    expect(words(going)).not.toContain("resume");
    expect(going).not.toContain(">held</span>");
  });

  test("a kept coordinator neither holds nor resumes", () => {
    const html = list(coordinator({ held: true, kept: true }));
    expect(words(html)).not.toContain("resume");
    expect(words(html)).not.toContain("hold");
  });

  test("pressing them sends the run and the new hold", () => {
    const calls: [string, boolean][] = [];
    const prior = useStore.getState().coordHold;
    useStore.setState({ coordHold: async (runId, held) => void calls.push([runId, held]) });
    try {
      press(HoldButton({ run: coordinator(), act: now }));
      press(HoldButton({ run: coordinator({ held: true }), act: now }));
      expect(calls).toEqual([
        ["c1", true],
        ["c1", false],
      ]);
    } finally {
      useStore.setState({ coordHold: prior });
    }
  });
});

describe("starting one card", () => {
  test("a proposed card has start; a queued one is edited or removed, and has none", () => {
    const run = coordinator({ tasks: [card("t1", "proposed"), card("t2", "queued", { outcome: "waits for t1", after: ["t1"] }), card("t3", "running", { run: "k3" })] });
    const html = list(run);
    expect(words(html).filter((w) => w === "start")).toHaveLength(1);
    expect(words(html).filter((w) => w === "edit")).toHaveLength(2);
    expect(words(html).filter((w) => w === "remove")).toHaveLength(2);
    // a coordinator that ended starts nothing
    expect(words(list({ ...run, status: "done" }))).not.toContain("start");
  });

  test("start calls the store with the run and that card alone", () => {
    const calls: [string, string[] | undefined][] = [];
    const prior = useStore.getState().coordStart;
    useStore.setState({ coordStart: async (runId, ids) => void calls.push([runId, ids]) });
    try {
      const run = coordinator();
      const task = run.tasks?.[3];
      if (!task) throw new Error("the fixture lost its proposed card");
      press(StartButton({ run, task, act: now }));
      expect(calls).toEqual([["c1", ["t4"]]]);
    } finally {
      useStore.setState({ coordStart: prior });
    }
  });
});

describe("a card's flow", () => {
  test("a card running a flow, or settled from one, offers open its flow; a card with a run offers open its run", () => {
    const run = coordinator({ tasks: [card("t1", "running", { flow: "f1", branch: "b1", workflow: "review" }), card("t2", "done", { outcome: "ready", flow: "f2", branch: "b2", workflow: "review" }), card("t3", "proposed")] });
    const w = words(list(run));
    expect(w.filter((x) => x === "open its flow")).toHaveLength(2);
    expect(w).not.toContain("open its run");
  });

  test("open its flow opens the flow sheet by the card's qualified id", () => {
    const reg: Reg = { home: "mini", names: ["mini", "mac"] };
    const coord = qRun((id) => qualify(reg, "mac", id), coordinator({ tasks: [card("t1", "running", { flow: "f1", branch: "b1", workflow: "review" })] }));
    const task = coord.tasks?.[0];
    if (!task) throw new Error("the fixture lost its card");
    const opened: string[] = [];
    const prior = useStore.getState().showFlow;
    useStore.setState({ showFlow: (id) => void opened.push(id) });
    try {
      press(FlowButton({ task }));
      expect(opened).toEqual(["mac|f1"]);
    } finally {
      useStore.setState({ showFlow: prior });
    }
  });
});

describe("the card's form", () => {
  const lo = (name: string, model = "default"): Loadout => ({ name, note: `for ${name}`, harness: "claude", model, effort: "default", skills: [], mcp: [], canopyTools: false });
  const kit: KitInfo = { ok: true, error: null, machines: [], cells: [], loadouts: { base: [], loadouts: [lo("feature"), lo("docs", "sonnet")], errors: [], servers: [] } };
  /** renders with the kit's loadouts in the store, as the page holds them */
  function form(task: CoordTask): string {
    const initial = useStore.getInitialState();
    const prior = initial.kit;
    initial.kit = { "": kit };
    try {
      return renderToStaticMarkup(<CardForm run={coordinator()} task={task} act={async () => {}} onDone={() => {}} />);
    } finally {
      initial.kit = prior;
    }
  }
  const options = (html: string, label: string): string[] => {
    const at = html.indexOf(`aria-label="${label}"`);
    if (at < 0) return [];
    const body = html.slice(at, html.indexOf("</select>", at));
    return [...body.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1] ?? "");
  };

  test("a proposed card's form offers a loadout, none first, a workflow and an after field", () => {
    const html = form(card("t4", "proposed", { after: ["t1"] }));
    expect(options(html, "Loadout")).toEqual(["no loadout", "feature", "docs (sonnet)"]);
    expect(options(html, "Workflow")[0]).toBe("no workflow");
    expect(html).toMatch(/<input [^>]*aria-label="After"[^>]*value="t1"\/>/);
    expect(html).toContain('aria-label="Card title"');
  });

  test("a queued card's form offers only its loadout and after", () => {
    const html = form(card("t2", "queued", { equip: { loadout: "docs" } }));
    expect(options(html, "Loadout")).toEqual(["no loadout", "feature", "docs (sonnet)"]);
    expect(html).toContain('aria-label="After"');
    expect(html).not.toContain('aria-label="Card title"');
    expect(html).not.toContain('aria-label="Workflow"');
    expect(html).not.toContain('aria-label="What the run is told"');
  });

  test("saving sends the loadout as equip and the ids as after", async () => {
    const task = card("t4", "proposed");
    const change = cardEdit(task, { ...cardDraft(task), loadout: "feature", after: "t1 t3" });
    expect(change).toEqual({ equip: { loadout: "feature" }, after: ["t1", "t3"] });
    const realFetch = globalThis.fetch;
    const sent: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    try {
      await api.coordTask("c1", "t4", change);
      await api.coordTask("c1", "t4", { equip: null, after: null, workflow: null });
      await api.coordStart("c1", ["t4"]);
      await api.coordStart("c1");
      await api.coordHold("c1", true);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent).toEqual([
      { url: "/api/coordinator/tasks", body: { run: "c1", id: "t4", equip: { loadout: "feature" }, after: ["t1", "t3"] } },
      { url: "/api/coordinator/tasks", body: { run: "c1", id: "t4", equip: null, after: null, workflow: null } },
      { url: "/api/coordinator/start", body: { run: "c1", ids: ["t4"] } },
      { url: "/api/coordinator/start", body: { run: "c1" } },
      { url: "/api/coordinator/hold", body: { run: "c1", held: true } },
    ]);
  });
});

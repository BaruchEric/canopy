// Drives a running canopy page the way a person would and says what broke:
// the first load (what comes with the page, what is fetched once it is up),
// every view from its URL and by switching inside one page, the runs pill's
// menu with two runs going, a shell that answers, the two load failures
// (a view's chunk and xterm's refused), a phone: the top bar's first row
// on the screen, an open panel's section tabs, and no field small enough for
// iOS to zoom the page onto, and the manager's top view: a goal that ended,
// a goal going on a desktop, a tablet and a phone with its equip sheet, and
// the new goal's box at 1440 and 390px, opened from its address and from the
// top bar.
// check.sh starts a scratch server and runs this; it copies the file into
// the browser folder first, where "playwright" resolves.
//   check.ts <base url> <screenshot folder>
import { mkdirSync } from "node:fs";
import type { Page } from "playwright";
import { launch } from "./launch.ts";

const [base, shots] = process.argv.slice(2);
if (!base || !shots) {
  console.error("usage: check.ts <base url> <screenshot folder>");
  process.exit(2);
}
mkdirSync(shots, { recursive: true });

const VIEWS = ["library", "ports", "sessions", "agents", "manager", "incubator", "health", "costs", "triggers", "clock", "work", "kit", "secrets"];
/** the chunks the page loads on demand, by the name vite gives each */
const LAZY = ["Sessions", "Secrets", "Kit", "Costs", "Triggers", "Clock", "Library", "AgentsView", "ManagerView", "Incubator", "Work", "xterm"];

const browser = await launch();
const failures: string[] = [];
const notes: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

/** a phone held upright, with a finger for a pointer */
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

/** a page of its own; `block` refuses that chunk, with the service worker
 *  off, since a fetch the worker makes passes the page's routes by. `routed`
 *  turns the worker off for a page that sets routes of its own, and `phone`
 *  makes the page a phone's. */
async function fresh(block?: string, routed = Boolean(block), phone = false): Promise<Page> {
  const page = await browser.newPage({ ...(phone ? PHONE : { viewport: { width: 1400, height: 900 } }), ...(routed ? { serviceWorkers: "block" as const } : {}) });
  if (block) await page.route(`**/assets/${block}-*.js`, (r) => r.abort());
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") notes.push(`console${block ? ` (${block} refused)` : ""}: ${m.text().slice(0, 160)}`);
  });
  return page;
}

const textOf = async (page: Page, sel: string) => (await page.locator(sel).innerText()).replace(/\s+/g, " ").trim();

/** the fields on the page a finger types into whose text is under 16px, where iOS zooms the page */
const smallFields = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="submit"], [type="button"], [type="color"], [type="hidden"]), textarea, select')]
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/).join(".")}` : ""} ${getComputedStyle(el).fontSize}`),
  );

/** the buttons on the screen under `sel`: how many (`seen`, so a selector
 *  that matches nothing, or buttons all hidden, cannot pass for none short)
 *  and those less than a finger (44px) tall, each as "class 'words' 30px" */
const shortButtons = (page: Page, sel: string) =>
  page.evaluate((sel) => {
    const shown = [...document.querySelectorAll<HTMLElement>(`${sel} button`)].filter((el) => el.getClientRects().length > 0);
    const short = shown
      .filter((el) => el.getBoundingClientRect().height < 43.5)
      .map((el) => `${el.className || "button"} '${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 24)}' ${Math.round(el.getBoundingClientRect().height)}px`);
    return { seen: shown.length, short };
  }, sel);

async function openShell(page: Page) {
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 20_000 });
  // the demo card (the sidebar lists it first) opens its panel, where the shells are
  await page.locator(".app-view").getByText("demo", { exact: true }).last().click();
  await page.getByRole("button", { name: "New shell" }).first().click({ timeout: 15_000 });
}

try {
  {
    const page = await fresh();
    // when .app first exists, on the page's own clock: the chunks come in the
    // first idle moment, which on a slow box falls before `load`, since the
    // fonts hold that back, so a time taken after it counts them as the page's
    await page.addInitScript(() => {
      new MutationObserver((_, watch) => {
        if (!document.querySelector(".app")) return;
        document.documentElement.dataset["upAt"] = String(performance.now());
        watch.disconnect();
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.waitForSelector(".app", { timeout: 20_000 });
    await page.waitForTimeout(7000);
    const { up, js } = await page.evaluate(() => ({
      up: Number(document.documentElement.dataset["upAt"]),
      js: performance.getEntriesByType("resource").filter((e) => e.name.endsWith(".js"))
        .map((e) => ({ name: e.name.split("/").pop()!.replace(/-[A-Za-z0-9_-]{8}\.js$/, ""), at: e.startTime })),
    }));
    const before = js.filter((j) => j.at <= up).map((j) => j.name);
    const after = js.filter((j) => j.at > up).map((j) => j.name);
    check(!LAZY.some((n) => before.includes(n)), `the page loads without the on-demand chunks (with it: ${before.join(" ")})`);
    check(LAZY.every((n) => after.includes(n)), `once it is up it fetches them all (${after.join(" ")})`);
    await page.screenshot({ path: `${shots}/board.png` });
    await page.close();
  }

  for (const v of VIEWS) {
    const page = await fresh();
    await page.goto(`${base}/?view=${v}`, { waitUntil: "load" });
    await page.waitForSelector(".app-view", { timeout: 20_000 });
    await page.waitForTimeout(1000);
    const text = await textOf(page, ".app-view");
    // a view the page does not know shows the board, which has text too; a
    // view of its own has the plain nav over it, not the board's top bar
    const own = (await page.locator("header.app-nav").count()) > 0;
    check(
      own && text.length > 0 && !text.includes("could not load") && !text.startsWith("Loading…"),
      `${v} opens from its URL: ${own ? `"${text.slice(0, 60)}"` : "the page shows the board instead"}`,
    );
    await page.screenshot({ path: `${shots}/${v}.png` });
    await page.close();
  }

  {
    const page = await fresh();
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.waitForSelector(".app", { timeout: 20_000 });
    const seen: string[] = [];
    for (const v of ["agents", "work", "kit", "sessions", "git"]) {
      // what the view tabs do: a new URL, then the popstate the app listens for
      await page.evaluate((view) => {
        const url = new URL(location.href);
        if (view === "git") url.searchParams.delete("view");
        else url.searchParams.set("view", view);
        history.pushState(null, "", url);
        dispatchEvent(new PopStateEvent("popstate"));
      }, v);
      await page.waitForTimeout(800);
      const text = await textOf(page, ".app");
      if (text.includes("could not load") || text.includes("Loading…")) seen.push(v);
    }
    check(seen.length === 0, `switching views inside one page${seen.length ? `: stuck on ${seen.join(", ")}` : ""}`);
    await page.close();
  }

  {
    // A phone. Three things broke here unseen until 2026-11-09: the top
    // bar's first row ran past the right edge, an open panel's section tabs
    // were squeezed to no height, and fields under 16px made iOS zoom the
    // page. 344px is a folded phone's cover screen, the narrowest the bar is
    // fitted to; at 280px the row has more than it can hold, which is the
    // owner's full row of chips at 390px, and it has to wrap, not run off.
    // A scratch server has no voice model, so /api/voice is answered here:
    // the mic is the row's widest button. The panel is twin's, which
    // check.sh leaves with work in it.
    const page = await fresh(undefined, true, true);
    await page.route("**/api/voice", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { model: "check", live: null, dictate: false } }) : r.continue()));
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.waitForSelector(".topbar.phone", { timeout: 20_000 });
    for (const width of [390, 344, 280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(500);
      const row = await page.evaluate(() => {
        const edge = document.documentElement.clientWidth;
        const past = [...document.querySelectorAll<HTMLElement>(".topbar.phone > .tb-line:first-child :is(button, a)")]
          .filter((el) => el.getClientRects().length > 0)
          .filter((el) => el.getBoundingClientRect().right > edge + 0.5 || el.getBoundingClientRect().left < -0.5)
          .map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.className);
        return { past, wider: document.documentElement.scrollWidth - edge, buttons: document.querySelectorAll(".topbar.phone > .tb-line:first-child :is(button, a)").length };
      });
      check(
        row.buttons > 3 && row.past.length === 0 && row.wider <= 0,
        `at ${width}px the top bar's first row keeps its ${row.buttons} buttons on the screen${row.past.length ? ` (past the edge: ${row.past.join(", ")})` : ""}${row.wider > 0 ? ` (the page is ${row.wider}px wider than the screen)` : ""}`,
      );
    }
    await page.setViewportSize(PHONE.viewport);
    await page.screenshot({ path: `${shots}/phone.png` });
    await page.goto(`${base}/?repo=twin`, { waitUntil: "load" });
    const rail = page.locator(".section-rail").first();
    const shown = await rail.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    await page.waitForTimeout(800);
    const height = shown ? ((await rail.boundingBox())?.height ?? 0) : 0;
    const tabs = shown ? await rail.locator('[role="tab"]').count() : 0;
    check(height >= 24 && tabs > 1, `on a phone an open panel shows its section tabs (${tabs} tabs in a rail ${Math.round(height)}px tall)`);
    const small = await smallFields(page);
    check(small.length === 0, `with a finger for a pointer no field is under 16px, where iOS zooms the page${small.length ? `: ${[...new Set(small)].join(", ")}` : ""}`);
    await page.screenshot({ path: `${shots}/phone-panel.png` });
    await page.close();
  }

  {
    // The runs pill with two runs going. A scratch server has no agent to
    // run, so the two are made up, one per repo, and /api/runs is answered
    // here. The older chat is the one a click on the pill never reached
    // while it opened the newest run itself.
    const page = await fresh(undefined, true);
    const tree = (await (await page.request.get(`${base}/api/tree`)).json()) as { repos: { id: string; name: string }[] };
    const run = (id: string, repo: string, extra: Record<string, unknown>) => ({
      id,
      repoId: tree.repos.find((r) => r.name === repo)?.id ?? repo,
      action: "chat",
      verb: "chat",
      progress: "thinking",
      expectsChange: false,
      chat: true,
      harness: "claude",
      note: "",
      status: "working",
      startedAt: Date.now() - 20_000,
      steps: [],
      prompt: null,
      ...extra,
    });
    const runs = [run("check-new", "demo", {}), run("check-old", "twin", { status: "idle", startedAt: Date.now() - 12 * 60_000, note: "the older chat" })];
    await page.route("**/api/runs", (r) => (r.request().method() === "GET" ? r.fulfill({ json: runs }) : r.continue()));
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.waitForSelector(".pill.runs", { timeout: 20_000 });
    const word = await textOf(page, ".pill.runs");
    await page.locator(".pill.runs").click();
    const rows = page.locator('.runs-pick [role="radio"]');
    await rows.first().waitFor({ timeout: 5000 }).catch(() => undefined);
    const listed = (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    check(
      word === "2 claude runs" && listed.length === 2 && (listed[0]?.startsWith("demo") ?? false) && (listed[1]?.startsWith("twin") ?? false),
      `the runs pill lists two runs, a row each: "${word}" opens "${listed.join('", "')}"`,
    );
    // the menu settles in over 140ms; the picture waits for it
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/runs-pill.png` });
    const sheet = listed.length === 2
      ? await rows.nth(1).click().then(() => page.waitForSelector(".sheet-back", { timeout: 5000 })).then((e) => e.innerText(), () => "")
      : "";
    check(sheet.includes("twin") && sheet.includes("the older chat"), `a pick opens that run and not the newest: "${sheet.replace(/\s+/g, " ").trim().slice(0, 60)}"`);
    await page.close();
  }

  {
    // A goal that ended (FR-065). check.sh keeps a coordinator in the run
    // log: it answers by its id and has left /api/runs, and the view says
    // the goal ended and lists the goals going, never a blank page.
    const page = await fresh();
    const kept = await page.request.get(`${base}/api/runs/check-ended`);
    const record = kept.ok() ? ((await kept.json()) as { action?: string; kept?: boolean }) : null;
    const listed = (await (await page.request.get(`${base}/api/runs`)).json()) as { id: string }[];
    await page.goto(`${base}/?view=manager&run=check-ended`, { waitUntil: "load" });
    await page.waitForSelector(".mgr-view", { timeout: 20_000 });
    await page.waitForTimeout(1000);
    const text = await textOf(page, ".mgr-view");
    check(
      record?.action === "coordinate" && record.kept === true && !listed.some((r) => r.id === "check-ended") && text.startsWith("This goal has ended") && text.includes("No coordinator is running"),
      `a coordinator kept in the run log (${kept.status()}, ${record ? "kept" : "not found"}) opens as ended: "${text.slice(0, 80)}"`,
    );
    await page.screenshot({ path: `${shots}/manager-ended.png` });
    await page.close();
  }

  {
    // A goal going, on a desktop, a tablet and a phone. A scratch server
    // runs no coordinator, so the goal is made up and /api/runs, /api/flows,
    // /api/kit and the skills list are answered here, as the runs pill's
    // check answers /api/runs: a coordinator asking a question, with three
    // cards, t1 a flow parked at its review gate, t2 queued after t1 and t3
    // proposed, and three loadouts for the equip sheet.
    const asker = await fresh();
    const tree = (await (await asker.request.get(`${base}/api/tree`)).json()) as { repos: { id: string; name: string }[] };
    await asker.close();
    const repo = (name: string) => tree.repos.find((r) => r.name === name)?.id ?? name;
    const now = Date.now();
    const ago = (min: number) => now - min * 60_000;
    const base0 = { verb: "ask", progress: "", expectsChange: true, chat: false, harness: "claude", note: "", prompt: null };
    const step = (id: string, at: number, kind: string, text: string) => ({ id, at, kind, text });
    const coordinator = {
      ...base0,
      id: "check-coord",
      repoId: repo("demo"),
      action: "coordinate",
      verb: "coordinate",
      chat: true,
      expectsChange: false,
      status: "waiting",
      startedAt: ago(42),
      agentSettings: { harness: "claude", model: "opus", effort: "high" },
      steps: [
        step("c1", ago(42), "user", "Give the check page a manager section: a goal at three widths, its equip sheet, and a goal that ended"),
        step("c2", ago(40), "text", "Three cards: the spec first, then the page, and t3 reads the copy on a phone once you start it."),
      ],
      prompt: {
        id: "q1",
        kind: "question",
        questions: [{ question: "Should t3 wait for t2 to land, or start beside it?", header: "Order", multiSelect: false, options: [{ label: "wait for t2", description: "t3 starts once t2 has landed" }, { label: "beside it", description: "t3 starts as soon as you start it" }] }],
      },
      tasks: [
        { id: "t1", title: "Write the spec for the check page", repo: repo("twin"), note: "Name what each check proves.", action: "ask", state: "running", flow: "check-flow", workflow: "spec", branch: "check-s1", equip: { loadout: "feature" } },
        { id: "t2", title: "Build the page the spec asks for", repo: repo("demo"), note: "Build what t1's spec says.", action: "ask", state: "queued", after: ["t1"], equip: { loadout: "quick", model: "sonnet" } },
        { id: "t3", title: "Read the copy aloud on a phone", repo: repo("demo"), note: "Every label in plain words.", action: "propose", state: "proposed", files: ["shot.png", "the-copy-to-read-aloud-on-a-phone-every-label-in-plain-words.md"] },
      ],
    };
    const branch = { name: "canopy/t1-spec", target: "main", base: "0000000", dir: "/tmp/check-t1", origin: "check-s1", state: "working" };
    const stepRun = (id: string, name: string, start: number, end: number) => ({
      ...base0,
      id,
      repoId: repo("twin"),
      action: "spec",
      verb: "spec",
      status: "done",
      startedAt: start,
      endedAt: end,
      flowStep: { workflow: "spec", step: name, source: "bundled" },
      agentSettings: { harness: "claude", model: "sonnet", effort: "medium" },
      branch,
      steps: [step(`${id}-1`, end, "text", name === "Draft" ? "Drafted the spec: six checks, one per view." : "Two questions stay open in the spec.")],
    });
    const runs = [coordinator, stepRun("check-s1", "Draft", ago(30), ago(22)), stepRun("check-s2", "Review", ago(22), ago(12))];
    const flows = [
      {
        id: "check-flow",
        repoId: repo("twin"),
        workflow: "spec",
        verb: "spec",
        note: "Name what each check proves.",
        status: "gated",
        current: 1,
        startedAt: ago(30),
        branch,
        steps: [
          { name: "Draft", status: "passed", runId: "check-s1" },
          { name: "Review", status: "gated", runId: "check-s2", reason: "Two questions stay open; answer them before Fill." },
          { name: "Fill", status: "pending" },
        ],
      },
    ];
    const loadout = (name: string, note: string, model: string, effort: string, skills: string[], mcp: string[]) => ({ name, note, harness: "claude", model, effort, skills, mcp, canopyTools: false });
    const kit = {
      ok: true,
      error: null,
      machines: [],
      cells: [],
      loadouts: {
        base: [],
        errors: [],
        loadouts: [
          loadout("quick", "A small change: a typo, a rename, one test", "haiku", "low", [], []),
          loadout("feature", "A change across a few files, with its tests", "sonnet", "medium", ["check-copy"], ["github"]),
          loadout("deep", "A change that needs a plan first", "opus", "high", ["check-copy", "check-phone"], ["github", "linear"]),
        ],
        servers: [
          { name: "github", here: true },
          { name: "linear", here: false },
        ],
      },
    };
    const skill = (name: string, description: string, plugin?: string) => ({ name, kind: "skill", harness: "claude", from: plugin ? `plugin:${plugin.split("@")[0]}` : "user", description, ...(plugin ? { plugin } : {}) });
    const mentions = [
      skill("check-copy", "Reads a page's words for plain English"),
      skill("check-phone", "Drives a page at a phone's width"),
      skill("superpowers:brainstorming", "Turns an idea into a design before any code", "superpowers@claude-plugins-official"),
    ];
    const goalPage = async (width: number): Promise<Page> => {
      const phone = width <= 390;
      const page = await fresh(undefined, true, phone);
      if (!phone) await page.setViewportSize({ width, height: 900 });
      const get = (path: string, json: unknown) => page.route((u) => u.pathname === path, (r) => (r.request().method() === "GET" ? r.fulfill({ json }) : r.continue()));
      await get("/api/runs", runs);
      await get("/api/flows", flows);
      await get("/api/kit", kit);
      await get("/api/repos/mentions", mentions);
      return page;
    };
    // the fewest buttons each phone check must see before "none is short"
    // means anything (the goal above showed 28, 21 and 16 on 2026-11-13)
    const WORKERS_BUTTONS = 20;
    const CHAT_BUTTONS = 15;
    const SHEET_BUTTONS = 10;
    const settle = async (page: Page) => {
      await page.waitForSelector(".mgr-view .mgr-head", { timeout: 20_000 });
      await page.waitForTimeout(1200);
    };

    // with no goal named and one going, the view opens it and names it in the address
    let at = "";
    {
      const page = await goalPage(1440);
      await page.goto(`${base}/?view=manager`, { waitUntil: "load" });
      await settle(page);
      at = await page.evaluate(() => location.search);
      const rows = await page.evaluate(() => ({
        rings: document.querySelectorAll(".mgr-ring").length,
        needs: document.querySelectorAll(".mgr-need").length,
        lanes: document.querySelectorAll(".mgr-lane").length,
        // wide: the chat sits beside the column of needs and workers
        beside: (document.querySelector(".mgr-chat")?.getBoundingClientRect().left ?? 0) >= (document.querySelector(".mgr-main")?.getBoundingClientRect().right ?? Infinity) - 1,
      }));
      const head = await textOf(page, ".mgr-head");
      check(
        at.includes("run=check-coord") && head.startsWith("Give the check page") && rows.rings === 4 && rows.needs === 3 && rows.lanes === 3 && rows.beside,
        `at 1440px the one goal going opens (${at}): ${rows.rings} rings, ${rows.needs} things that need you, ${rows.lanes} lanes, the chat ${rows.beside ? "beside them" : "not beside them"}`,
      );
      const files = await textOf(page, "#mgr-lane-t3 .mgr-files");
      check(files.startsWith("files: shot.png, the-copy-to-read-aloud"), `at 1440px a card's lane names the goal's files it takes: "${files.slice(0, 48)}"`);
      await page.screenshot({ path: `${shots}/manager-1440.png` });
      await page.close();
    }
    {
      const page = await goalPage(900);
      await page.goto(`${base}/${at}`, { waitUntil: "load" });
      await settle(page);
      const order = await page.evaluate(() => {
        const top = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().top ?? -1;
        return { rings: top(".mgr-rings"), needs: top(".mgr-needs"), workers: top(".mgr-workers"), chat: top(".mgr-chat"), wider: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      check(
        order.rings < order.needs && order.needs < order.workers && order.workers < order.chat && order.wider <= 0,
        `at 900px one column: rings, needs you, workers, then the chat${order.wider > 0 ? ` (the page is ${order.wider}px wider than the screen)` : ""}`,
      );
      // the view scrolls inside itself, so the workers and the chat need a picture of their own
      await page.screenshot({ path: `${shots}/manager-900.png` });
      await page.evaluate(() => document.querySelector(".mgr-workers")?.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: `${shots}/manager-900-workers.png` });
      await page.close();
    }
    {
      const page = await goalPage(390);
      await page.goto(`${base}/${at}`, { waitUntil: "load" });
      await settle(page);
      const fit = await page.evaluate(() => {
        const view = document.querySelector<HTMLElement>(".mgr-view");
        const strip = document.querySelector<HTMLElement>(".mgr-ring-row");
        const needs = document.querySelector('section[aria-label="needs you"]');
        const rings = document.querySelector('section[aria-label="rings"]');
        return {
          page: document.documentElement.scrollWidth,
          view: view ? view.scrollWidth - view.clientWidth : -1,
          strip: strip ? strip.scrollWidth - strip.clientWidth : 0,
          first: Boolean(needs && rings && needs.compareDocumentPosition(rings) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
      });
      check(
        fit.page <= 390 && fit.view <= 0 && fit.strip > 0 && fit.first,
        `at 390px needs you comes ${fit.first ? "before" : "after"} the rings, the rings scroll sideways in their own strip (${fit.strip}px more), and the page is ${fit.page}px wide${fit.view > 0 ? ` (the view hides ${fit.view}px)` : ""}`,
      );
      // a long file name is cut on one line, never wider than the lane
      const chip = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>("#mgr-lane-t3 .mgr-files");
        const lane = document.querySelector<HTMLElement>("#mgr-lane-t3");
        return el && lane ? { right: el.getBoundingClientRect().right, lane: lane.getBoundingClientRect().right, cut: el.scrollWidth > el.clientWidth } : null;
      });
      check(chip !== null && chip.right <= chip.lane + 0.5 && chip.cut, `at 390px a card's files chip stays inside its lane${chip ? ` (${Math.round(chip.right)}px of ${Math.round(chip.lane)}px${chip.cut ? ", cut" : ""})` : ": no chip"}`);
      await page.locator("#mgr-lane-t3").screenshot({ path: `${shots}/manager-390-files.png` });
      // the view's root is .mgr-view; there is no .mgr, so a selector on that would see no button at all
      const workers = await shortButtons(page, ".mgr-view");
      check(
        workers.seen >= WORKERS_BUTTONS && workers.short.length === 0,
        `at 390px every button with the workers showing is a finger tall (${workers.seen} of them, at least ${WORKERS_BUTTONS} wanted)${workers.short.length ? `: ${workers.short.join(", ")}` : ""}`,
      );
      const fields = await smallFields(page);
      await page.screenshot({ path: `${shots}/manager-390.png` });
      await page.evaluate(() => document.querySelector(".mgr-rings")?.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: `${shots}/manager-390-workers.png` });
      await page.locator(".mgr-switch").getByRole("button", { name: "chat" }).click();
      await page.waitForTimeout(500);
      const chat = await shortButtons(page, ".mgr-view");
      check(
        chat.seen >= CHAT_BUTTONS && chat.short.length === 0,
        `at 390px every button with the chat showing is a finger tall (${chat.seen} of them, at least ${CHAT_BUTTONS} wanted)${chat.short.length ? `: ${chat.short.join(", ")}` : ""}`,
      );
      fields.push(...(await smallFields(page)));
      await page.screenshot({ path: `${shots}/manager-390-chat.png` });
      await page.locator(".mgr-switch").getByRole("button", { name: "workers" }).click();
      await page.locator("#mgr-lane-t3").getByRole("button", { name: "equip" }).click();
      const sheet = page.locator(".mgr-equip");
      const open = await sheet.waitFor({ timeout: 5000 }).then(() => true, () => false);
      await page.waitForTimeout(800);
      const box = open ? await sheet.boundingBox() : null;
      const picks = open ? await sheet.locator(".mgr-equip-pick").count() : 0;
      const skills = open ? await sheet.locator('section[aria-label="skills"] .mgr-equip-opt').count() : 0;
      check(
        open && Math.round(box?.width ?? 0) === 390 && Math.round(box?.height ?? 0) === 844 && picks === 3 && skills === 3,
        `at 390px t3's equip sheet fills the screen (${Math.round(box?.width ?? 0)} by ${Math.round(box?.height ?? 0)}) with ${picks} loadouts and ${skills} skills`,
      );
      const inSheet = await shortButtons(page, ".mgr-equip");
      check(
        inSheet.seen >= SHEET_BUTTONS && inSheet.short.length === 0,
        `at 390px every button in the equip sheet is a finger tall (${inSheet.seen} of them, at least ${SHEET_BUTTONS} wanted)${inSheet.short.length ? `: ${inSheet.short.join(", ")}` : ""}`,
      );
      fields.push(...(await smallFields(page)));
      check(fields.length === 0, `at 390px no field in the manager view is under 16px, where iOS zooms the page${fields.length ? `: ${[...new Set(fields)].join(", ")}` : ""}`);
      await page.screenshot({ path: `${shots}/manager-390-equip.png` });
      await page.close();
    }

    // The new goal's box (FR-067). `?view=manager&new=1` shows it focused over
    // the goals going, and the one goal going, which the plain address opens,
    // stays shut. A scratch server runs no coordinator, so its about is
    // answered here as one that does, which gives the box its backend, model
    // and effort. Typing `@de` offers the repo demo, a pick writes it, and a
    // small PNG attached shows as a chip. Start goal is never pressed.
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const composerPage = async (width: number): Promise<Page> => {
      const page = await goalPage(width);
      await page.route(
        (u) => u.pathname === "/api/about",
        async (r) => {
          const res = await r.fetch();
          await r.fulfill({ response: res, json: { ...(await res.json()), coordinator: true } });
        },
      );
      return page;
    };
    for (const width of [1440, 390]) {
      const page = await composerPage(width);
      await page.goto(`${base}/?view=manager&new=1`, { waitUntil: "load" });
      const box = page.locator(".mgr-new textarea");
      await box.waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1200);
      const state = await page.evaluate(() => ({
        search: location.search,
        focused: document.activeElement instanceof HTMLTextAreaElement && document.activeElement.closest(".mgr-new") !== null,
        on: document.querySelector(".mgr-new-on")?.textContent?.trim() ?? "",
        goals: document.querySelectorAll(".mgr-goal-row").length,
        line: document.querySelector(".mgr-new-from")?.textContent?.trim() ?? "",
      }));
      check(
        state.focused && !state.search.includes("run=") && state.goals === 1 && state.on.startsWith("runs on ") && state.line.endsWith("coordinate route)"),
        `at ${width}px ?view=manager&new=1 shows the new goal's box ${state.focused ? "focused" : "not focused"} over ${state.goals} goal going and stays there (${state.search}); "${state.on}", "${state.line}"`,
      );
      await box.pressSequentially("Tidy the READMEs in @de");
      const rows = page.locator(".mgr-new .mention-menu .mention-name");
      const menu = await rows.first().waitFor({ timeout: 5000 }).then(() => true, () => false);
      const names = menu ? await rows.allInnerTexts() : [];
      check(names.includes("demo"), `at ${width}px typing @de offers the repo demo (${names.join(", ") || "no rows"})`);
      await page.screenshot({ path: `${shots}/manager-new-${width}-menu.png` });
      await page.keyboard.press("Enter");
      const text = await box.inputValue();
      check(text === "Tidy the READMEs in @demo ", `at ${width}px a pick writes the repo into the box: "${text}"`);
      await page.locator('.mgr-new input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
      const chip = page.locator(".mgr-new-file");
      const chipped = await chip.first().waitFor({ timeout: 5000 }).then(() => true, () => false);
      const chipText = chipped ? await textOf(page, ".mgr-new-file") : "";
      const start = page.locator(".mgr-new").getByRole("button", { name: "start goal" });
      const on = await start.isEnabled();
      check(chipped && chipText.includes("shot.png") && on, `at ${width}px an attached PNG shows as a chip ("${chipText}") and start goal is ${on ? "on" : "off"}`);
      const fit = await page.evaluate(() => {
        const view = document.querySelector<HTMLElement>(".mgr-view");
        return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, view: view ? view.scrollWidth - view.clientWidth : -1 };
      });
      check(fit.page <= 0 && fit.view <= 0, `at ${width}px the page with the new goal's box has no side scroll${fit.page > 0 || fit.view > 0 ? ` (${Math.max(fit.page, fit.view)}px past the edge)` : ""}`);
      if (width <= 390) {
        // the chip's remove, attach and start goal
        const buttons = await shortButtons(page, ".mgr-new");
        check(buttons.seen >= 3 && buttons.short.length === 0, `at 390px every button in the new goal's box is a finger tall (${buttons.seen} of them)${buttons.short.length ? `: ${buttons.short.join(", ")}` : ""}`);
        const fields = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".mgr-new textarea, .mgr-new select")]
            .filter((el) => el.getClientRects().length > 0)
            .map((el) => ({ what: `${el.tagName.toLowerCase()} '${el.getAttribute("aria-label") ?? ""}'`, h: el.getBoundingClientRect().height })),
        );
        const low = fields.filter((f) => f.h < 43.5).map((f) => `${f.what} ${Math.round(f.h)}px`);
        check(fields.length >= 3 && low.length === 0, `at 390px every field in the new goal's box is a finger tall (${fields.length} of them)${low.length ? `: ${low.join(", ")}` : ""}`);
        const small = await smallFields(page);
        check(small.length === 0, `at 390px no field with the new goal's box is under 16px, where iOS zooms the page${small.length ? `: ${[...new Set(small)].join(", ")}` : ""}`);
      }
      await page.screenshot({ path: `${shots}/manager-new-${width}.png` });
      await page.close();
    }
    {
      // the top bar's entry: from the board, its "new goal" opens the box focused
      const page = await composerPage(1440);
      await page.goto(`${base}/`, { waitUntil: "load" });
      await page.locator(".topbar button.new-goal").click({ timeout: 20_000 });
      const shown = await page.locator(".mgr-new textarea").waitFor({ timeout: 15_000 }).then(() => true, () => false);
      await page.waitForTimeout(800);
      const state = await page.evaluate(() => ({
        search: location.search,
        focused: document.activeElement instanceof HTMLTextAreaElement && document.activeElement.closest(".mgr-new") !== null,
      }));
      check(shown && state.focused && state.search === "?view=manager&new=1", `the top bar's new goal opens the box ${state.focused ? "focused" : "not focused"} (${state.search})`);
      await page.close();
    }
  }

  {
    const page = await fresh();
    await openShell(page);
    await page.waitForSelector(".xterm >> visible=true", { timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.locator(".xterm:visible").first().click();
    await page.keyboard.type("echo canopy-$((40+2))\n");
    const answered = await page
      .waitForFunction(() => [...document.querySelectorAll(".xterm-rows")].some((r) => r.textContent?.includes("canopy-42")), null, { timeout: 15_000 })
      .then(() => true, () => false);
    check(answered, "a new shell loads xterm and answers a command");
    await page.screenshot({ path: `${shots}/shell.png` });
    await page.close();
  }

  {
    const page = await fresh("Kit");
    await page.goto(`${base}/?view=kit`, { waitUntil: "load" });
    await page.waitForSelector(".app-view", { timeout: 20_000 });
    await page.waitForTimeout(1500);
    const text = await textOf(page, ".app-view");
    const reload = await page.getByRole("button", { name: "reload" }).count();
    check(text.includes("This view could not load") && reload === 1, "a view whose chunk is refused says so and offers a reload");
    await page.screenshot({ path: `${shots}/kit-refused.png` });
    await page.close();
  }

  {
    const page = await fresh("xterm");
    await openShell(page);
    const said = await page
      .waitForSelector('.term-view:not([hidden]) [role="alert"]', { timeout: 15_000 })
      .then((e) => e.textContent(), () => null);
    check(said?.includes("the terminal could not load") ?? false, `a shell whose xterm is refused says so: "${said?.slice(0, 60) ?? ""}"`);
    await page.screenshot({ path: `${shots}/xterm-refused.png` });
    await page.close();
  }
} catch (err) {
  failures.push(`the check stopped: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
} finally {
  await browser.close();
}

if (notes.length) {
  console.log(`\nconsole errors, not counted (a scratch server has no broker, so /api/registry and /api/asks answer 503):`);
  for (const n of new Set(notes)) console.log(`  ${n}`);
}
console.log(`\n${failures.length ? `${failures.length} failed:\n  ${failures.join("\n  ")}` : "every check passed"}; screenshots in ${shots}`);
process.exit(failures.length ? 1 : 0);

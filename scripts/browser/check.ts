// Drives a running canopy page the way a person would and says what broke:
// the first load (what comes with the page, what is fetched once it is up),
// every view from its URL and by switching inside one page, the runs pill's
// menu with two runs going, the prompt rail of a chat of twelve messages (its
// ticks, a card, a click, the keys from an empty message box and not from a
// draft, and a phone's bar), a side question asked from a run's box (its
// line, the ask, the thread beside the run and, on a phone, over it), a
// shell that answers, the two load failures
// (a view's chunk and xterm's refused), a phone: the top bar's first row
// on the screen, an open panel's section tabs, and no field small enough for
// iOS to zoom the page onto, and the manager: a goal kept in the run log
// opening as ended; a live goal with five cards at 1440, 900 and 390px, its
// equip sheet on a phone, a card's files chip cut inside its lane, and a
// tree card's lane and a project card's lane whose project opens the sheet
// over the goal; the overview with one goal and a project; and the new box at
// 1440 and 390px on a goal (its @ menu, a file's chip) and on a project (the
// words and chip kept, and at 1440 start project sending the form), opened
// from its address, the command line's new and the top bar's + new.
// It drives a right-click's "open in its own window" (FR-084): a repo's panel
// popped out and back, "waiting on you" in a window of its list, a window
// that offers none of itself, a repo's row opened from that list, the view's
// own window, and a phone's copy.
// It also drives the level (FR-079): at intermediate the quiet top bar in
// one row with its menu, a turn's commands folded in a run's timeline and
// the start box, which opens on a new worktree where the checkout is in
// use; at advanced the two rows, every step and the pre-flight;
// the board grouped by state at both; and the bar's rows on a phone at each.
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

const VIEWS = ["library", "ports", "sessions", "agents", "manager", "health", "costs", "triggers", "clock", "work", "kit", "secrets", "people"];
/** the chunks the page loads on demand, by the name vite gives each */
const LAZY = ["Sessions", "Secrets", "Kit", "Costs", "Triggers", "Clock", "Library", "AgentsView", "ManagerView", "Work", "People", "xterm"];

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

/** a manager lane's stage strip: its labels, the ones cut short (wider than
 *  their segment), and how many rows it takes */
const stripOf = (page: Page, lane: string) =>
  page.evaluate((lane) => {
    const segs = [...document.querySelectorAll<HTMLElement>(`${lane} .mgr-steps .step-seg`)];
    return {
      labels: segs.map((el) => el.textContent?.trim() ?? ""),
      cut: segs.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => `${el.textContent?.trim() ?? ""} (${el.clientWidth} of ${el.scrollWidth}px)`),
      rows: new Set(segs.map((el) => Math.round(el.getBoundingClientRect().top))).size,
    };
  }, lane);

/** "t5's 8 stages ... on 2 rows": what a strip check says, with what was cut */
const stripWords = (who: string, strip: { labels: string[]; cut: string[]; rows: number }) =>
  `${who}'s ${strip.labels.length} steps (${strip.labels.join(", ")}) read whole on ${strip.rows} ${strip.rows === 1 ? "row" : "rows"}${strip.cut.length ? `; cut: ${strip.cut.join(", ")}` : ""}`;

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
    // section tabs are the advanced panel's; this new browser opened on
    // intermediate, whose guided panel has none
    await page.evaluate(() => localStorage.setItem("canopy.settings", JSON.stringify({ level: "advanced", onboarded: true })));
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
    // The level (FR-079), which a new browser has at intermediate: the quiet
    // top bar in one row with its menu, a turn's commands folded in a run's
    // timeline, and one start box in place of the pre-flight. Then the same
    // page at advanced: every chip in two rows, every step, the pre-flight's
    // dialog. The board is grouped by state at both. The run is made up, as
    // the runs pill's are, and the tree says the backend has claude: a
    // scratch server has none, which switches a card's jobs off.
    const probe = await fresh(undefined, true);
    const tree = (await (await probe.request.get(`${base}/api/tree`)).json()) as { repos: { id: string; name: string }[] };
    await probe.close();
    const now = Date.now();
    const tool = (id: string, ago: number, title: string) => ({ id, at: now - ago, kind: "tool", tool: { name: "Bash", title, status: "ok", output: "ok" } });
    const runs = [
      {
        id: "level-chat",
        repoId: tree.repos.find((r) => r.name === "demo")?.id ?? "demo",
        action: "chat",
        verb: "chat",
        progress: "replying",
        expectsChange: false,
        chat: true,
        harness: "claude",
        note: "",
        status: "idle",
        startedAt: now - 120_000,
        prompt: null,
        steps: [
          { id: "l1", at: now - 100_000, kind: "user", text: "Does the build pass?" },
          tool("l2", 98_000, "git status"),
          tool("l3", 90_000, "bun run build"),
          tool("l4", 62_000, "ls dist/web"),
          { id: "l5", at: now - 58_000, kind: "text", text: "The build passes." },
        ],
      },
    ];
    /** the lines the top bar's visible controls sit on: two controls whose
     *  middles are within 12px of each other share a line, whatever the
     *  fonts of the machine do to a pixel */
    const barRows = (page: Page) =>
      page.evaluate(() => {
        const mids: number[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(".topbar button, .topbar a, .topbar input")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const mid = r.top + r.height / 2;
          if (!mids.some((m) => Math.abs(m - mid) < 12)) mids.push(mid);
        }
        return mids.length;
      });
    const at = async (level: "intermediate" | "advanced", phone = false, prep?: (page: Page) => Promise<void>) => {
      const page = await fresh(undefined, true, phone);
      await page.addInitScript((saved) => localStorage.setItem("canopy.settings", JSON.stringify(saved)), { level, onboarded: true, sort: "state" });
      await page.route("**/api/runs", (r) => (r.request().method() === "GET" ? r.fulfill({ json: runs }) : r.continue()));
      await page.route("**/api/tree", async (r) => {
        if (r.request().method() !== "GET") return r.continue();
        const res = await r.fetch();
        const body = (await res.json()) as { backend?: Record<string, unknown> };
        return r.fulfill({ response: res, json: { ...body, backend: { ...body.backend, harnesses: ["claude"] } } });
      });
      // last, so its routes run before the ones above
      if (prep) await prep(page);
      await page.goto(`${base}/`, { waitUntil: "load" });
      await page.waitForSelector(".card", { timeout: 20_000 });
      await page.waitForTimeout(500);
      return page;
    };
    const lines = (page: Page) =>
      page.evaluate(() => [...document.querySelectorAll(".sheet-back .steps > li")].map((li) => [...li.classList].find((c) => c.startsWith("k-")) ?? ""));

    {
      // a new browser opens on intermediate and keeps it after a reload: the
      // page writes its layout as it loads, which once made the next load
      // take it for a browser from before levels and drop it on advanced
      const page = await fresh();
      await page.goto(`${base}/`, { waitUntil: "load" });
      await page.waitForSelector(".card", { timeout: 20_000 });
      await page.waitForTimeout(1500);
      const first = await page.locator(".bar-more-btn").count();
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector(".card", { timeout: 20_000 });
      await page.waitForTimeout(500);
      const again = await page.locator(".bar-more-btn").count();
      check(first === 1 && again === 1, `a new browser opens on the quiet page and keeps it after a reload (its more menu ${first ? "there" : "missing"}, then ${again ? "there" : "missing"})`);
      await page.close();
    }

    for (const level of ["intermediate", "advanced"] as const) {
      const quiet = level === "intermediate";
      const page = await at(level);
      const groups = await page.evaluate(() =>
        [...document.querySelectorAll(".grid-group")].map((g) => `${g.querySelector(".head-toggle")?.textContent?.trim().match(/^(needs you|working|unread|idle)/)?.[0] ?? "?"}: ${[...g.querySelectorAll(".card-name")].map((n) => n.textContent).join(",")}`),
      );
      check(groups.join(" | ") === "unread: demo | idle: twin", `at ${level} the board grouped by state reads "${groups.join(" | ")}"`);

      const rows = await barRows(page);
      const more = page.locator(".bar-more-btn");
      if (quiet) {
        check(rows === 1 && (await more.count()) === 1, `at intermediate the top bar is one row with its menu at its end (${rows} rows)`);
        await more.click();
        const picks = page.locator('.bar-more [role="radio"]');
        await picks.first().waitFor({ timeout: 4000 }).catch(() => undefined);
        const names = (await picks.allInnerTexts()).map((t) => t.split("\n")[0]?.trim() ?? "");
        check(names.length >= 10 && names.some((n) => n.startsWith("live runs")) && names.includes("select repos"), `the bar's menu lists each chip by name: ${names.length}, among them "${names.slice(0, 3).join('", "')}"`);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${shots}/level-bar-menu.png` });
        // a pick does what the chip does, and a chip with something to say is on the bar
        await picks.filter({ hasText: "select repos" }).click();
        await page.waitForTimeout(400);
        const shown = await page.evaluate(() => document.querySelector('[data-tuck="select"]')?.classList.contains("quiet") === false);
        // x is the chip's own key, and it still works with the chip put away
        await page.keyboard.press("x");
        await page.waitForTimeout(400);
        const away = await page.evaluate(() => document.querySelector('[data-tuck="select"]')?.classList.contains("quiet") === true);
        check(shown && away, `a pick of select repos starts the picking and brings its chip to the bar (${shown}); x ends it and the chip leaves (${away})`);
        // a list opened from the menu by the keys closes on Escape, its chip
        // leaves the bar, and the focus goes back to the menu's button
        await more.focus();
        await page.keyboard.press("Enter");
        const grouping = page.locator('.bar-more [role="radio"]', { hasText: "grouping" }).first();
        await grouping.waitFor({ timeout: 4000 }).catch(() => undefined);
        await grouping.focus();
        await page.keyboard.press("Enter");
        const opened = await page.waitForSelector('[data-tuck="sort"] [aria-expanded="true"]', { timeout: 4000 }).then(() => true, () => false);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        const back = await page.evaluate(() => document.activeElement?.classList.contains("bar-more-btn") === true);
        check(opened && back, `the grouping opened from the menu by the keys (${opened}) hands the focus back to the menu's button on Escape (${back})`);
      } else {
        check(rows === 2 && (await more.count()) === 0, `at advanced the top bar keeps its two rows and has no menu of the rest (${rows} rows)`);
      }
      await page.screenshot({ path: `${shots}/level-${level}.png` });

      // the timeline: one turn of three commands between a message and the reply
      await page.locator(".card", { has: page.locator(".card-name", { hasText: /^demo$/ }) }).first().locator(".card-more button").first().click();
      await page.locator('[role="menuitem"].live').first().click();
      await page.waitForSelector(".sheet-back .steps", { timeout: 5000 });
      const got = await lines(page);
      if (quiet) {
        const fold = page.locator(".sheet-back .fold-line");
        const says = (await fold.first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        await fold.first().click();
        const opened = await lines(page);
        await fold.first().click();
        const folded = await lines(page);
        check(
          got.join(" ") === "k-user k-fold k-text" && says === "worked for 40s · 3 steps" && opened.filter((k) => k === "k-tool").length === 3 && folded.join(" ") === got.join(" "),
          `at intermediate a turn's commands fold into one line, "${says}", that a click opens and a second folds (${got.join(" ")}; open: ${opened.join(" ")})`,
        );
        // a fold left open stays open when the sheet closes and opens again
        await fold.first().click();
        await page.keyboard.press("Escape");
        await page.waitForSelector(".sheet-back", { state: "detached", timeout: 5000 }).catch(() => undefined);
        await page.locator(".card", { has: page.locator(".card-name", { hasText: /^demo$/ }) }).first().locator(".card-more button").first().click();
        await page.locator('[role="menuitem"].live').first().click();
        await page.waitForSelector(".sheet-back .steps", { timeout: 5000 });
        const again = await lines(page);
        await page.locator(".sheet-back .fold-line").first().click();
        check(again.filter((k) => k === "k-tool").length === 3, `a fold left open is open when the run's sheet opens again (${again.join(" ")})`);
      } else {
        check(got.join(" ") === "k-user k-tool k-tool k-tool k-text", `at advanced the timeline shows every step (${got.join(" ")})`);
      }
      await page.screenshot({ path: `${shots}/level-${level}-timeline.png` });
      await page.keyboard.press("Escape");
      await page.waitForSelector(".sheet-back", { state: "detached", timeout: 5000 }).catch(() => undefined);

      // the start: ask on twin
      const card = page.locator(".card", { has: page.locator(".card-name", { hasText: /^twin$/ }) }).first();
      await card.locator(".card-more button").first().click();
      await page.locator('[role="menuitem"]', { hasText: "ask the agent" }).first().click();
      await page.waitForSelector(".sheet-back .sheet", { timeout: 5000 });
      await page.waitForTimeout(400);
      if (quiet) {
        const chips = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".start-box .start-chip")].map((c) => `${c.dataset["chip"]}${c.tagName === "BUTTON" ? " (menu)" : ""}: ${c.textContent?.trim()}`));
        const focused = await page.evaluate(() => document.activeElement?.classList.contains("start-words") === true);
        check(
          chips.length === 4 && chips[0] === "repo: twin" && chips[1] === "branch (menu): main" && (chips[2]?.startsWith("backend: ") ?? false) && (chips[3]?.startsWith("agent") ?? false) && focused,
          `at intermediate a start is one box with its chips and the focus in its words: ${chips.join(" | ")}`,
        );
        await page.locator('.start-pick[data-chip="branch"]').click();
        await page.locator(".start-menu [role=menuitemradio]").nth(1).click();
        const branch = (await page.locator('.start-chip[data-chip="branch"]').innerText()).trim();
        await page.locator(".start-words").fill("count the parts");
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${shots}/level-${level}-start.png` });
        await page.locator(".start-more").click();
        const kept = await page.evaluate(() => `${document.querySelector<HTMLTextAreaElement>(".sheet-body.plan .plan-note")?.value} / ${document.querySelector<HTMLInputElement>(".plan-branch input[type=checkbox]")?.checked}`);
        check(branch === "new worktree" && kept === "count the parts / true", `the branch chip's menu picks a new worktree ("${branch}"), and more options opens the pre-flight with the words and the pick kept (${kept})`);
        // and fewer options goes back to the box with both
        await page.locator(".sheet-foot .start-fewer").click();
        const boxed = await page.waitForSelector(".start-box", { timeout: 5000 }).then(() => true, () => false);
        const backWords = boxed ? await page.locator(".start-words").inputValue() : "";
        const backBranch = boxed ? (await page.locator('.start-chip[data-chip="branch"]').innerText()).trim() : "";
        check(boxed && backWords === "count the parts" && backBranch === "new worktree", `fewer options goes back to the box with the words and the pick kept ("${backWords}", ${backBranch || "no box"})`);
        // a checkout in use (FR-080): demo holds the chat, so a start there
        // opens on a worktree of its own and the box says why
        await page.keyboard.press("Escape");
        await page.waitForSelector(".sheet-back", { state: "detached", timeout: 5000 }).catch(() => undefined);
        const busy = page.locator(".card", { has: page.locator(".card-name", { hasText: /^demo$/ }) }).first();
        await busy.locator(".card-more button").first().click();
        await page.locator('[role="menuitem"]', { hasText: "ask the agent" }).first().click();
        await page.waitForSelector(".start-box", { timeout: 5000 });
        const own = (await page.locator('.start-chip[data-chip="branch"]').innerText()).trim();
        const why = await page.locator(".sheet .start-note").allInnerTexts();
        check(own === "new worktree" && why.length === 1 && (why[0]?.startsWith("This checkout is in use") ?? false), `on a checkout in use the box opens on a new worktree and says why ("${own}": ${why.join(" | ")})`);
        await page.screenshot({ path: `${shots}/level-${level}-start-busy.png` });
      } else {
        const plan = await page.evaluate(() => `${document.querySelectorAll(".sheet-body.plan .plan-note").length} ${document.querySelectorAll(".start-box").length}`);
        check(plan === "1 0", `at advanced a start is the pre-flight's dialog and no box (${plan})`);
        await page.screenshot({ path: `${shots}/level-${level}-start.png` });
      }
      await page.close();
    }

    // a phone at intermediate: two rows where the advanced bar takes three
    for (const level of ["intermediate", "advanced"] as const) {
      const page = await at(level, true);
      const rows = await barRows(page);
      const want = level === "intermediate" ? 2 : 3;
      const more = level === "intermediate" ? await page.locator(".bar-more-btn").boundingBox() : null;
      check(rows === want && (level === "advanced" || (more !== null && more.x + more.width <= 390)), `on a phone at ${level} the top bar takes ${rows} rows${level === "intermediate" ? ", its menu on the screen" : ""}`);
      if (level === "intermediate") await page.screenshot({ path: `${shots}/level-phone.png` });
      await page.close();
    }

    // A second backend the page cannot reach. Where the bar hides the
    // backends' names (under 940px) it counts them instead, and the quiet
    // bar's menu names each with its state: a phone once saw only "mini
    // connected" there and took the other backends for missing.
    const twoBackends = async (page: Page) => {
      await page.route(`${base}/api/backends`, async (r) => {
        const res = await r.fetch();
        const body = (await res.json()) as { self: string; backends: { name: string }[] };
        return r.fulfill({ response: res, json: { ...body, backends: [...body.backends, { name: "far", tailnet: "http://127.0.0.1:9" }] } });
      });
      // far answers nothing, not even the made-up runs the level's page routes for every host
      await page.route("http://127.0.0.1:9/**", (r) => r.abort("connectionrefused"));
    };
    const chipOf = (page: Page) =>
      page.evaluate(() => {
        const btn = document.querySelector<HTMLElement>(".topbar .backend-btn");
        const shown = (sel: string) => [...(btn?.querySelectorAll<HTMLElement>(sel) ?? [])].filter((el) => el.getClientRects().length > 0);
        const count = shown(".backend-count")[0];
        return {
          names: shown(".backend-names .backend-tag").map((el) => el.textContent ?? ""),
          count: count?.textContent ?? "",
          rust: count?.classList.contains("offline") ?? false,
          title: btn?.title ?? "",
        };
      });
    for (const [level, phone] of [["advanced", true], ["advanced", false], ["intermediate", true]] as const) {
      const page = await at(level, phone, twoBackends);
      await page.waitForTimeout(1500);
      const where = `${phone ? "on a phone" : "at 1400px"} at ${level}`;
      if (level === "advanced") {
        const chip = await chipOf(page);
        const named = /far (not connected|connecting)/.test(chip.title);
        if (phone) {
          check(chip.count === "2" && chip.rust && chip.names.length === 0 && named, `${where} the backend chip counts the two backends in rust in place of their names (${chip.count || "no count"}${chip.rust ? ", rust" : ""}; names ${chip.names.join(" ") || "hidden"}; tooltip ${named ? "names far" : `"${chip.title.replace(/\n/g, " | ")}"`})`);
          await page.screenshot({ path: `${shots}/backends-phone.png` });
        } else {
          check(chip.count === "" && chip.names.length === 2 && chip.names[1] === "far", `${where} the backend chip names both backends and shows no count (${chip.names.join(" ")}${chip.count ? `; count ${chip.count}` : ""})`);
          // narrowed to a Fold's open screen, wider than a phone: the bar drops the names for the count
          await page.setViewportSize({ width: 830, height: 900 });
          await page.waitForTimeout(400);
          const narrow = await chipOf(page);
          check(narrow.count === "2" && narrow.rust && narrow.names.length === 0, `narrowed to 830px at advanced the backend chip counts the two backends where it named them (${narrow.count || "no count"}; names ${narrow.names.join(" ") || "hidden"})`);
          await page.screenshot({ path: `${shots}/backends-830.png` });
        }
      } else {
        const onBar = await page.evaluate(() => document.querySelector('[data-tuck="backend"]')?.classList.contains("quiet") === false);
        await page.locator(".bar-more-btn").click();
        const row = page.locator('.bar-more [role="radio"]').filter({ hasText: /^backend/ });
        await row.first().waitFor({ timeout: 4000 }).catch(() => undefined);
        const said = (await row.first().innerText().catch(() => "")).split("\n").map((l) => l.trim()).find((l) => l.includes("connect")) ?? "";
        check(onBar && /connected, far (not connected|connecting)$/.test(said), `${where} the backend chip is on the bar while far is down (${onBar}), and the menu names both backends: "${said}"`);
        await page.screenshot({ path: `${shots}/backends-phone-menu.png` });
      }
      await page.close();
    }
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

  // A side question (FR-077). A scratch server has no agent whose session
  // could be forked, so the run is made up and /api/runs/side is answered
  // here with the chat the server would start. A message that opens with
  // btw raises the box's line and goes to the side route, never to the run,
  // and the thread shows beside the run on a wide sheet and over it, with a
  // way back, on a phone.
  for (const phone of [false, true]) {
    const where = phone ? "on a phone" : "at 1400px";
    const page = await fresh(undefined, true, phone);
    const tree = (await (await page.request.get(`${base}/api/tree`)).json()) as { repos: { id: string; name: string }[] };
    const repoId = (name: string) => tree.repos.find((r) => r.name === name)?.id ?? name;
    const question = "what does retryBackoff default to?";
    const going = {
      id: "check-par",
      repoId: repoId("demo"),
      action: "ask",
      verb: "Ask",
      progress: "working",
      expectsChange: false,
      chat: false,
      harness: "claude",
      name: "migrate the billing checkout",
      note: "Migrate the billing checkout",
      status: "working",
      session: "check-session",
      startedAt: Date.now() - 60_000,
      steps: [{ id: "p1", at: Date.now() - 50_000, kind: "text", text: "Reading the checkout module." }],
      prompt: null,
    };
    const thread = {
      ...going,
      id: "check-side",
      action: "chat",
      verb: "chat",
      chat: true,
      name: "what does retryBackoff default to",
      note: question,
      status: "idle",
      startedAt: Date.now(),
      sideOf: { run: going.id, title: going.name },
      steps: [
        { id: "s1", at: Date.now(), kind: "user", text: question },
        { id: "s2", at: Date.now(), kind: "text", text: "500 ms, doubling up to 8 s." },
      ],
    };
    const runs: unknown[] = [going, { ...going, id: "check-twin", repoId: repoId("twin"), name: "another run", steps: [] }];
    const sent: string[] = [];
    await page.route("**/api/runs", (r) => (r.request().method() === "GET" ? r.fulfill({ json: runs }) : r.continue()));
    await page.route("**/api/runs/side", async (r) => {
      const body = r.request().postDataJSON() as { id?: string; text?: string };
      sent.push(`side ${body.id}: ${body.text}`);
      runs.push(thread);
      await r.fulfill({ status: 201, json: thread });
    });
    await page.route("**/api/runs/say", async (r) => {
      sent.push("say");
      await r.fulfill({ status: 404, json: { error: "no such run" } });
    });
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.waitForSelector(".pill.runs", { timeout: 20_000 });
    await page.locator(".pill.runs").click();
    const rows = page.locator('.runs-pick [role="radio"]');
    await rows.first().waitFor({ timeout: 5000 }).catch(() => undefined);
    const at = (await rows.allInnerTexts()).findIndex((t) => t.includes("demo"));
    const sheet = page.locator(".sheet-back .sheet");
    const opened = at >= 0 ? await rows.nth(at).click().then(() => sheet.locator("> .composer .composer-box").waitFor({ timeout: 5000 })).then(() => true, () => false) : false;
    check(opened, `the made-up run's console opens with its box ${where}`);
    if (opened) {
      const box = sheet.locator("> .composer .composer-box");
      const words = async () => (await sheet.locator("> .composer button").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
      const plain = await words();
      await box.fill(`btw ${question}`);
      const hint = await sheet.locator(".side-hint").innerText({ timeout: 3000 }).then((t) => t.replace(/\s+/g, " ").trim(), () => "");
      const asking = await words();
      check(
        plain.includes("btw") && plain.includes("interrupt") && hint.startsWith("Side question.") && asking.includes("ask beside") && !asking.includes("stop & send"),
        `a message that opens with btw raises the side question's line ${where}, and the box stops offering to cut the run's turn: "${hint.slice(0, 60)}" with ${asking.join(", ")}`,
      );
      await page.screenshot({ path: `${shots}/side-question-hint${phone ? "-phone" : ""}.png` });
      await box.press("Enter");
      const column = sheet.locator("> .side-q");
      await column.waitFor({ timeout: 5000 }).catch(() => undefined);
      check(sent.length === 1 && sent[0] === `side check-par: ${question}`, `the question goes to the side route and nothing is said to the run ${where}: ${sent.join("; ") || "nothing sent"}`);
      const head = await column.locator(".side-q-head").innerText().then((t) => t.replace(/\s+/g, " ").trim(), () => "");
      check(head.includes("Side question") && head.includes(question) && head.includes("Started from: migrate the billing checkout"), `the thread's head says what was asked and what it started from ${where}: "${head.slice(0, 120)}"`);
      const geo = await page.evaluate(() => {
        const sheet = document.querySelector<HTMLElement>(".sheet-back .sheet");
        const col = sheet?.querySelector<HTMLElement>(":scope > .side-q");
        const body = sheet?.querySelector<HTMLElement>(":scope > .sheet-body");
        if (!sheet || !col || !body) return null;
        const [s, c, b] = [sheet.getBoundingClientRect(), col.getBoundingClientRect(), body.getBoundingClientRect()];
        return { sheet: s.width, mid: s.left + s.width / 2, colLeft: c.left, colWidth: c.width, colHeight: c.height, bodyRight: b.right, body: getComputedStyle(body).visibility, over: col.classList.contains("over"), wider: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      if (!geo) check(false, `the thread's column is in the run's sheet ${where}`);
      else if (phone) {
        check(geo.over && geo.colWidth >= geo.sheet - 4 && geo.body === "hidden" && geo.colHeight >= 400 && geo.wider <= 0, `on a phone the thread lies over the run: ${Math.round(geo.colWidth)} of ${Math.round(geo.sheet)}px wide, ${Math.round(geo.colHeight)}px tall, the run under it ${geo.body}`);
      } else {
        check(!geo.over && Math.abs(geo.colLeft - geo.mid) <= 2 && geo.bodyRight <= geo.colLeft + 1 && geo.body === "visible" && geo.colHeight >= 400 && geo.wider <= 0, `at 1400px the thread has the sheet's right half and the run keeps the left: a ${Math.round(geo.sheet)}px sheet, the run to ${Math.round(geo.bodyRight)}, the thread from ${Math.round(geo.colLeft)}`);
      }
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${shots}/side-question${phone ? "-phone" : ""}.png` });
      // put away, the thread is still a chat with a tab of its own
      await column.locator(".side-q-head button.close").click();
      const tab = sheet.locator(".run-tabs .rtab", { hasText: "retryBackoff" });
      const closed = await tab.waitFor({ timeout: 3000 }).then(() => true, () => false);
      const mark = closed ? ((await tab.locator(".rtab-side").textContent()) ?? "").trim() : "";
      const back = await sheet.locator("> .sheet-body").evaluate((el) => getComputedStyle(el).visibility).catch(() => "");
      check(closed && mark === "btw" && back === "visible" && (await column.count()) === 0, `closing the thread ${where} shows the run again and leaves the chat a tab marked btw: tab ${closed ? `"${mark}"` : "missing"}, the run ${back}`);
      await tab.click().catch(() => undefined);
      check(await column.waitFor({ timeout: 3000 }).then(() => true, () => false), `its tab brings the thread back ${where}`);
      // the browser keeps which thread shows beside which run, so a reload
      // finds the column open when the run's sheet opens again
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector(".pill.runs", { timeout: 20_000 });
      await page.locator(".pill.runs").click();
      await rows.first().waitFor({ timeout: 5000 }).catch(() => undefined);
      const listed = await rows.allInnerTexts();
      const parent = listed.findIndex((t) => t.includes("billing"));
      if (parent < 0) await page.screenshot({ path: `${shots}/side-question-reload${phone ? "-phone" : ""}.png` });
      // on a phone the thread lies over the run, so the sheet, not the run's box, says it opened
      const reopened = parent >= 0 && (await rows.nth(parent).click().then(() => sheet.waitFor({ timeout: 5000 })).then(() => true, () => false));
      const kept = reopened && (await column.waitFor({ timeout: 3000 }).then(() => true, () => false));
      check(kept, `after a reload the run's sheet opens with the thread beside it ${where} (${reopened ? "the sheet opened" : parent < 0 ? `no row for the run among ${listed.length}: ${listed.join(" | ").replace(/\s+/g, " ").slice(0, 160)}` : "its sheet did not open"})`);
    }
    await page.close();
  }

  {
    // The prompt rail (FR-078). A chat of twelve messages, made up as the
    // runs pill's two are, each answered with a tool step and a reply long
    // enough that the timeline scrolls. In the run's sheet: a tick a
    // message, the newest marked with the timeline at its end; a tick's
    // card; a click and the keys moving the view and the mark. On a phone:
    // the bar at the timeline's foot, clear of the last step.
    const asker = await fresh();
    const tree = (await (await asker.request.get(`${base}/api/tree`)).json()) as { repos: { id: string; name: string }[] };
    await asker.close();
    const steps: Record<string, unknown>[] = [];
    for (let i = 1; i <= 12; i++) {
      const at = Date.now() - (13 - i) * 60_000;
      steps.push({ id: `u${i}`, at, kind: "user", text: `Message ${i}: why does the row wrap at ${300 + i}px?` });
      steps.push({ id: `t${i}`, at: at + 5000, kind: "tool", tool: { name: "Bash", title: "bun test", status: "ok" } });
      steps.push({ id: `a${i}`, at: at + 9000, kind: "text", text: `Reply ${i}: the row holds seven buttons.\n\nThe widest is the mic.\n\nAt that width the last one drops to a second line.\n\nShrinking the chips to their glyphs keeps all seven on the screen.` });
    }
    const chat = {
      id: "check-rail",
      repoId: tree.repos.find((r) => r.name === "demo")?.id ?? "demo",
      action: "chat",
      verb: "chat",
      progress: "",
      expectsChange: false,
      chat: true,
      harness: "claude",
      note: "",
      status: "idle",
      startedAt: Date.now() - 13 * 60_000,
      steps,
      prompt: null,
    };
    /** the rail of the timeline under `scope`, as the page draws it now */
    const railOf = (page: Page, scope: string) =>
      page.evaluate((scope) => {
        const list = document.querySelector<HTMLElement>(`${scope} .sheet-body.console`);
        if (!list) return null;
        const box = list.getBoundingClientRect();
        const ticks = [...list.querySelectorAll<HTMLElement>(":scope > .prompt-rail .rail-tick")];
        const track = list.querySelector(":scope > .prompt-rail .rail-ticks")?.getBoundingClientRect();
        const bar = list.querySelector<HTMLElement>(":scope > .prompt-rail-foot > .rail-bar");
        const first = [...list.querySelectorAll<HTMLElement>("[data-prompt]")].find((el) => el.getBoundingClientRect().bottom > box.top + 1);
        const last = [...list.querySelectorAll<HTMLElement>(":scope > .steps > li")].pop();
        return {
          ticks: ticks.length,
          marked: ticks.findIndex((t) => t.getAttribute("aria-current") === "true") + 1,
          inside: track ? track.top >= box.top && track.bottom <= box.bottom && track.right <= box.right : false,
          card: list.querySelector<HTMLElement>(":scope > .prompt-rail .rail-card")?.innerText.replace(/\s+/g, " ").trim() ?? "",
          first: first ? `${first.getAttribute("data-prompt")} ${Math.round(first.getBoundingClientRect().top - box.top)}px down` : "none",
          fromEnd: Math.round(list.scrollHeight - list.clientHeight - list.scrollTop),
          bar: bar?.innerText.replace(/\s+/g, " ").trim().slice(0, 40) ?? "",
          short: bar ? [...bar.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().height < 43.5 || b.getBoundingClientRect().width < 43.5).length : -1,
          clear: bar && last ? Math.round(bar.getBoundingClientRect().top - last.getBoundingClientRect().bottom) : null,
          wider: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      }, scope);

    const page = await fresh(undefined, true);
    await page.route("**/api/runs", (r) => (r.request().method() === "GET" ? r.fulfill({ json: [chat] }) : r.continue()));
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.waitForSelector(".pill.runs", { timeout: 20_000 });
    await page.locator(".pill.runs").click();
    const opened = await page.waitForSelector(".sheet-back .sheet-body.console", { timeout: 5000 }).then(() => true, () => false);
    await page.waitForTimeout(700);
    const open = opened ? await railOf(page, ".sheet-back") : null;
    check(
      open?.ticks === 12 && open.marked === 12 && open.inside && open.fromEnd <= 1,
      `a chat of 12 messages has a rail of 12 ticks inside its timeline, the newest marked at the end (${open ? `${open.ticks} ticks, marked ${open.marked}, ${open.fromEnd}px from the end` : "no sheet"})`,
    );
    if (open?.ticks === 12) {
      const tick = page.locator(".sheet-back .rail-tick").nth(2);
      await tick.hover();
      await page.waitForTimeout(250);
      const card = await railOf(page, ".sheet-back");
      check(
        (card?.card.startsWith("Message 3:") ?? false) && card!.card.includes("Reply 3:") && card!.card.endsWith("3 of 12") && card!.fromEnd <= 1,
        `a tick under the pointer shows the message's first words, the reply's and its place, and scrolls nothing: "${card?.card.slice(0, 40)}… ${card?.card.slice(-7)}"`,
      );
      await page.screenshot({ path: `${shots}/prompt-rail.png` });
      await tick.click();
      await page.waitForTimeout(400);
      const jumped = await railOf(page, ".sheet-back");
      check(jumped?.marked === 3 && /^u3 \d{1,2}px down$/.test(jumped.first), `a click brings message 3 to the timeline's top and marks its tick (marked ${jumped?.marked}, first shown ${jumped?.first})`);
      // the keys, from the message box while it is empty, which keeps the focus
      await page.evaluate(() => {
        // a 1 for each arrow press the page took, a 0 for each it left to
        // the browser. Added after the page's own listener and on the
        // window as it bubbles, so the page has had the press by then.
        const seen = document.documentElement.dataset;
        window.addEventListener("keydown", (e) => {
          if (e.key.startsWith("Arrow")) seen.railKeys = `${seen.railKeys ?? ""}${e.defaultPrevented ? 1 : 0}`;
        });
      });
      await page.locator(".sheet-back .composer-box").click();
      await page.keyboard.press("Alt+ArrowDown");
      await page.waitForTimeout(300);
      const after = await railOf(page, ".sheet-back");
      await page.keyboard.press("Alt+ArrowUp");
      await page.keyboard.press("Alt+ArrowUp");
      await page.waitForTimeout(300);
      const before = await railOf(page, ".sheet-back");
      const typing = await page.evaluate(() => document.activeElement?.classList.contains("composer-box") ?? false);
      check(
        after?.marked === 4 && after.first.startsWith("u4 ") && before?.marked === 2 && before.first.startsWith("u2 ") && typing,
        `Alt and the arrows step to the message after and before, from the empty message box (marked ${after?.marked}, then ${before?.marked}; the box ${typing ? "keeps" : "lost"} the focus)`,
      );
      // with a draft in the box the same keys are the draft's own caret moves
      const box = page.locator(".sheet-back .composer-box");
      await box.fill("half a thought");
      await page.evaluate(() => (document.documentElement.dataset.railKeys = ""));
      await page.keyboard.press("Alt+ArrowDown");
      await page.keyboard.press("Alt+ArrowUp");
      await page.waitForTimeout(300);
      const drafting = await railOf(page, ".sheet-back");
      const taken = await page.evaluate(() => document.documentElement.dataset.railKeys ?? "");
      const words = await box.inputValue();
      await box.fill("");
      await page.keyboard.press("Alt+ArrowDown");
      await page.waitForTimeout(300);
      const emptied = await railOf(page, ".sheet-back");
      check(
        drafting?.marked === 2 && drafting.first === before?.first && taken === "00" && words === "half a thought" && emptied?.marked === 3 && emptied.first.startsWith("u3 "),
        `with a draft in the box the keys stay the browser's and the rail stays put (marked ${drafting?.marked}, presses taken "${taken}"), and with the box emptied they step again (marked ${emptied?.marked})`,
      );
      // by hand: the mark follows the view
      await page.locator(".sheet-back .sheet-body.console").hover();
      await page.mouse.wheel(0, 50_000);
      await page.waitForTimeout(500);
      const end = await railOf(page, ".sheet-back");
      check(end?.marked === 12 && end.fromEnd <= 1, `scrolled to the end by hand, the newest tick is marked again (marked ${end?.marked})`);
    }
    await page.close();

    const phone = await fresh(undefined, true, true);
    await phone.route("**/api/runs", (r) => (r.request().method() === "GET" ? r.fulfill({ json: [chat] }) : r.continue()));
    await phone.goto(`${base}/?view=run&run=check-rail`, { waitUntil: "load" });
    const barred = await phone.waitForSelector(".run-solo .rail-bar", { timeout: 20_000 }).then(() => true, () => false);
    await phone.waitForTimeout(700);
    const bar = barred ? await railOf(phone, ".run-solo") : null;
    check(
      bar !== null && bar.ticks === 0 && bar.bar.includes("12 of 12") && bar.short === 0 && (bar.clear ?? -1) >= 0 && bar.fromEnd <= 1 && bar.wider <= 0,
      `on a phone the rail is a bar at the timeline's foot, its buttons a finger's size, the last step clear of it (${bar ? `"${bar.bar}", ${bar.short} short, ${bar.clear}px clear, ${bar.fromEnd}px from the end` : "no bar"})`,
    );
    if (bar) {
      await phone.screenshot({ path: `${shots}/prompt-rail-phone.png` });
      await phone.locator(".run-solo .rail-where select").selectOption("4");
      await phone.waitForTimeout(350);
      const picked = await railOf(phone, ".run-solo");
      await phone.locator(".run-solo .rail-go").last().tap();
      await phone.waitForTimeout(350);
      const next = await railOf(phone, ".run-solo");
      check(
        (picked?.bar.includes("5 of 12") ?? false) && picked!.first.startsWith("u5 ") && (next?.bar.includes("6 of 12") ?? false) && next!.first.startsWith("u6 "),
        `its place opens the list of messages and its arrows step (a pick: "${picked?.bar.slice(0, 12)}" at ${picked?.first}; then ↓: "${next?.bar.slice(0, 12)}" at ${next?.first})`,
      );
      const small = await smallFields(phone);
      check(small.length === 0, `and its picker is no field iOS would zoom onto${small.length ? `: ${[...new Set(small)].join(", ")}` : ""}`);
    }
    await phone.close();
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
    // check answers /api/runs: a coordinator asking a question, with four
    // cards, t1 a flow parked at its review gate, t2 queued after t1, t3
    // proposed and t4 queued while its kept tree is made, and three loadouts
    // for the equip sheet.
    const asker = await fresh();
    const tree = (await (await asker.request.get(`${base}/api/tree`)).json()) as { repos: { id: string; name: string; path: string }[] };
    await asker.close();
    const repo = (name: string) => tree.repos.find((r) => r.name === name)?.id ?? name;
    const repoDir = (name: string) => tree.repos.find((r) => r.name === name)?.path ?? "";
    const TREE_BRANCH = "check/dev-server-for-the-copy-on-a-phone";
    const SPROUT_ID = "sp_0123456789ab";
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
        { id: "t4", title: "Try the copy on a dev server", repo: repo("demo"), note: "Run the dev server and read the copy.", action: "ask", state: "queued", tree: TREE_BRANCH, outcome: `making tree ${TREE_BRANCH}` },
        { id: "t5", title: "A shop for the copy", repo: "~goal", note: "A tiny shop.", action: "project", state: "running", sprout: SPROUT_ID, outcome: "the project waits on your answers in the incubator" },
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
    // one kept tree of demo, still being made; its dir is twin's path so the
    // lane finds a card to open
    const keptTrees = {
      root: "/tmp/check-trees",
      ports: "4100-4199",
      repos: [
        {
          repoId: repo("demo"),
          repoPath: repoDir("demo"),
          trees: [
            { slug: "check-dev-server-for-the-copy-on-a-phone", dir: repoDir("twin"), branch: TREE_BRANCH, base: "main", port: 4101, madeAt: ago(1), caches: false, state: "preparing", sync: false, head: "0000000", ahead: 0, behind: 0, files: 0, shells: 0 },
          ],
        },
      ],
    };
    // t5's sprout, clarifying with one question for the user
    const sprout = {
      id: SPROUT_ID,
      slug: "a-shop-for-the-copy",
      title: "A shop for the copy",
      status: "clarifying",
      repoId: "_incubator/a-shop-for-the-copy",
      seedPath: "/tmp/check-incubator/a-shop-for-the-copy",
      prepared: true,
      inputs: [{ n: 1, kind: "text", name: "001-text.md", label: "text", type: "text/plain", at: ago(5), via: "coordinator", bytes: 28, summary: "", processed: true }],
      clarified: false,
      reclarify: false,
      questions: [{ question: "Who buys from the shop?", header: "Buyer", multiSelect: false, options: [{ label: "visitors", description: "anyone who reads the copy" }, { label: "members", description: "people with an account" }] }],
      questionsAt: ago(4),
      flows: [],
      spent: { runs: 1, workMs: 60_000 },
      createdAt: ago(5),
      updatedAt: ago(4),
    };
    const goalPage = async (width: number): Promise<Page> => {
      const phone = width <= 390;
      const page = await fresh(undefined, true, phone);
      if (!phone) await page.setViewportSize({ width, height: 900 });
      const get = (path: string, json: unknown) => page.route((u) => u.pathname === path, (r) => (r.request().method() === "GET" ? r.fulfill({ json }) : r.continue()));
      await get("/api/runs", runs);
      await get("/api/flows", flows);
      await get("/api/kit", kit);
      await get("/api/trees", keptTrees);
      await get("/api/incubator", [sprout]);
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

    // with no goal named, one going and t5's project in the incubator, the
    // overview stays and lists both; the goal's row opens the goal and names
    // it in the address
    let at = "";
    {
      const page = await goalPage(1440);
      await page.goto(`${base}/?view=manager`, { waitUntil: "load" });
      await page.waitForSelector(".mgr-pick .mgr-projects .sprout-card", { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const overview = await page.evaluate(() => ({
        search: location.search,
        heading: document.querySelector(".mgr-pick h1")?.textContent?.trim() ?? "",
        goals: document.querySelectorAll(".mgr-pick .mgr-goal-row").length,
        projects: [...document.querySelectorAll(".mgr-projects .sprout-title")].map((t) => t.textContent?.trim() ?? ""),
      }));
      check(
        !overview.search.includes("run=") && overview.heading === "Goals and projects" && overview.goals === 1 && (overview.projects[0] ?? "").startsWith("A shop for the copy"),
        `at 1440px one goal going and a project keep the overview (${overview.search}): "${overview.heading}", ${overview.goals} goal row, projects: ${overview.projects.join(", ") || "none"}`,
      );
      await page.screenshot({ path: `${shots}/manager-1440-overview.png` });
      await page.locator(".mgr-goal-row").first().click();
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
        at.includes("run=check-coord") && head.startsWith("Give the check page") && rows.rings === 6 && rows.needs === 4 && rows.lanes === 5 && rows.beside,
        `at 1440px the one goal going opens (${at}): ${rows.rings} rings, ${rows.needs} things that need you, ${rows.lanes} lanes, the chat ${rows.beside ? "beside them" : "not beside them"}`,
      );
      const files = await textOf(page, "#mgr-lane-t3 .mgr-files");
      check(files.startsWith("files: shot.png, the-copy-to-read-aloud"), `at 1440px a card's lane names the goal's files it takes: "${files.slice(0, 48)}"`);
      const tree = await textOf(page, "#mgr-lane-t4 .mgr-tree");
      check(tree === `in tree ${TREE_BRANCH} · preparing`, `at 1440px t4's lane names its tree and the tree's state: "${tree}"`);
      const openTree = page.locator("#mgr-lane-t4").getByRole("button", { name: "open tree" });
      const hasOpen = (await openTree.count()) === 1;
      check(hasOpen, `at 1440px t4's lane has an open tree button`);
      const project = await page.evaluate(() => {
        const lane = document.querySelector("#mgr-lane-t5");
        const buttons = [...(lane?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim() ?? "");
        return { facts: lane?.querySelector(".mgr-lane-facts .mono")?.textContent?.trim() ?? "", word: lane?.querySelector(".mgr-word")?.textContent?.trim() ?? "", buttons };
      });
      check(project.facts === "new project" && project.word === "needs you" && project.buttons.includes("open project"), `at 1440px t5's lane reads "${project.facts}", shows "${project.word}" and has ${project.buttons.includes("open project") ? "" : "no "}open project`);
      // the eight stages and a workflow's three steps share one row, none cut
      for (const [who, want] of [["t5", 8], ["t1", 3]] as const) {
        const strip = await stripOf(page, `#mgr-lane-${who}`);
        check(strip.labels.length === want && strip.cut.length === 0 && strip.rows === 1, `at 1440px ${stripWords(who, strip)}`);
      }
      await page.screenshot({ path: `${shots}/manager-1440.png` });
      if (hasOpen) {
        await openTree.click();
        await page.waitForTimeout(500);
        const after = await page.evaluate(() => location.search);
        check(!after.includes("view=manager"), `at 1440px open tree leaves the manager view (${after || "no query"})`);
      }
      // open tree left the view, so come back to it for the project card
      await page.goto(`${base}/${at}`, { waitUntil: "load" });
      await settle(page);
      await page.locator("#mgr-lane-t5").getByRole("button", { name: "open project" }).click();
      // the sprout's sheet says it is open; the check below names what it found if it never does
      await page
        .locator(".sheet-title", { hasText: "A shop for the copy" })
        .waitFor({ timeout: 10_000 })
        .catch(() => {});
      const opened = await page.evaluate(() => ({ search: location.search, sheet: document.querySelector(".sheet-title")?.textContent?.trim() ?? "", eyebrow: document.querySelector(".sheet-head .eyebrow")?.textContent?.trim() ?? "" }));
      check(opened.search === at && opened.sheet.startsWith("A shop for the copy") && opened.eyebrow.startsWith("incubator"), `at 1440px open project opens the sprout's sheet over the goal (${opened.search}; "${opened.eyebrow}", "${opened.sheet}")`);
      await page.screenshot({ path: `${shots}/manager-1440-project-sheet.png` });
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
      for (const [who, want] of [["t5", 8], ["t1", 3]] as const) {
        const strip = await stripOf(page, `#mgr-lane-${who}`);
        check(strip.labels.length === want && strip.cut.length === 0, `at 900px ${stripWords(who, strip)}`);
      }
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
      // the tree line is cut or wrapped inside its lane, never wider than it
      const treeLine = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>("#mgr-lane-t4 .mgr-tree");
        const lane = document.querySelector<HTMLElement>("#mgr-lane-t4");
        return el && lane ? { right: el.getBoundingClientRect().right, lane: lane.getBoundingClientRect().right } : null;
      });
      check(treeLine !== null && treeLine.right <= treeLine.lane + 0.5, `at 390px t4's tree line stays inside its lane${treeLine ? ` (${Math.round(treeLine.right)}px of ${Math.round(treeLine.lane)}px)` : ": no tree line"}`);
      await page.locator("#mgr-lane-t4").screenshot({ path: `${shots}/manager-390-tree.png` });
      // a project card's lane keeps its facts inside it
      const projectLane = await page.evaluate(() => {
        const lane = document.querySelector<HTMLElement>("#mgr-lane-t5");
        if (!lane) return null;
        const edge = lane.getBoundingClientRect().right;
        const out = [...lane.querySelectorAll<HTMLElement>(".mgr-lane-facts, .mgr-lane-facts > *, .mgr-lane-foot, .mgr-acts button")].filter((el) => el.getBoundingClientRect().right > edge + 0.5).map((el) => el.className || el.tagName);
        return { out, text: lane.querySelector(".mgr-lane-facts")?.textContent?.trim() ?? "" };
      });
      check(projectLane !== null && projectLane.out.length === 0 && projectLane.text.startsWith("new project"), `at 390px t5's lane keeps its facts inside it ("${projectLane?.text ?? "no lane"}"${projectLane?.out.length ? `, past the edge: ${projectLane.out.join(", ")}` : ""})`);
      // every stage label reads whole on a phone: the strip wraps, it never cuts
      const stages = await stripOf(page, "#mgr-lane-t5");
      check(stages.labels.length === 8 && stages.cut.length === 0, `at 390px ${stripWords("t5", stages)}`);
      // a workflow's three steps and a plain card's two arcs still fit one row
      for (const [who, want] of [["t1", 3], ["t2", 2]] as const) {
        const strip = await stripOf(page, `#mgr-lane-${who}`);
        check(strip.labels.length === want && strip.cut.length === 0 && strip.rows === 1, `at 390px ${stripWords(who, strip)}`);
      }
      const waits = await page.evaluate(() => {
        const lane = document.querySelector("#mgr-lane-t5");
        return {
          live: lane?.querySelector(".mgr-live")?.textContent?.trim() ?? "",
          word: lane?.querySelector(".mgr-lane-head .mgr-word")?.textContent?.trim() ?? "",
          open: [...(lane?.querySelectorAll("button") ?? [])].some((b) => b.textContent?.trim() === "open project" && b.getClientRects().length > 0),
        };
      });
      check(
        waits.live === "the project waits on your answers in the incubator" && waits.word === "needs you" && waits.open,
        `at 390px t5's lane says "${waits.live}", reads "${waits.word}" and ${waits.open ? "shows" : "has no"} open project`,
      );
      await page.locator("#mgr-lane-t5").screenshot({ path: `${shots}/manager-390-project.png` });
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
      // three loadouts and none (FR-069), which takes no loadout at all
      const picks = open ? await sheet.locator(".mgr-equip-pick").count() : 0;
      const skills = open ? await sheet.locator('section[aria-label="skills"] .mgr-equip-opt').count() : 0;
      // the kit's answer holds no providers, so the row offers the route's and the login
      const providers = open ? (await sheet.locator('section[aria-label="model and effort"] .mgr-equip-seg').last().locator("button").allInnerTexts()).map((t) => t.trim()) : [];
      check(
        open && Math.round(box?.width ?? 0) === 390 && Math.round(box?.height ?? 0) === 844 && picks === 4 && skills === 3 && providers.join(",") === "the route's,login",
        `at 390px t3's equip sheet fills the screen (${Math.round(box?.width ?? 0)} by ${Math.round(box?.height ?? 0)}) with ${picks} picks (three loadouts and none), ${skills} skills and the providers ${providers.join(", ") || "none"}`,
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

    // The new box (FR-067, and the incubator's intake since 2026-11-18).
    // `?view=manager&new=1` shows it focused over the goals and projects
    // going, on a goal in a browser that has started nothing yet. A scratch
    // server runs no coordinator, so its about is answered here as one that
    // does, which gives the box its backend, model and effort; its stages
    // are answered as a runner's. Typing `@de` offers the repo demo, a pick
    // writes it, and a small PNG attached shows as a chip. Start goal is
    // never pressed. Then the project side: the words and the chip stay,
    // links, a repo and a recorder show, and start project sends the form
    // (answered here) and opens the new project's sheet.
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
      await page.route(
        (u) => u.pathname === "/api/incubator/stages",
        (r) => r.fulfill({ json: { isolated: true, mode: "runner", waiting: null } }),
      );
      return page;
    };
    for (const width of [1440, 390]) {
      const page = await composerPage(width);
      await page.goto(`${base}/?view=manager&new=1`, { waitUntil: "load" });
      const box = page.locator(".mgr-new .mgr-new-text");
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
        `at ${width}px ?view=manager&new=1 shows the new box ${state.focused ? "focused" : "not focused"} on a goal over ${state.goals} goal going and stays there (${state.search}); "${state.on}", "${state.line}"`,
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
      check(fit.page <= 0 && fit.view <= 0, `at ${width}px the page with the new box on a goal has no side scroll${fit.page > 0 || fit.view > 0 ? ` (${Math.max(fit.page, fit.view)}px past the edge)` : ""}`);
      if (width <= 390) {
        // goal and project, the chip's remove, attach and start goal
        const buttons = await shortButtons(page, ".mgr-new");
        check(buttons.seen >= 5 && buttons.short.length === 0, `at 390px every button in the new box is a finger tall (${buttons.seen} of them)${buttons.short.length ? `: ${buttons.short.join(", ")}` : ""}`);
        const fields = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".mgr-new textarea, .mgr-new select")]
            .filter((el) => el.getClientRects().length > 0)
            .map((el) => ({ what: `${el.tagName.toLowerCase()} '${el.getAttribute("aria-label") ?? ""}'`, h: el.getBoundingClientRect().height })),
        );
        const low = fields.filter((f) => f.h < 43.5).map((f) => `${f.what} ${Math.round(f.h)}px`);
        check(fields.length >= 3 && low.length === 0, `at 390px every field in the new box on a goal is a finger tall (${fields.length} of them)${low.length ? `: ${low.join(", ")}` : ""}`);
        const small = await smallFields(page);
        check(small.length === 0, `at 390px no field with the new box is under 16px, where iOS zooms the page${small.length ? `: ${[...new Set(small)].join(", ")}` : ""}`);
      }
      await page.screenshot({ path: `${shots}/manager-new-${width}.png` });

      // the project side keeps the words and the chip, and adds its own fields
      await page.locator(".mgr-new-kind").getByRole("radio", { name: "project" }).click();
      await page.waitForTimeout(400);
      const side = await page.evaluate(() => ({
        kept: document.querySelector<HTMLTextAreaElement>(".mgr-new .mgr-new-text")?.value ?? "",
        holder: document.querySelector<HTMLTextAreaElement>(".mgr-new .mgr-new-text")?.placeholder ?? "",
        chip: document.querySelector(".mgr-new-file")?.textContent ?? "",
        links: document.querySelector('.mgr-new textarea[aria-label="Links"]') !== null,
        repo: document.querySelector('.mgr-new input[aria-label="A git repo to start from"]') !== null,
        record: [...document.querySelectorAll(".mgr-new-files button")].some((b) => /record|voice memo/.test(b.textContent ?? "")),
        on: document.querySelector(".mgr-new-on")?.textContent?.trim() ?? "",
        model: document.querySelector('.mgr-new select[aria-label="The coordinator\'s model"]') !== null,
      }));
      const startProject = page.locator(".mgr-new").getByRole("button", { name: "start project" });
      const canStart = await startProject.isEnabled();
      check(
        side.kept === "Tidy the READMEs in @demo " && side.holder.startsWith("the idea") && side.chip.includes("shot.png") && side.links && side.repo && side.record && !side.model && side.on.includes("stages isolated") && canStart,
        `at ${width}px the project side keeps the words ("${side.kept}") and the chip (${side.chip.includes("shot.png") ? "kept" : "lost"}), shows links ${side.links}, repo ${side.repo}, a recorder ${side.record}, no model ${!side.model}, "${side.on}", and start project ${canStart ? "on" : "off"}`,
      );
      const sideFit = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(sideFit <= 0, `at ${width}px the new box on a project has no side scroll${sideFit > 0 ? ` (${sideFit}px past the edge)` : ""}`);
      if (width <= 390) {
        const buttons = await shortButtons(page, ".mgr-new");
        check(buttons.short.length === 0, `at 390px every button on the project side is a finger tall (${buttons.seen} of them)${buttons.short.length ? `: ${buttons.short.join(", ")}` : ""}`);
        const fields = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".mgr-new textarea, .mgr-new input:not([type=file]), .mgr-new select")]
            .filter((el) => el.getClientRects().length > 0)
            .map((el) => ({ what: `${el.tagName.toLowerCase()} '${el.getAttribute("aria-label") ?? ""}'`, h: el.getBoundingClientRect().height })),
        );
        const low = fields.filter((f) => f.h < 43.5).map((f) => `${f.what} ${Math.round(f.h)}px`);
        check(fields.length >= 3 && low.length === 0, `at 390px every field on the project side is a finger tall (${fields.length} of them)${low.length ? `: ${low.join(", ")}` : ""}`);
      }
      await page.screenshot({ path: `${shots}/manager-new-${width}-project.png` });
      if (width === 1440) {
        // start project sends the incubator's form; answered here as a new sprout, whose sheet opens
        let sent = "";
        await page.route(
          (u) => u.pathname === "/api/incubator",
          async (r) => {
            if (r.request().method() !== "POST") return r.continue();
            sent = r.request().postData() ?? "";
            await r.fulfill({ json: { ...sprout, id: "sp_0000000c0de1", title: "Tidy the READMEs", slug: "tidy-the-readmes", status: "queued", questions: undefined, updatedAt: Date.now() } });
          },
        );
        await startProject.click();
        const sheet = await page.locator(".sheet-title", { hasText: "Tidy the READMEs" }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
        const after = await page.evaluate(() => ({ text: document.querySelector<HTMLTextAreaElement>(".mgr-new .mgr-new-text")?.value ?? "", chips: document.querySelectorAll(".mgr-new-file").length }));
        check(
          sheet && sent.includes('name="text"') && sent.includes("Tidy the READMEs in @demo") && sent.includes('filename="shot.png"') && after.text === "" && after.chips === 0,
          `at 1440px start project sends the words and the PNG (${sent.includes('filename="shot.png"') ? "with" : "without"} the file), opens the project's sheet (${sheet ? "open" : "not open"}) and empties the box ("${after.text}", ${after.chips} chips)`,
        );
        await page.screenshot({ path: `${shots}/manager-new-1440-started.png` });
      }
      await page.close();
    }
    {
      // the command line's new lands its words on the project side of the box
      const page = await composerPage(1440);
      await page.goto(`${base}/`, { waitUntil: "load" });
      await page.waitForSelector(".app", { timeout: 20_000 });
      await page.waitForTimeout(800);
      await page.keyboard.press(":");
      const line = page.locator(".cli-field input").first();
      const typed = await line.waitFor({ timeout: 10_000 }).then(() => true, () => false);
      if (typed) {
        await line.fill("new a coin counter --url https://coins.example");
        await line.press("Enter");
      }
      const drafted = await page.locator(".mgr-new .mgr-new-text").waitFor({ timeout: 15_000 }).then(() => true, () => false);
      await page.waitForTimeout(600);
      const draft = await page.evaluate(() => ({
        search: location.search,
        text: document.querySelector<HTMLTextAreaElement>(".mgr-new .mgr-new-text")?.value ?? "",
        links: document.querySelector<HTMLTextAreaElement>('.mgr-new textarea[aria-label="Links"]')?.value ?? "",
      }));
      check(
        typed && drafted && draft.text === "a coin counter" && draft.links === "https://coins.example" && draft.search.includes("kind=project"),
        `the command line's new opens the box on a project with its words ("${draft.text}", "${draft.links}", ${draft.search || "no query"})${typed ? "" : "; the command line never showed"}`,
      );
      await page.close();
    }
    {
      // the top bar's entry: from the board, its "+ new" opens the box focused
      const page = await composerPage(1440);
      await page.goto(`${base}/`, { waitUntil: "load" });
      await page.locator(".topbar button.new-btn").click({ timeout: 20_000 });
      const shown = await page.locator(".mgr-new .mgr-new-text").waitFor({ timeout: 15_000 }).then(() => true, () => false);
      await page.waitForTimeout(800);
      const state = await page.evaluate(() => ({
        search: location.search,
        focused: document.activeElement instanceof HTMLTextAreaElement && document.activeElement.closest(".mgr-new") !== null,
      }));
      check(shown && state.focused && state.search === "?view=manager&new=1", `the top bar's + new opens the box ${state.focused ? "focused" : "not focused"} (${state.search})`);
      await page.close();
    }
  }

  {
    // A right-click's "open in its own window" (FR-084). A repo's panel
    // pops out of the dock and comes back from its window's "back to the
    // dock"; "waiting on you" goes to a window of its list and comes back
    // when that window closes; a window of one thing never offers itself;
    // and a phone gets a copy, with the panel left in the dock.
    const rowsAt = async (p: Page, sel: string, at: { x: number; y: number }) => {
      await p.locator(sel).first().click({ button: "right", position: at });
      const shown = await p.locator(".ctx-menu").first().waitFor({ timeout: 5000 }).then(() => true, () => false);
      // the menu settles in over 140ms
      await p.waitForTimeout(300);
      return shown ? (await p.locator('.ctx-menu [role="menuitem"]').allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()) : [];
    };
    const pick = async (p: Page) => {
      const [win] = await Promise.all([
        p.context().waitForEvent("page", { timeout: 8000 }).catch(() => null),
        p.locator('.ctx-menu [role="menuitem"]', { hasText: "open in its own window" }).first().click({ timeout: 4000 }).catch(() => undefined),
      ]);
      await win?.waitForLoadState("load");
      return win;
    };
    const ROW = "open in its own window";
    const page = await fresh();
    await page.addInitScript(() => localStorage.setItem("canopy.settings", JSON.stringify({ level: "advanced", onboarded: true })));
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.waitForSelector(".app", { timeout: 20_000 });
    await page.locator(".app-view").getByText("demo", { exact: true }).last().click();
    await page.waitForSelector(".panel[data-repo]", { timeout: 10_000 });
    // a panel still settling in moves from under a menu, which closes it
    await page.waitForTimeout(1200);
    const head = (await rowsAt(page, ".panel[data-repo] .panel-head", { x: 200, y: 10 })).filter((t) => t.length > 1);
    check(head[0] === `${ROW} demo`, `a right-click on a repo panel's head leads with "${ROW}" ("${head.slice(0, 2).join('", "')}")`);
    await page.screenshot({ path: `${shots}/window-row.png` });
    const solo = await pick(page);
    const soloAt = solo ? new URL(solo.url()).search : "";
    await solo?.waitForSelector(".solo .panel", { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(700);
    const left = await page.locator(".panel[data-repo]").count();
    check(soloAt === "?repo=demo&view=solo&popped=1" && left === 0, `the row pops the panel out to its own window (${soloAt || "no window"}), and the dock lets it go (${left} left)`);
    if (solo) {
      const own = await rowsAt(solo, ".panel[data-repo] .panel-head", { x: 200, y: 10 });
      check(own.length > 0 && !own.includes(`${ROW} demo`), `the window's own panel offers no window of itself (${own.filter((t) => t.startsWith(ROW)).join(", ") || "none"})`);
      await solo.keyboard.press("Escape");
      await solo.getByRole("button", { name: "back to the dock" }).click();
      await page.waitForTimeout(1500);
      const back = await page.locator(".panel[data-repo]").count();
      check(back === 1 && solo.isClosed(), `"back to the dock" puts the panel back and closes the window (${back} in the dock, window ${solo.isClosed() ? "closed" : "open"})`);
    }

    await page.locator(".topbar").first().click({ position: { x: 300, y: 5 } });
    await page.keyboard.press("w");
    const docked = await page.waitForSelector('.panel[data-panel="/waiting"]', { timeout: 5000 }).then(() => true, () => false);
    await page.waitForTimeout(1200);
    const waiting = docked ? await rowsAt(page, '.panel[data-panel="/waiting"] .panel-head', { x: 150, y: 10 }) : [];
    check(waiting[0] === `${ROW} waiting on you`, `"waiting on you", a panel that is no repo's, leads with it too ("${waiting[0] ?? "no menu"}")`);
    const list = docked ? await pick(page) : null;
    const listAt = list ? new URL(list.url()).search : "";
    await list?.waitForSelector(".popup-solo .waiting-body", { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(700);
    const gone = await page.locator('.panel[data-panel="/waiting"]').count();
    if (list) {
      // the window opens a column wide, like the popover a popup's list hangs in
      await list.setViewportSize({ width: 440, height: 800 });
      await list.waitForTimeout(400);
      const seen = await list.evaluate(() => ({
        text: document.querySelector(".popup-solo-main")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        wider: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      check(
        listAt === "?view=popup&popup=waiting&popped=1" && gone === 0 && seen.text.includes("twin") && seen.wider <= 0,
        `its window (${listAt}) holds the list at 440px with nothing off the side (${seen.wider}px), and the dock lets the panel go (${gone} left): "${seen.text.slice(0, 40)}"`,
      );
      await list.screenshot({ path: `${shots}/window-popup.png` });
      const bar = await rowsAt(list, ".popup-solo .topbar", { x: 200, y: 20 });
      check(bar.length > 0 && !bar.some((t) => t.includes("own window")), `a popup's window offers no window of its view (${bar.filter((t) => t.includes("window")).join(", ") || "none"})`);
      // a repo's row has no dock to open a panel in, so the repo gets a window of its own
      await list.keyboard.press("Escape");
      const [repoWin] = await Promise.all([
        page.context().waitForEvent("page", { timeout: 8000 }).catch(() => null),
        list.locator(".popup-solo-main .waiting-row", { hasText: "twin" }).first().click({ timeout: 4000 }).catch(() => undefined),
      ]);
      const repoAt = repoWin ? new URL(repoWin.url()).search : "";
      check(repoAt === "?repo=twin&view=solo" && new URL(list.url()).search === listAt, `a repo's row in that window opens the repo's own window (${repoAt || "nothing"}) and the list stays`);
      await repoWin?.close();
      await list.close();
      const returned = await page.waitForSelector('.panel[data-panel="/waiting"]', { timeout: 6000 }).then(() => true, () => false);
      check(returned, "closing the window brings the panel back to the dock");
    } else {
      check(false, `"waiting on you" opened no window (${waiting.join(", ") || "no menu"})`);
    }
    const view = await rowsAt(page, ".app-view", { x: 400, y: 700 });
    check(view.some((t) => t.startsWith("this view in its own window")), `a right-click on nothing offers the view's own window (${view.filter((t) => t.includes("window")).join(", ") || "none"})`);
    await page.close();

    const phone = await fresh(undefined, false, true);
    await phone.addInitScript(() => localStorage.setItem("canopy.settings", JSON.stringify({ level: "advanced", onboarded: true })));
    await phone.goto(`${base}/?repo=demo`, { waitUntil: "load" });
    await phone.waitForSelector(".panel[data-repo]", { timeout: 20_000 });
    await phone.waitForTimeout(1200);
    // a finger's long press arrives as the same event a right-click sends
    await phone.locator(".panel[data-repo] .panel-head").first().dispatchEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80, button: 2 });
    await phone.locator(".ctx-menu").first().waitFor({ timeout: 5000 }).catch(() => undefined);
    await phone.waitForTimeout(300);
    const copy = await pick(phone);
    const copyAt = copy ? new URL(copy.url()).search : "";
    const kept = await phone.locator(".panel[data-repo]").count();
    check(copyAt === "?repo=demo&view=solo" && kept === 1, `on a phone the row opens a copy (${copyAt || "no window"}) and the panel stays in the dock (${kept})`);
    await phone.screenshot({ path: `${shots}/window-row-phone.png` });
    await phone.close();
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

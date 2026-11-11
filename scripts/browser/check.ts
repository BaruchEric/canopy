// Drives a running canopy page the way a person would and says what broke:
// the first load (what comes with the page, what is fetched once it is up),
// every view from its URL and by switching inside one page, the runs pill's
// menu with two runs going, a shell that answers, the two load failures
// (a view's chunk and xterm's refused), and a phone: the top bar's first row
// on the screen, an open panel's section tabs, and no field small enough for
// iOS to zoom the page onto.
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

const VIEWS = ["library", "ports", "sessions", "agents", "incubator", "health", "costs", "triggers", "clock", "work", "kit", "secrets"];
/** the chunks the page loads on demand, by the name vite gives each */
const LAZY = ["Sessions", "Secrets", "Kit", "Costs", "Triggers", "Clock", "Library", "AgentsView", "Incubator", "Work", "xterm"];

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
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="submit"], [type="button"], [type="color"], [type="hidden"]), textarea, select')]
        .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
        .map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/).join(".")}` : ""} ${getComputedStyle(el).fontSize}`),
    );
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

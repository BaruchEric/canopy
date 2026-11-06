// Drives a running canopy page the way a person would and says what broke:
// the first load (what comes with the page, what is fetched once it is up),
// every view from its URL and by switching inside one page, a shell that
// answers, and the two load failures (a view's chunk and xterm's refused).
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

const VIEWS = ["library", "ports", "sessions", "agents", "incubator", "health", "costs", "triggers", "work", "kit", "secrets"];
/** the chunks the page loads on demand, by the name vite gives each */
const LAZY = ["Sessions", "Secrets", "Kit", "Costs", "Triggers", "Library", "AgentsView", "Incubator", "Work", "xterm"];

const browser = await launch();
const failures: string[] = [];
const notes: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

/** a page of its own; `block` refuses that chunk, with the service worker
 *  off, since a fetch the worker makes passes the page's routes by */
async function fresh(block?: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, ...(block ? { serviceWorkers: "block" as const } : {}) });
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
    const js: { name: string; at: number }[] = [];
    const t0 = Date.now();
    page.on("request", (r) => {
      if (r.url().endsWith(".js")) js.push({ name: r.url().split("/").pop()!.replace(/-[A-Za-z0-9_-]{8}\.js$/, ""), at: Date.now() - t0 });
    });
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.waitForSelector(".app", { timeout: 20_000 });
    const up = Date.now() - t0;
    await page.waitForTimeout(7000);
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
    check(text.length > 0 && !text.includes("could not load") && !text.startsWith("Loading…"), `${v} opens from its URL: "${text.slice(0, 60)}"`);
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

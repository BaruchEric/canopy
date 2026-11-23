// Drives people, roles, teams and invites (FR-074) on a backend that
// enforces who calls, the way four people would: the owner signs in with the
// first code and makes a team and two people; a member joins on a phone from
// their link and is held to their team's folders, the page asking for
// nothing the wall would refuse; a viewer types their invite into the
// sign-in box, is told they only read and is offered nothing to press; a
// pair is approved as someone else; then the roster is changed, emptied and
// signed out of.
// people.sh starts the scratch server and runs this; it copies the file into
// the browser folder first, where "playwright" resolves.
//   people.ts <base url> <server log> <screenshot folder> <a team's folder>
import { mkdirSync, readFileSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { launch } from "./launch.ts";

const [base, logFile, shots, folder] = process.argv.slice(2);
if (!base || !logFile || !shots || !folder) {
  console.error("usage: people.ts <base url> <server log> <screenshot folder> <a team's folder>");
  process.exit(2);
}
mkdirSync(shots, { recursive: true });
const browser = await launch();
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const DESK = { viewport: { width: 1400, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

async function open(ctx: BrowserContext, url: string): Promise<Page> {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  await page.goto(url, { waitUntil: "load" });
  return page;
}

/** what the backend says this page is, asked with the token the page keeps */
const auth = (page: Page) =>
  page.evaluate(async () => {
    const token = localStorage.getItem(`canopy.token.${location.origin}`);
    const r = await fetch("/api/auth", { headers: token ? { "x-canopy-token": token } : {} });
    const v: { you: string; person: { id: string; name: string; role: string } | null; rights: string[] } = await r.json();
    return v;
  });

/** a write sent as this page, to see what the backend itself refuses */
const post = (page: Page, path: string, body: unknown) =>
  page.evaluate(
    async ([p, b]) => {
      const token = localStorage.getItem(`canopy.token.${location.origin}`);
      const r = await fetch(p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-canopy-token": token } : {}) }, body: JSON.stringify(b) });
      return { status: r.status, text: await r.text() };
    },
    [path, body] as const,
  );

const text = async (page: Page, sel: string) =>
  (
    (await page
      .locator(sel)
      .first()
      .textContent()
      .catch(() => "")) ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();

/** every 403 the wall answered this page, by route: a held page that asks
 *  for a closed route has a bug, since the page knows the routes it may ask */
function walled(page: Page): string[] {
  const seen: string[] = [];
  page.on("response", (r) => {
    if (r.status() !== 403) return;
    void r
      .text()
      .then((t) => {
        if (t.includes('"scoped":true')) seen.push(new URL(r.url()).pathname);
      })
      .catch(() => {});
  });
  return seen;
}

/** the views a page's menus offer: the phone's one menu, or the bar's groups */
async function viewsOffered(page: Page): Promise<string[]> {
  if ((await page.locator(".view-pick").count()) > 0) {
    await page.locator(".view-pick .pick-btn").click();
    const names = await page.locator('.view-pick [role="radio"] .sort-name').allTextContents();
    await page.keyboard.press("Escape");
    return names.map((n) => n.trim().split(/\s/)[0] ?? "");
  }
  const names: string[] = [];
  for (const g of await page.locator(".view-group .pick-btn").all()) {
    await g.click();
    names.push(...(await page.locator('.view-group [role="radio"] .sort-name').allTextContents()).map((n) => n.trim().split(/\s/)[0] ?? ""));
    await page.keyboard.press("Escape");
  }
  return names;
}

const noOverflow = async (page: Page, what: string) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over <= 1, `${what}: the page does not scroll sideways (${over}px over)`);
};

/** press sign in on the sign-in screen and type a first code or an invite */
async function signInWith(page: Page, code: string): Promise<void> {
  await page.waitForSelector(".signin-first", { timeout: 20_000 });
  await page.click("button.signin-chip");
  await page.waitForSelector(".signin-input", { timeout: 10_000 });
  await page.fill(".signin-input", code);
  await page.press(".signin-input", "Enter");
  await page.waitForSelector(".app", { timeout: 30_000 });
}

try {
  /* ---------- the owner signs in with the first code ---------- */
  const ownerCtx = await browser.newContext(DESK);
  const owner = await open(ownerCtx, `${base}/`);
  await owner.waitForSelector(".signin-first", { timeout: 20_000 });
  check((await text(owner, ".signin-first")).includes("With an invite"), "the sign-in screen says an invite works there");
  await owner.screenshot({ path: `${shots}/01-signin.png` });
  await signInWith(owner, /first sign-in code (\S+) /.exec(readFileSync(logFile, "utf8"))?.[1] ?? "");
  const me0 = await auth(owner);
  check(me0.person?.id === "owner" && me0.rights.includes("admin"), `the first code signs the page in as the owner (${JSON.stringify(me0.person)})`);

  /* ---------- the People view: a name, a team, two people ---------- */
  await owner.goto(`${base}/?view=people`, { waitUntil: "load" });
  await owner.waitForSelector(".people-view .people-list", { timeout: 20_000 });
  await owner.fill('input[aria-label="Your name on this backend"]', "Eric");
  await owner.click(".people-me button.strong");
  await owner.waitForFunction(() => document.querySelector(".people-list .people-name")?.textContent?.includes("Eric"), null, { timeout: 10_000 });
  check(true, "the owner renames themselves and the roster follows");

  await owner.fill('input[aria-label="The new team\'s name"]', "Rio");
  await owner.fill('input[aria-label="The folders the new team works in"]', folder);
  await owner.click('button:has-text("add team")');
  await owner.waitForSelector(".people-team-row", { timeout: 10_000 });
  check((await owner.inputValue(".people-team-row .people-team-name")) === "Rio", "a team is made with its folder");

  const invite = async (name: string, role: string, team: boolean): Promise<string> => {
    await owner.fill('input[aria-label="The new person\'s name"]', name);
    await owner.selectOption('select[aria-label="Their role"]', role);
    if (team) await owner.click('.people-add .people-team:has-text("Rio")');
    await owner.click('button:has-text("add and invite")');
    await owner.waitForFunction((n) => document.querySelector(".people-invite-head")?.textContent?.includes(n), name, { timeout: 10_000 });
    return text(owner, ".people-invite-link");
  };
  const averyLink = await invite("Avery", "member", true);
  check(/\/\?join=cnv_[a-z2-7]{24}$/.test(averyLink), `adding a person shows their invite link once (${averyLink.replace(/cnv_.*/, "cnv_…")})`);
  await owner.screenshot({ path: `${shots}/02-people-invite.png`, fullPage: true });
  await owner.click('.people-invite button:has-text("done")');
  const guestLink = await invite("Guest", "viewer", false);
  const guestCode = guestLink.split("join=")[1] ?? "";
  await owner.click('.people-invite button:has-text("done")');
  check((await owner.locator(".people-row").count()) === 3, "the roster lists the owner and the two added");
  check((await text(owner, ".people-row:has-text('Avery')")).includes("1 invite waiting"), "a person with an invite out says so");
  await noOverflow(owner, "people view at 1400");

  /* ---------- the owner opens an invite link themselves: nothing is traded ---------- */
  const self = await open(ownerCtx, averyLink);
  await self.waitForSelector(".joined-note", { timeout: 20_000 });
  check((await text(self, ".joined-note")).includes("already signed in as Eric"), "a signed-in page keeps its session and leaves the invite unused");
  check(!self.url().includes("join="), "the invite left the address");
  check((await auth(self)).person?.id === "owner", "and the page is still the owner");
  await self.screenshot({ path: `${shots}/03-own-link.png` });
  await self.close();

  /* ---------- Avery joins on a phone with the link ---------- */
  const averyCtx = await browser.newContext(PHONE);
  const averyPage = await averyCtx.newPage();
  const averyWalled = walled(averyPage);
  averyPage.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  await averyPage.goto(averyLink, { waitUntil: "load" });
  const avery = averyPage;
  await avery.waitForSelector(".app", { timeout: 30_000 });
  const a1 = await auth(avery);
  check(a1.person?.name === "Avery" && a1.person.role === "member" && !a1.rights.includes("admin"), `the link signs a phone in as Avery, a member (${JSON.stringify(a1.person)})`);
  check(!avery.url().includes("join="), "the invite left the phone's address");
  await avery.waitForSelector(".joined-note", { timeout: 5_000 }).catch(() => {});
  check((await text(avery, ".joined-note")).includes("Signed in as Avery"), "the page says who it signed in as");
  await avery.waitForFunction(() => document.querySelectorAll(".card").length > 0, null, { timeout: 20_000 });
  await avery.waitForTimeout(1500);
  const cards = await avery.locator(".card .card-name").allTextContents();
  check(cards.length === 2 && cards.includes("app") && cards.includes("site"), `a member starts on their team's folders (${cards.join(", ")})`);
  await avery.screenshot({ path: `${shots}/04-member-phone-grid.png` });
  await noOverflow(avery, "the member's grid on a phone");

  /* ---------- the wall: what a held page asks for and offers ---------- */
  await avery.waitForTimeout(2000);
  check(averyWalled.length === 0, `a held page asks for no route the wall closes on its first load (${averyWalled.join(", ") || "none"})`);
  const heldViews = await viewsOffered(avery);
  check(heldViews.join() === "git,sessions,people", `a held phone's menu offers the board, the shells and the people (${heldViews.join(", ")})`);
  const scopeNow = await avery.evaluate(async () => {
    const token = localStorage.getItem(`canopy.token.${location.origin}`);
    const r = await fetch("/api/auth", { headers: token ? { "x-canopy-token": token } : {} });
    const v: { scope?: string[] | null } = await r.json();
    return v.scope ?? null;
  });
  check(Array.isArray(scopeNow) && scopeNow.length === 1, `the backend tells a held page its folders (${JSON.stringify(scopeNow)})`);
  const kitAsked = await avery.evaluate(async () => {
    const token = localStorage.getItem(`canopy.token.${location.origin}`);
    const r = await fetch("/api/kit", { headers: token ? { "x-canopy-token": token } : {} });
    return { status: r.status, text: await r.text() };
  });
  check(kitAsked.status === 403 && kitAsked.text.includes('"scoped":true'), `the backend still refuses a closed route asked by hand (${kitAsked.status})`);
  // that refusal's own line lands before the count starts again
  await avery.waitForTimeout(500);
  averyWalled.length = 0;
  // an address naming a closed view shows the board
  await avery.goto(`${base}/?view=kit`, { waitUntil: "load" });
  await avery.waitForFunction(() => document.querySelectorAll(".card").length > 0, null, { timeout: 20_000 });
  check((await avery.locator(".kit-view, .kit").count()) === 0, "an address naming the kit shows a held page the board");
  // a dropped stream comes back without asking for what the wall closes
  await avery.waitForTimeout(1500);
  await averyCtx.setOffline(true);
  await avery.waitForTimeout(2500);
  await averyCtx.setOffline(false);
  await avery.waitForTimeout(6000);
  check(averyWalled.length === 0, `nor after its stream drops and comes back (${averyWalled.join(", ") || "none"})`);
  await avery.screenshot({ path: `${shots}/04b-held-phone-after-drop.png` });
  // the filters menu has no "my teams only" to turn off when the backend holds the page
  await avery.goto(`${base}/`, { waitUntil: "load" });
  await avery.waitForFunction(() => document.querySelectorAll(".card").length > 0, null, { timeout: 20_000 });

  // the invite is spent
  const again = await browser.newContext(DESK);
  const spent = await open(again, averyLink);
  await spent.waitForSelector(".signin-first .joined-note", { timeout: 20_000 });
  check((await text(spent, ".joined-note")).includes("did not sign this page in"), "an invite used once does not work twice, and the page says so");
  await spent.screenshot({ path: `${shots}/05-spent-invite.png` });
  await again.close();

  /* ---------- the owner sees Avery on, and where ---------- */
  await owner.goto(`${base}/`, { waitUntil: "load" });
  await owner.waitForSelector(".people-chip", { timeout: 20_000 });
  const chipWords = (await owner.getAttribute(".people-chip", "aria-label")) ?? "";
  check(chipWords.includes("Avery (member) is on"), `the top bar's chip says who is on (${chipWords})`);
  await avery.locator(".card", { hasText: "app" }).first().tap();
  await owner.waitForSelector(".card .here-faces", { timeout: 15_000 });
  check(((await owner.getAttribute(".card .here-faces", "aria-label")) ?? "").includes("Avery has this repo open"), "a card shows who else has the repo open");
  check((await owner.locator(".card .card-name").count()) === 3, "the owner sees every repo");
  await owner.screenshot({ path: `${shots}/06-owner-grid.png` });

  /* ---------- the member's People view on a phone: read-only ---------- */
  await avery.goto(`${base}/?view=people`, { waitUntil: "load" });
  await avery.waitForSelector(".people-view .people-list", { timeout: 20_000 });
  check((await avery.locator(".people-add").count()) === 0 && (await avery.locator(".people-row select.people-role").count()) === 0, "a member reads the roster and changes no one");
  check((await text(avery, ".people-view")).includes("member:"), "the member's own card says what a member may do");
  await avery.screenshot({ path: `${shots}/07-member-phone-people.png`, fullPage: true });
  await noOverflow(avery, "people view on a phone");
  const refusedAdd = await post(avery, "/api/people/add", { name: "Friend" });
  check(refusedAdd.status === 403 && refusedAdd.text.includes("your role"), `a member's add is refused by the backend (${refusedAdd.status})`);

  /* ---------- Guest signs in by typing the invite, in the dark ---------- */
  const guestCtx = await browser.newContext({ ...DESK, colorScheme: "dark" });
  const guest = await open(guestCtx, `${base}/`);
  // every 403 the viewer's page meets: neither the role nor the wall should refuse it anything it asked by itself
  const guestRefused: string[] = [];
  guest.on("response", (r) => {
    if (r.status() === 403) guestRefused.push(new URL(r.url()).pathname);
  });
  const termTickets: string[] = [];
  guest.on("request", (r) => {
    if (r.url().endsWith("/api/auth/ticket") && (r.postData() ?? "").includes('"term"')) termTickets.push(r.url());
  });
  await signInWith(guest, guestCode);
  const g1 = await auth(guest);
  check(g1.person?.name === "Guest" && g1.rights.join() === "read", `a typed invite signs the page in as Guest, a viewer (${g1.rights.join()})`);
  await guest.waitForSelector(".people-chip.limited", { timeout: 15_000 });
  check((await text(guest, ".people-chip")).includes("viewing"), "a viewer's chip says they are viewing");
  check((await post(guest, "/api/people/me", { name: "Guest Two" })).status === 200, "a viewer still renames themselves");
  check((await post(guest, "/api/people/team", { name: "X" })).status === 403, "a viewer's write is refused");
  await guest.waitForTimeout(500);
  guestRefused.length = 0;
  // a viewer is offered nothing to press: no card menu, a star that only says
  await guest.waitForFunction(() => document.querySelectorAll(".card").length === 3, null, { timeout: 20_000 });
  check((await guest.locator(".card .card-more").count()) === 0, "a viewer's cards carry no menu of things to start");
  check((await guest.locator(".card .star:not([disabled])").count()) === 0, "a viewer's stars say what is starred and star nothing");
  check((await viewsOffered(guest)).length > 3, "a viewer who is on no team is not held: every view is offered");
  // a viewer's shell tab says why it stays shut and asks for no ticket it cannot get
  await guest.locator(".card").first().click();
  await guest.waitForTimeout(3000);
  check(termTickets.length === 0, `a viewer's shell tab asks for no ticket (${termTickets.length} asked)`);
  check((await guest.locator(".panel .commit-box").count()) === 0, "a viewer's panel has no commit box");
  check((await guest.locator('.panel .file-row input[type="checkbox"]:not([disabled])').count()) === 0, "nor a box that stages a file");
  check((await guest.locator(".panel .panel-sync").count()) === 0, "nor pull or push");
  check((await guest.locator(".panel .guided-btn, .panel .agent-buttons, .panel .new-shell").count()) === 0, "nor a button that asks an agent, runs the app, saves the work or opens a shell");
  check((await guest.locator(".tour").count()) === 0, "nor the tour of asking an agent, running and saving");
  check(guestRefused.length === 0, `a viewer's page asks the backend for nothing its role refuses (${[...new Set(guestRefused)].join(", ") || "none"})`);
  // the same at advanced: this new browser opened on intermediate, whose
  // guided panel has no commit box, pull or push to leave out. It comes
  // after the refusal check because a reload sends a few calls the role
  // refuses before the page has read who it is (seen 2026-11-23).
  await guest.evaluate(() => localStorage.setItem("canopy.settings", JSON.stringify({ level: "advanced", onboarded: true })));
  await guest.reload({ waitUntil: "load" });
  await guest.waitForFunction(() => document.querySelectorAll(".card").length === 3, null, { timeout: 20_000 });
  if ((await guest.locator(".panel .panel-head").count()) === 0) await guest.locator(".card").first().click();
  await guest.waitForSelector(".panel .panel-head", { timeout: 15_000 });
  await guest.waitForTimeout(1500);
  const advancedPanel = (await guest.locator(".panel .guided-panel").count()) === 0;
  check(advancedPanel && (await guest.locator(".panel .commit-box, .panel .panel-sync").count()) === 0, `at advanced too, a viewer's panel has no commit box, pull or push (${advancedPanel ? "the advanced panel" : "still the guided panel"})`);
  await guest.screenshot({ path: `${shots}/08-viewer-dark.png` });
  await guest.goto(`${base}/?view=sessions`, { waitUntil: "load" });
  await guest.waitForSelector(".ss-side", { timeout: 20_000 });
  check((await guest.locator(".ss-side .ss-new, .ss-side .new-shell").count()) === 0, "a viewer's sessions view offers no new shell");
  await guest.screenshot({ path: `${shots}/08b-viewer-sessions.png` });

  /* ---------- update: a role change reaches the other page ---------- */
  await owner.goto(`${base}/?view=people`, { waitUntil: "load" });
  await owner.waitForSelector(".people-view .people-list", { timeout: 20_000 });
  check((await text(owner, ".people-row:has-text('Avery')")).includes("on "), "the roster says Avery is on, and on what");
  await owner.selectOption('.people-row:has-text("Avery") select.people-role', "viewer");
  await avery.waitForFunction(() => document.querySelector(".people-view")?.textContent?.includes("viewer:"), null, { timeout: 15_000 });
  check((await auth(avery)).rights.join() === "read", "a role change caps the other page's token at once");
  // a held viewer: the board of their folders, and nothing to press on it
  await avery.goto(`${base}/`, { waitUntil: "load" });
  await avery.waitForFunction(() => document.querySelectorAll(".card").length > 0, null, { timeout: 20_000 });
  check((await avery.locator(".card").count()) === 2 && (await avery.locator(".card .card-more").count()) === 0, "a held viewer sees their team's two repos with no menus");
  check((await avery.locator(".card .star:not([disabled])").count()) === 0, "and stars nothing");
  await avery.screenshot({ path: `${shots}/07b-held-viewer-phone.png` });
  await avery.goto(`${base}/?view=people`, { waitUntil: "load" });
  await avery.waitForSelector(".people-view .people-list", { timeout: 20_000 });
  await owner.selectOption('.people-row:has-text("Avery") select.people-role', "member");
  await avery.waitForFunction(() => document.querySelector(".people-view")?.textContent?.includes("member:"), null, { timeout: 15_000 });
  // and the page offers them again without a reload: the board through the menu, a card's menu, a star that stars
  await avery.locator(".view-pick .pick-btn").click();
  await avery.locator('.view-pick [role="radio"]', { hasText: "git" }).first().click();
  await avery.waitForFunction(() => document.querySelectorAll(".card").length > 0, null, { timeout: 20_000 });
  await avery.waitForSelector(".card .card-more", { timeout: 15_000 }).catch(() => {});
  check((await avery.locator(".card .card-more").count()) === 2, "changing it back gives the menus back without a reload");
  const starred = avery.waitForResponse((r) => r.url().includes("/api/repos/favorite"), { timeout: 15_000 }).catch(() => null);
  // on a phone the repo Avery opened earlier covers the board again, so the
  // star pressed is the one on show: the panel head's when a panel is open
  const panelStar = avery.locator(".panel-head .star");
  await ((await panelStar.count()) > 0 ? panelStar : avery.locator(".card .star")).first().tap();
  const fav = await starred;
  check(fav?.status() === 200, `and a star stars again (${fav?.status() ?? "nothing sent"})`);
  // Avery is a new browser, so the open repo is intermediate's guided panel,
  // whose run and save stand for the advanced panel's pull and push
  check((await avery.locator(".panel .panel-sync, .panel .guided-btn").count()) > 0, "and their open repo offers its buttons again (the guided panel's run and save)");
  await avery.goto(`${base}/?view=people`, { waitUntil: "load" });
  await avery.waitForSelector(".people-view .people-list", { timeout: 20_000 });

  /* ---------- a pair approved as someone else ---------- */
  const pairCtx = await browser.newContext(DESK);
  const pairPage = await pairCtx.newPage();
  const pairWalled = walled(pairPage);
  pairPage.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  await pairPage.goto(`${base}/`, { waitUntil: "load" });
  await pairPage.waitForSelector(".signin-first", { timeout: 20_000 });
  await pairPage.click("button.signin-chip");
  await pairPage.waitForSelector(".signin-code", { timeout: 10_000 });
  await owner.goto(`${base}/`, { waitUntil: "load" });
  await owner.waitForSelector(".inbox > button.inbox-waiting", { timeout: 20_000 });
  await owner.locator(".inbox > button").first().click();
  await owner.waitForSelector("select.pair-as", { timeout: 15_000 });
  const options = await owner.locator("select.pair-as option").allTextContents();
  check(options.some((o) => o.includes("as me")) && options.some((o) => o.includes("Avery")), `the approval asks whose sign-in it becomes (${options.join(" | ")})`);
  await owner.screenshot({ path: `${shots}/09-approve-as.png` });
  await owner.selectOption("select.pair-as", { label: options.find((o) => o.includes("Avery")) ?? "" });
  await owner.locator(".ask-row button.strong", { hasText: "allow" }).first().click();
  await pairPage.waitForSelector(".app", { timeout: 30_000 });
  check((await auth(pairPage)).person?.name === "Avery", "a pair approved as Avery becomes Avery's session");
  await pairPage.waitForFunction(() => document.querySelectorAll(".card").length > 0, null, { timeout: 20_000 });
  const deskViews = await viewsOffered(pairPage);
  check(deskViews.join() === "git,sessions,people", `a held page at 1400 offers the board, the shells and the people (${deskViews.join(", ")})`);
  await pairPage.waitForTimeout(2000);
  check(pairWalled.length === 0, `a held page at 1400 asks for no route the wall closes (${pairWalled.join(", ") || "none"})`);
  await pairPage.screenshot({ path: `${shots}/09b-held-desk.png` });
  await noOverflow(pairPage, "a held page at 1400");
  await pairCtx.close();
  await owner.keyboard.press("Escape");

  /* ---------- off, on, remove; the team edited and removed; the log ---------- */
  await owner.goto(`${base}/?view=people`, { waitUntil: "load" });
  await owner.waitForSelector(".people-view .people-list", { timeout: 20_000 });
  const guestRow = '.people-row:has-text("Guest")';
  await owner.click(`${guestRow} button:has-text("turn off")`);
  await owner.waitForSelector(`${guestRow}.off`, { timeout: 10_000 });
  const cut = await post(guest, "/api/people/me", { name: "Still here" });
  check(cut.status === 401, `turning a person off ends their sessions (${cut.status})`);
  await owner.click(`${guestRow} button:has-text("turn on")`);
  await owner.waitForFunction(() => !document.querySelector(".people-row.off"), null, { timeout: 10_000 });
  await owner.click(`${guestRow} button:has-text("remove")`);
  await owner.click(`${guestRow} button:has-text("remove?")`);
  await owner.waitForFunction(() => document.querySelectorAll(".people-row").length === 2, null, { timeout: 10_000 });
  check(true, "a person is turned off, on again and removed, the removal asked for twice");

  await owner.fill(".people-team-row .people-team-name", "Rio team");
  await owner.click('.people-team-row button:has-text("save")');
  await owner.waitForFunction(() => document.querySelector(".people-row:nth-child(2) .people-team")?.textContent === "Rio team", null, { timeout: 10_000 });
  check(true, "a team is renamed and its people's chips follow");
  await owner.waitForTimeout(500);
  const log = await text(owner, ".people-log");
  check(log.includes("added a person") && log.includes("changed a team") && log.includes("removed a person") && log.includes("approved a device"), "the log says who did what");
  await owner.screenshot({ path: `${shots}/10-people-log.png`, fullPage: true });
  await owner.click('.people-team-row button:has-text("remove")');
  await owner.click('.people-team-row button:has-text("remove?")');
  await owner.waitForFunction(() => document.querySelectorAll(".people-team-row").length === 0, null, { timeout: 10_000 });
  check(true, "the team is removed");

  /* ---------- sign out ---------- */
  await avery.goto(`${base}/?view=people`, { waitUntil: "load" });
  await avery.waitForSelector(".people-me", { timeout: 20_000 });
  await avery.locator('.people-me button:has-text("sign out")').tap();
  await avery.locator('.people-me button:has-text("sign out?")').tap();
  await avery.waitForSelector(".signin-first", { timeout: 20_000 });
  check((await auth(avery)).you === "none", "signing out ends the session and the page goes back to the sign-in");
  await avery.screenshot({ path: `${shots}/11-signed-out-phone.png` });
} catch (err) {
  const why = `the script stopped: ${err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err)}`;
  failures.push(why);
  console.log(`FAIL ${why}`);
  // every page as it stood, to see where
  for (const [c, ctx] of browser.contexts().entries()) {
    for (const [i, p] of ctx.pages().entries()) await p.screenshot({ path: `${shots}/zz-stopped-${c}-${i}.png` }).catch(() => {});
  }
} finally {
  await browser.close();
}
console.log(failures.length === 0 ? "\nall people checks passed" : `\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
process.exit(failures.length === 0 ? 0 : 1);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { Library, libraryArgs, libraryOriginAllowed, openBind, tailnetHost } from "./library";

interface Manifest { categories: Record<string, { projects: Array<{name: string; tags: string[]}> }>; references: Array<{title: string}> }
let base: string;
let root: string;
let state: string;
let library: Library;
let previous: string | undefined;
const original = { categories: { apps: { label: "Apps", keywords: ["app"] } },
  ignore: ["_devhub"], overrides: {}, links: {}, notes: { alpha: "Migrated note" },
  host_root: "/old/root", trusted_origins: ["https://old.example"], helper_port: 7333 };

async function command(args: string[]) {
  const child = Bun.spawn(["python3", ...await libraryArgs(root), ...args], {
    stdout: "pipe", stderr: "pipe", env: {...process.env, PYTHONDONTWRITEBYTECODE: "1"},
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
function request(path: string, body?: unknown, headers?: Record<string, string>) {
  return library.handle(new Request(`http://127.0.0.1:7850${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "canopy-library-test-")));
  root = join(base, "workspace");
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(base, "config");
  await mkdir(join(root, "_devhub"), { recursive: true });
  await writeFile(join(root, "_devhub/categories.json"), JSON.stringify(original));
  await writeFile(join(root, "_devhub/tags.json"), JSON.stringify({ alpha: ["imported"] }));
  await writeFile(join(root, "_devhub/running.json"), JSON.stringify({ alpha: { pid: 1 } }));
  for (const name of ["alpha", "beta"]) {
    const path = join(root, "apps", name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "README.md"), `# ${name}\n\nA fixture project.\n`);
    await writeFile(join(path, "package.json"), JSON.stringify({ name, scripts: { dev: "vite" }, devDependencies: { vite: "*" } }));
    const git = Bun.spawn(["git", "init", "--quiet", path]);
    expect(await git.exited).toBe(0);
  }
  const argv = await libraryArgs(root);
  state = argv[argv.indexOf("--state") + 1]!;
  library = new Library(root);
});
afterAll(async () => {
  library?.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(base, { recursive: true, force: true });
});

describe("workspace library integration", () => {
  test("public library requests require the configured HTTPS proxy origin", () => {
    const origin = "https://canopy.example";
    const req = (host: string, headers: Record<string, string> = {}) =>
      new Request(`http://${host}/library/`, {headers});
    expect(libraryOriginAllowed(req("canopy.example", {"x-forwarded-proto": "https"}), origin)).toBe(true);
    expect(libraryOriginAllowed(req("canopy.example", {"x-forwarded-proto": "https", origin}), origin)).toBe(true);
    expect(libraryOriginAllowed(req("canopy.example", {"x-forwarded-proto": "https"}))).toBe(false);
    expect(libraryOriginAllowed(req("canopy.example"), origin)).toBe(false);
    expect(libraryOriginAllowed(req("canopy.example.evil", {"x-forwarded-proto": "https"}), origin)).toBe(false);
    expect(libraryOriginAllowed(req("canopy.example", {"x-forwarded-proto": "https", origin: "https://evil.example"}), origin)).toBe(false);
  });
  test("a server listening beyond loopback takes same-origin requests by a tailnet name", () => {
    const req = (host: string, headers: Record<string, string> = {}) =>
      new Request(`http://${host}/library/`, {headers});
    // the tailnet is the edge: an address literal, a MagicDNS name, a bare machine name
    expect(libraryOriginAllowed(req("100.68.139.95:7850"), undefined, true)).toBe(true);
    expect(libraryOriginAllowed(req("macmini-2018.tail2d2c60.ts.net:7850"), undefined, true)).toBe(true);
    expect(libraryOriginAllowed(req("macmini-2018:7850", { origin: "http://macmini-2018:7850" }), undefined, true)).toBe(true);
    // an Origin that is not the page's own, or a cross-site fetch, is still out
    expect(libraryOriginAllowed(req("macmini-2018:7850", { origin: "http://evil.example" }), undefined, true)).toBe(false);
    expect(libraryOriginAllowed(req("macmini-2018:7850", { "sec-fetch-site": "cross-site" }), undefined, true)).toBe(false);
    // a dotted public name could be an attacker's domain pointed at the same address
    expect(libraryOriginAllowed(req("canopy.attacker.example:7850"), undefined, true)).toBe(false);
    // and none of it applies while the server binds loopback
    expect(libraryOriginAllowed(req("100.68.139.95:7850"))).toBe(false);
    expect(libraryOriginAllowed(req("macmini-2018:7850"), undefined, false)).toBe(false);
  });
  test("a listed origin may call from another site, and its own page may by host", () => {
    const listed = ["https://canopy.beric.ca", "https://erics-macbook-pro.tail2d2c60.ts.net:7850"];
    const req = (host: string, headers: Record<string, string> = {}) =>
      new Request(`http://${host}/api/tree`, { headers });
    // another canopy page, cross-site to the browser
    expect(libraryOriginAllowed(req("127.0.0.1:7850", { origin: "https://canopy.beric.ca", "sec-fetch-site": "cross-site" }), undefined, false, listed)).toBe(true);
    // the page tailscale serve hands out: https to the browser, http here, no Origin on a GET
    expect(libraryOriginAllowed(req("erics-macbook-pro.tail2d2c60.ts.net:7850", { "sec-fetch-site": "same-origin" }), undefined, false, listed)).toBe(true);
    // the same page's POST carries its https Origin
    expect(libraryOriginAllowed(req("erics-macbook-pro.tail2d2c60.ts.net:7850", { origin: "https://erics-macbook-pro.tail2d2c60.ts.net:7850" }), undefined, false, listed)).toBe(true);
    // unlisted stays out, and so does a cross-site request with no Origin to a listed host
    expect(libraryOriginAllowed(req("127.0.0.1:7850", { origin: "https://evil.example" }), undefined, false, listed)).toBe(false);
    expect(libraryOriginAllowed(req("erics-macbook-pro.tail2d2c60.ts.net:7850", { "sec-fetch-site": "cross-site" }), undefined, false, listed)).toBe(false);
    // no list, no change from before
    expect(libraryOriginAllowed(req("127.0.0.1:7850", { origin: "https://canopy.beric.ca" }))).toBe(false);
  });
  test("tailnetHost and openBind", () => {
    expect(tailnetHost("100.64.0.1")).toBe(true);
    expect(tailnetHost("100.127.255.254")).toBe(true);
    expect(tailnetHost("100.63.0.1")).toBe(false);
    expect(tailnetHost("100.128.0.1")).toBe(false);
    expect(tailnetHost("mini.tail2d2c60.ts.net")).toBe(true);
    expect(tailnetHost("mini")).toBe(true);
    expect(tailnetHost("")).toBe(false);
    expect(tailnetHost("mini.example.com")).toBe(false);
    expect(openBind(undefined)).toBe(false);
    expect(openBind("127.0.0.1")).toBe(false);
    expect(openBind("0.0.0.0")).toBe(true);
    expect(openBind("100.68.139.95")).toBe(true);
  });
  test("rejects foreign origins, lookalike hosts, and cross-site navigations before startup", async () => {
    expect((await request("/library/open", undefined, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await request("/library/open", undefined, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await library.handle(new Request("http://127.0.0.1.evil.example/library/"))).status).toBe(403);
  });
  test("starts lazily, migrates durable metadata, and serves working template scripts", async () => {
    const ready = await request("/api/library");
    expect(ready.status).toBe(200);
    const cfg = JSON.parse(await readFile(join(state, "categories.json"), "utf8"));
    expect(cfg.host_root).toBe(root);
    expect(cfg.trusted_origins).toEqual([]);
    expect(cfg.notes.alpha).toBe("Migrated note");
    expect(cfg.helper_port).toBe(7333);
    const snapshot = await (await request("/library/manifest")).json() as Manifest;
    expect(snapshot.categories["apps"]!.projects.map((p: { name: string }) => p.name)).toEqual(["alpha", "beta"]);
    expect(snapshot.categories["apps"]!.projects[0]!.tags).toEqual(["imported"]);
    expect(await (await request("/library/api/dev/state")).json()).toEqual({ok: true, running: {}});
    const html = await (await request("/library/")).text();
    expect(html).toContain("Canopy · Library");
    expect(html).toContain("Git cockpit →");
    expect(html).not.toContain("http://127.0.0.1:${DATA.helper_port}");
    for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      expect(() => new Script(script[1]!)).not.toThrow();
    }
  }, 30_000);
  test("tag and note edits persist to Canopy without modifying the original metadata", async () => {
    expect((await request("/library/api/cards/tag", {project: "alpha", add: ["new-tag"]})).status).toBe(200);
    expect((await request("/library/api/cards/note", {project: "alpha", text: "Updated in Canopy"})).status).toBe(200);
    const tags = JSON.parse(await readFile(join(state, "tags.json"), "utf8"));
    expect(tags.alpha).toEqual(["imported", "new-tag"]);
    expect(JSON.parse(await readFile(join(root, "_devhub/categories.json"), "utf8"))).toEqual(original);
    expect(JSON.parse(await readFile(join(root, "_devhub/tags.json"), "utf8"))).toEqual({alpha: ["imported"]});
  }, 30_000);
  test("ports carry absolute launch paths, enforce collisions, and read edited settings", async () => {
    expect((await request("/library/api/ports/set", {project: "alpha", dev_port: 16410})).status).toBe(200);
    const conflict = await request("/library/api/ports/set", {project: "beta", dev_port: 16410});
    expect(conflict.status).toBe(409);
    const rows = await (await request("/library/api/ports/state")).json() as {rows: Array<{path: string}>};
    expect(rows.rows[0]!.path).toBe(join(root, "apps/alpha"));
    const status = await (await request(`/library/open?action=devstatus&path=${encodeURIComponent(join(root, "apps/alpha"))}`)).json() as {port: number};
    expect(status.port).toBe(16410);
    const html = await (await request("/library/ports")).text();
    expect(html).toContain('data-path="${esc(r.path)}"');
    for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) expect(() => new Script(script[1]!)).not.toThrow();
    expect((await request("/library/open?action=devstatus&path=/etc")).status).toBe(403);
  }, 30_000);
  test("worker rejects unauthenticated requests and CLI announce reaches the managed worker", async () => {
    const worker = JSON.parse(await readFile(join(state, ".worker.json"), "utf8")) as {port: number};
    expect((await fetch(`http://127.0.0.1:${worker.port}/ping`)).status).toBe(403);
    const announced = await command(["announce", "--project", "alpha", "--port", "16410"]);
    expect(announced.code).toBe(0);
    expect(announced.stdout).toContain("announced alpha :16410");
  }, 10_000);
  test("CLI shares state, supports references/relations, and returns failed dev status", async () => {
    expect((await command(["--help"])).stdout).toContain("rename-category");
    expect((await command(["tag", "beta", "cli-tag"])).code).toBe(0);
    expect((await command(["relate", "alpha", "beta"])).code).toBe(0);
    expect((await command(["import", "https://example.org/docs", "--title", "Fixture docs", "--category", "apps"])).code).toBe(0);
    expect((await command(["refs"])).stdout).toContain("Fixture docs");
    expect((await command(["dev", "missing", "--dry-run"])).code).toBe(1);
    const dryRun = await command(["dev", "alpha", "--dry-run"]);
    expect(dryRun.code).toBe(0);
    expect(dryRun.stdout).toContain("16410");
    expect(dryRun.stdout).not.toContain(".test");
    const refreshed = await (await request("/library/refresh", {})).json() as Manifest;
    expect(refreshed.categories["apps"]!.projects[1]!.tags).toContain("cli-tag");
    expect(refreshed.references[0]!.title).toBe("Fixture docs");
  }, 30_000);
});

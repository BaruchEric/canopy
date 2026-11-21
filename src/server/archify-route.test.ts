/**
 * `/api/repos/archify` on a real server with a stand-in agent (FR-071): the
 * read lists no diagrams, a make starts a Claude run in the checkout with
 * canopy's copy of Archify loaded, a folder of its own and the rules to
 * write it, the read then names the run, a second start and a remove wait
 * on it, a page comes back as sandboxed text, a revise needs its note, a
 * remove takes the folder, and bad acts and names refuse.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchifyInfo } from "../core/archify";
import type { DriveCtx, RunDriver } from "../core/driver";
import type { Harness, Run } from "../core/types";
import { ARCHIFY_PLUGIN, ARCHIFY_SKILL } from "./archify";
import { startServer } from "./index";

/** what each run's driver was started with */
const started: { ctx: DriveCtx; message: string }[] = [];

/** a harness that never finishes on its own; a stop ends it */
class HoldingDriver implements RunDriver {
  readonly label = "Claude Code";
  private ctx: DriveCtx | null = null;
  constructor(readonly harness: Harness) {}
  check(): string | null {
    return null;
  }
  start(ctx: DriveCtx, message: string): void {
    this.ctx = ctx;
    started.push({ ctx, message });
  }
  say(): void {}
  stop(): void {
    this.ctx?.exited({ code: null, stderr: "" });
  }
}

let scratch: string;
let previous: string | undefined;
let app = "";
let server: { port: number; stop: () => void };
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const post = (body: unknown) => fetch(url("/api/repos/archify?id=app"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async () => (await (await fetch(url("/api/repos/archify?id=app"))).json()) as ArchifyInfo;
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;

async function stop(id: string) {
  const r = await fetch(url("/api/runs/stop"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  expect(r.ok).toBe(true);
  for (let i = 0; i < 50 && (await read()).run !== null; i++) await Bun.sleep(50);
  expect((await read()).run).toBeNull();
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-archify-route-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  app = join(root, "app");
  mkdirSync(app, { recursive: true });
  await Bun.$`git -C ${app} init -q && git -C ${app} -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m init`.quiet();
  app = await realpath(app);
  server = await startServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    incubator: { autostart: false, transcribe: null, notes: null, ship: null, stage: null },
    runner: { driver: (h) => new HoldingDriver(h) },
  });
});

afterAll(async () => {
  server.stop();
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

test("a make starts a diagram run with Archify loaded in a folder of its own; the read names it; others wait", async () => {
  expect(await read()).toEqual({ diagrams: [], run: null });
  expect((await post({ act: "draw" })).status).toBe(400);
  expect((await post({ act: "make", type: "mindmap" })).status).toBe(400);
  expect((await post({ act: "make", note: 7 })).status).toBe(400);

  const res = await post({ act: "make", type: "sequence", note: "the login request" });
  expect(res.status).toBe(201);
  const run = (await res.json()) as Run;
  expect(run).toMatchObject({ action: "archify", verb: "diagram" });
  const one = started.at(-1);
  if (!one) throw new Error("no run started");
  expect(one.ctx.cwd).toBe(app);
  expect(one.ctx.spec.pluginDirs).toEqual([ARCHIFY_PLUGIN]);
  const edit = one.ctx.spec.allowedTools.find((t) => t.startsWith("Edit("));
  expect(edit).toMatch(new RegExp(`^Edit\\(/${app}/\\.archify/sequence-the-login-request-\\d{8}-\\d{6}/\\*\\*\\)$`));
  expect(one.ctx.spec.allowedTools).toContain(`Bash(node ${ARCHIFY_SKILL}/bin/archify.mjs:*)`);
  expect(one.ctx.env["ARCHIFY_UPDATE_CHECK_DISABLED"]).toBe("1");
  expect(one.message).toContain("with the archify:archify skill");
  expect(one.message).toContain("Make it a sequence diagram.");
  expect(one.message).toContain("the login request");
  // the scratch checkout has no origin, so the run cites no checked sources
  expect(one.message).toContain("has no origin remote");
  expect(one.message).not.toContain(`--repo-root ${app}`);
  // the folder ignores itself before the run writes a byte
  expect(existsSync(join(app, ".archify", ".gitignore"))).toBe(true);

  expect((await read()).run).toBe(run.id);
  expect((await post({ act: "make" })).status).toBe(409);
  expect((await post({ act: "remove", diagram: "x" })).status).toBe(409);
  await stop(run.id);
}, 60_000);

test("a page comes back as sandboxed text; a revise needs its note; a remove takes the folder", async () => {
  const folder = "architecture-app-20261121-090000";
  mkdirSync(join(app, ".archify", folder), { recursive: true });
  writeFileSync(join(app, ".archify", folder, "app.html"), "<!doctype html><title>App &amp; API</title><script>parent.x = 1</script>");
  const list = await read();
  expect(list.diagrams).toHaveLength(1);
  expect(list.diagrams[0]).toMatchObject({ id: folder, file: "app.html", title: "App & API", type: "architecture", checks: null });

  const page = await fetch(url(`/api/repos/archify?id=app&diagram=${folder}`));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(page.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await page.text()).toContain("<title>App &amp; API</title>");
  expect((await fetch(url("/api/repos/archify?id=app&diagram=..%2F..%2Fetc"))).status).toBe(400);
  expect((await fetch(url("/api/repos/archify?id=app&diagram=nope-20261121-090000"))).status).toBe(400);

  const bare = await post({ act: "revise", diagram: folder });
  expect(bare.status).toBe(400);
  expect(await errorOf(bare)).toContain("say what to change");
  expect((await post({ act: "revise", note: "x" })).status).toBe(400);

  const res = await post({ act: "revise", diagram: folder, note: "highlight the cache miss" });
  expect(res.status).toBe(201);
  const run = (await res.json()) as Run;
  expect(run).toMatchObject({ action: "archify", verb: "revise" });
  const one = started.at(-1);
  if (!one) throw new Error("no run started");
  expect(one.ctx.spec.allowedTools).toContain(`Edit(/${app}/.archify/${folder}/**)`);
  expect(one.message).toContain(`revise the Archify diagram in .archify/${folder}/ (its page is app.html)`);
  expect(one.message).toContain("highlight the cache miss");
  await stop(run.id);

  const removed = await post({ act: "remove", diagram: folder });
  expect(removed.status).toBe(200);
  expect(existsSync(join(app, ".archify", folder))).toBe(false);
  expect((await read()).diagrams).toEqual([]);
  expect((await post({ act: "remove", diagram: folder })).status).toBe(400);
  expect((await post({ act: "remove" })).status).toBe(400);
}, 60_000);

test("a repo the backend does not scan is a 404", async () => {
  expect((await fetch(url("/api/repos/archify?id=nope"))).status).toBe(404);
});

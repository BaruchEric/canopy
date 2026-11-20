/**
 * Providers and default loadouts from kit.json (FR-069), over real HTTP on a
 * server in `enforce`: a scratch kit.json whose one machine is this backend,
 * with providers (one central, one reading an env the backend lacks, one for
 * another machine, one this machine keeps by hand) and defaults by repo,
 * machine and everywhere. A driver holds each run open until the test stops
 * it, so nothing here needs a claude login.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { selfName } from "../core/backends";
import type { DriveCtx, RunDriver } from "../core/driver";
import { exec } from "../core/exec";
import type { Harness, LoadoutDefault, LoadoutsInfo, ProviderView, Run } from "../core/types";
import { CallerBook } from "./callers";
import { startServer } from "./index";

const starts = new Map<string, DriveCtx>();

/** Holds a run open until it is stopped. */
class HeldDriver implements RunDriver {
  readonly label = "fake";
  constructor(readonly harness: Harness) {}
  private ctx: DriveCtx | undefined;
  check(): string | null { return null; }
  start(ctx: DriveCtx): void { this.ctx = ctx; starts.set(ctx.env["CANOPY_RUN"] ?? "", ctx); }
  say(): void {}
  stop(): void { this.ctx?.exited({ code: null, stderr: "" }); }
}

let scratch: string;
let root: string;
let config: string;
let cli: string;
let server: Awaited<ReturnType<typeof startServer>>;
const saved: Record<string, string | undefined> = {};
const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_CALLERS", "CANOPY_TMUX", "CANOPY_COORD_SOCKET", "CANOPY_BIND", "CANOPY_KIT", "HOME", "CODEX_HOME", "KIT_CONTAINER", "EQUIP_TEST_UNSET"];

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const get = (p: string) => fetch(url(p), { headers: { "x-canopy-token": cli } });
const post = (p: string, body: unknown) =>
  fetch(url(p), { method: "POST", headers: { "content-type": "application/json", "x-canopy-token": cli }, body: JSON.stringify(body) });
type Answer = { status: number; body: Partial<Run> & { error?: string } };
const answer = async (res: Response): Promise<Answer> => ({ status: res.status, body: (await res.json()) as Answer["body"] });
const live = new Set<string>();
async function start(extra: Record<string, unknown>, repo = "app"): Promise<Answer> {
  const got = await answer(await post(`/api/repos/run?id=${encodeURIComponent(repo)}`, { action: "ask", note: "x", branch: true, ...extra }));
  if (got.status === 201 && got.body.id) live.add(got.body.id);
  return got;
}
async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const begun = Date.now();
  for (;;) {
    const got = await read();
    if (got) return got;
    if (Date.now() - begun > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(20);
  }
}
const ctxOf = (id: string) => until(async () => starts.get(id), `run ${id} to reach the driver`);
async function stop(id: string): Promise<void> {
  await post("/api/runs/stop", { id });
  await until(async () => {
    const r = ((await (await get("/api/runs")).json()) as Run[]).find((x) => x.id === id);
    return !r || (r.status !== "working" && r.branch?.state !== "working");
  }, `run ${id} to stop`);
  live.delete(id);
}
const loadouts = async (): Promise<LoadoutsInfo> => (await (await get("/api/loadouts")).json()) as LoadoutsInfo;
const providerOf = async (id: string): Promise<ProviderView | undefined> => (await loadouts()).providers?.find((p) => p.id === id);
const providers = () => join(config, "providers");

async function repo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await exec(["git", "init", "-q", "-b", "main", path]);
  await exec(["git", "-C", path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"]);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-equip-defaults-"));
  for (const k of ENV) saved[k] = process.env[k];
  root = join(scratch, "root");
  config = join(scratch, "config");
  await repo(join(root, "app"));
  await repo(join(root, "tools", "one"));
  await repo(join(root, "tools", "two"));
  await repo(join(root, "plain"));
  const home = join(scratch, "home");
  await mkdir(join(home, ".claude", "skills"), { recursive: true });
  await writeFile(join(home, ".gitconfig"), "[user]\n\tname = t\n\temail = t@t\n");
  // a provider this machine keeps by hand, which the kit must not write over
  await mkdir(providers(), { recursive: true });
  await writeFile(join(providers(), "handp.json"), `{"env":{"ANTHROPIC_BASE_URL":"http://hand"}}\n`, { mode: 0o600 });
  const kitFile = join(scratch, "kit.json");
  await writeFile(kitFile, JSON.stringify({
    version: 1,
    machines: { here: { backend: selfName(null, hostname()) }, far: { backend: "nobody-here" } },
    targets: [{ agent: "claude", skills: join(scratch, "store", "skills"), mode: "store" }],
    skills: {},
    providers: {
      gw: { note: "a gateway", settings: { env: { ANTHROPIC_BASE_URL: "http://gw:4000", ANTHROPIC_MODEL: "big" } } },
      needsenv: { settings: { env: { ANTHROPIC_AUTH_TOKEN: "${env:EQUIP_TEST_UNSET}" } } },
      farp: { machines: ["far"], settings: { env: { ANTHROPIC_BASE_URL: "http://far" } } },
      handp: { settings: { env: { ANTHROPIC_BASE_URL: "http://kit" } } },
      or: { harness: "codex" },
    },
    loadouts: {
      docs: { model: "haiku", effort: "low" },
      feature: { model: "opus", effort: "high" },
      cx: { harness: "codex", effort: "low" },
      gwy: { model: "sonnet", provider: "gw" },
      far: { provider: "farp" },
    },
    defaults: {
      loadout: "feature",
      machines: { here: "docs" },
      repos: { app: "cx", "tools/*": "gwy", "tools/two": "none" },
    },
  }));
  process.env["CANOPY_CONFIG_DIR"] = config;
  process.env["CANOPY_CALLERS"] = "enforce";
  process.env["CANOPY_TMUX"] = "0";
  process.env["CANOPY_KIT"] = kitFile;
  process.env["HOME"] = home;
  process.env["KIT_CONTAINER"] = "0";
  delete process.env["EQUIP_TEST_UNSET"];
  delete process.env["CODEX_HOME"];
  delete process.env["CANOPY_COORD_SOCKET"];
  delete process.env["CANOPY_BIND"];
  const book = new CallerBook({ file: join(config, "callers.json") });
  cli = book.mint("cli", { label: "cli test" }).token;
  await book.flush();
  server = await startServer({ root, port: 0, chan: null, harnesses: ["claude", "codex"], runner: { driver: (h: Harness) => new HeldDriver(h) } });
  expect((await post("/api/kit/scan", {})).status).toBe(200);
  await until(async () => (await loadouts()).providers?.length === 5, "the kit's providers");
});

afterEach(async () => {
  for (const id of live) await stop(id);
});

afterAll(async () => {
  await server.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

describe("providers from kit.json", () => {
  test("the loadouts carry the defaults, the machine and each provider's state here", async () => {
    const info = await loadouts();
    expect(info.errors).toEqual([]);
    expect(info.machine).toBe("here");
    expect(info.defaults).toEqual({ loadout: "feature", machines: { here: "docs" }, repos: { app: "cx", "tools/*": "gwy", "tools/two": "none" } });
    const states = Object.fromEntries((info.providers ?? []).map((p) => [p.id, p.state]));
    expect(states).toEqual({ gw: "ok", needsenv: "unresolved", farp: "off", handp: "hand", or: "declared" });
    // names only: a value never goes to the page
    expect(JSON.stringify(info.providers)).not.toContain("http://gw:4000");
    expect(info.providers?.find((p) => p.id === "gw")).toMatchObject({ central: true, keys: ["env", "env.ANTHROPIC_BASE_URL", "env.ANTHROPIC_MODEL"] });
    expect(info.providers?.find((p) => p.id === "needsenv")?.why).toBe("the backend's env does not set EQUIP_TEST_UNSET");
  });

  test("a central provider is written here at 0600 and recorded; a hand file is left as it was", async () => {
    const file = join(providers(), "gw.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ env: { ANTHROPIC_BASE_URL: "http://gw:4000", ANTHROPIC_MODEL: "big" } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(providers(), "farp.json"))).toBe(false);
    expect(existsSync(join(providers(), "needsenv.json"))).toBe(false);
    expect(await readFile(join(providers(), "handp.json"), "utf8")).toContain("http://hand");
    const record = JSON.parse(await readFile(join(providers(), ".canopy-kit.json"), "utf8")) as { written: Record<string, string> };
    expect(Object.keys(record.written)).toEqual(["gw"]);
  });

  test("adopt moves the hand file aside for the kit's, and put back restores it", async () => {
    const adopted = await answer(await post("/api/kit/providers/adopt", { id: "handp" }));
    expect(adopted.status).toBe(200);
    expect(await providerOf("handp")).toMatchObject({ state: "ok", adopted: true });
    expect(await readFile(join(providers(), "handp.json"), "utf8")).toContain("http://kit");
    expect(await readFile(join(providers(), ".canopy-kit-adopted", "handp.json"), "utf8")).toContain("http://hand");
    // a second adopt has nothing to adopt
    expect((await post("/api/kit/providers/adopt", { id: "handp" })).status).toBe(409);

    expect((await post("/api/kit/providers/restore", { id: "handp" })).status).toBe(200);
    expect(await providerOf("handp")).toMatchObject({ state: "hand" });
    expect(await readFile(join(providers(), "handp.json"), "utf8")).toContain("http://hand");
    expect(existsSync(join(providers(), ".canopy-kit-adopted", "handp.json"))).toBe(false);
    // and the next scan leaves it alone
    expect((await post("/api/kit/scan", {})).status).toBe(200);
    expect(await readFile(join(providers(), "handp.json"), "utf8")).toContain("http://hand");
  });

  test("adopt refuses a provider that is not for this machine and one kit.json lacks", async () => {
    expect((await post("/api/kit/providers/adopt", { id: "farp" })).status).toBe(409);
    expect((await post("/api/kit/providers/adopt", { id: "nope" })).status).toBe(404);
    expect((await post("/api/kit/providers/adopt", {})).status).toBe(400);
  });
});

describe("a start that names no loadout", () => {
  test("takes the repo's default and says where it came from", async () => {
    const got = await start({});
    expect(got.status).toBe(201);
    expect(got.body.harness).toBe("codex");
    expect(got.body.equip).toMatchObject({ loadout: "cx", from: { from: "repo", key: "app" } });
  });

  test("a glob matches, an exact none stops it, and the machine's comes next", async () => {
    const one = await start({}, "tools/one");
    expect(one.body.equip).toMatchObject({ loadout: "gwy", provider: "gw", from: { from: "repo", key: "tools/*" } });
    const ctx = await ctxOf(one.body.id ?? "");
    expect(ctx.agent.provider).toBe("gw");
    // the run's one settings file is the provider's with the loadout's skills laid over
    const settings = JSON.parse(await readFile(ctx.spec.settings ?? "", "utf8")) as { env: Record<string, string> };
    expect(settings.env["ANTHROPIC_BASE_URL"]).toBe("http://gw:4000");

    const two = await start({}, "tools/two");
    expect(two.status).toBe(201);
    expect(two.body.equip).toBeUndefined();

    const plain = await start({}, "plain");
    expect(plain.body.equip).toMatchObject({ loadout: "docs", from: { from: "machine", key: "here" } });
  });

  test("a start's own pick beats the default, and none takes none", async () => {
    const picked = await start({ loadout: "feature" });
    expect(picked.body.equip).toMatchObject({ loadout: "feature" });
    expect(picked.body.equip?.from).toBeUndefined();
    const none = await start({ loadout: "none" });
    expect(none.status).toBe(201);
    expect(none.body.equip).toBeUndefined();
  });

  test("a default the start cannot run is passed over: plan, then build skips the codex one", async () => {
    const got = await start({ action: "propose" });
    expect(got.status).toBe(201);
    expect(got.body.equip).toMatchObject({ loadout: "docs", from: { from: "machine", key: "here" } });
    const why = (await (await get("/api/loadouts/resolve?id=app&action=propose")).json()) as LoadoutDefault;
    expect(why).toEqual({ name: "docs", from: "machine", key: "here", skipped: ["repo app: cx runs codex; plan, then build needs Claude Code"] });
  });

  test("resolve answers what a start would take", async () => {
    expect((await (await get("/api/loadouts/resolve?id=app")).json()) as LoadoutDefault).toEqual({ name: "cx", from: "repo", key: "app" });
    expect((await (await get("/api/loadouts/resolve?id=tools%2Ftwo")).json()) as LoadoutDefault).toEqual({ name: null, from: "repo", key: "tools/two" });
    expect((await get("/api/loadouts/resolve?id=nope")).status).toBe(404);
  });

  test("a loadout whose provider is not for this machine refuses a start that names it", async () => {
    const got = await start({ loadout: "far" });
    expect(got.status).toBe(400);
    expect(got.body.error).toBe("loadout far: provider farp is not for here");
  });

  test("a group never inherits", async () => {
    const got = await answer(await post("/api/repos/run?id=plain", { action: "ask", note: "x", times: 2, branch: true }));
    expect(got.body.error).toBeUndefined();
    expect(got.status).toBe(201);
    const runs = (await (await get("/api/runs")).json()) as Run[];
    const members = runs.filter((r) => r.repoId === "plain" && r.group !== undefined);
    for (const m of members) live.add(m.id);
    expect(members.length).toBe(2);
    expect(members.every((m) => m.equip === undefined)).toBe(true);
  });
});

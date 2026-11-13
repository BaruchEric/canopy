/**
 * A run started with a loadout from kit.json (FR-065), over real HTTP on a
 * server in `enforce`: a scratch kit.json whose one machine is this backend,
 * a scratch repo with a skill of its own, and a driver that holds each run
 * open until the test stops it. The run gets the loadout's model and effort,
 * one settings file of its own and the loadout's servers, and both files go
 * when it ends or fails to start.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { selfName } from "../core/backends";
import type { DriveCtx, RunDriver } from "../core/driver";
import { exec } from "../core/exec";
import { SEEDS_DIR } from "../core/sprout";
import { DEFAULT_AGENT, type Harness, type LoadoutsInfo, type Run } from "../core/types";
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
const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_CALLERS", "CANOPY_TMUX", "CANOPY_COORD_SOCKET", "CANOPY_BIND", "CANOPY_KIT"];

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const get = (p: string) => fetch(url(p), { headers: { "x-canopy-token": cli } });
const post = (p: string, body: unknown) =>
  fetch(url(p), { method: "POST", headers: { "content-type": "application/json", "x-canopy-token": cli }, body: JSON.stringify(body) });
type Answer = { status: number; body: Partial<Run> & { error?: string } };
const answer = async (res: Response): Promise<Answer> => ({ status: res.status, body: (await res.json()) as Answer["body"] });
/** runs that started, so each test's end stops them before the branch cap does */
const live = new Set<string>();
/** a branch ask in the scratch repo, with whatever the case adds */
async function start(extra: Record<string, unknown>, repo = "app"): Promise<Answer> {
  const got = await answer(await post(`/api/repos/run?id=${encodeURIComponent(repo)}`, { action: "ask", note: "x", branch: true, ...extra }));
  if (got.status === 201 && got.body.id) live.add(got.body.id);
  return got;
}
const toolsDir = () => join(config, "run-tools");
const held = async () => (await readdir(toolsDir()).catch(() => [] as string[])).sort();

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
/** a start that must go */
async function started(extra: Record<string, unknown>): Promise<Answer & { id: string }> {
  const got = await start(extra);
  if (got.status !== 201 || !got.body.id) throw new Error(`start: ${got.status} ${JSON.stringify(got.body)}`);
  return { ...got, id: got.body.id };
}
async function stop(id: string): Promise<void> {
  await post("/api/runs/stop", { id });
  await until(async () => {
    const r = ((await (await get("/api/runs")).json()) as Run[]).find((x) => x.id === id);
    return !r || (r.status !== "working" && r.branch?.state !== "working");
  }, `run ${id} to stop`);
  live.delete(id);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-loadout-route-"));
  for (const k of ENV) saved[k] = process.env[k];
  root = join(scratch, "root");
  config = join(scratch, "config");
  const proj = join(root, "app");
  await mkdir(join(proj, ".claude", "skills", "repo-skill"), { recursive: true });
  await writeFile(join(proj, ".claude", "skills", "repo-skill", "SKILL.md"), "---\nname: repo-skill\ndescription: the repo's own\n---\n\nDo the repo's thing.\n");
  await exec(["git", "init", "-q", "-b", "main", proj]);
  await exec(["git", "-C", proj, "add", "-A"]);
  await exec(["git", "-C", proj, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);
  const seed = join(root, SEEDS_DIR, "seedy");
  await mkdir(seed, { recursive: true });
  await exec(["git", "init", "-q", "-b", "main", seed]);
  await exec(["git", "-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"]);
  // the store target sits in the scratch folder, so the kit's scan never
  // fetches or lists the real ~/.claude
  const kitFile = join(scratch, "kit.json");
  await writeFile(kitFile, JSON.stringify({
    version: 1,
    machines: { here: { backend: selfName(null, hostname()) } },
    targets: [{ agent: "claude", skills: join(scratch, "store", "skills"), mode: "store" }],
    skills: {},
    mcp: { probe: { command: "bash", args: ["-c", "true"], machines: ["here"] } },
    loadouts: {
      docs: { model: "haiku", effort: "low", skills: ["repo-skill"] },
      tools: { skills: ["repo-skill"], mcp: ["probe"] },
      missing: { skills: ["nope-xyz"] },
      quick: { harness: "codex", effort: "low" },
    },
  }));
  process.env["CANOPY_CONFIG_DIR"] = config;
  process.env["CANOPY_CALLERS"] = "enforce";
  process.env["CANOPY_TMUX"] = "0";
  process.env["CANOPY_KIT"] = kitFile;
  delete process.env["CANOPY_COORD_SOCKET"];
  delete process.env["CANOPY_BIND"];
  const book = new CallerBook({ file: join(config, "callers.json") });
  cli = book.mint("cli", { label: "cli test" }).token;
  await book.flush();
  server = await startServer({ root, port: 0, chan: null, harnesses: ["claude", "codex"], runner: { driver: (h: Harness) => new HeldDriver(h) } });
  // a test server's kit never scans on its own
  expect((await post("/api/kit/scan", {})).status).toBe(200);
  await until(async () => ((await (await get("/api/loadouts")).json()) as LoadoutsInfo).loadouts.length === 4, "the kit's loadouts");
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

describe("a run started with a loadout", () => {
  test("a loadout run starts with its model, effort and one settings file", async () => {
    const run = await started({ loadout: "docs" });
    const ctx = await ctxOf(run.id);
    expect(ctx.agent).toMatchObject({ model: "haiku", effort: "low" });
    const settings = JSON.parse(await readFile(ctx.spec.settings ?? "", "utf8")) as { skillOverrides: Record<string, string> };
    expect(settings.skillOverrides["repo-skill"]).toBe("on");
    expect(Object.entries(settings.skillOverrides).filter(([k]) => k !== "repo-skill").every(([, v]) => v === "off")).toBe(true);
    expect(run.body.equip).toEqual({ loadout: "docs", model: "haiku", effort: "low", skills: ["repo-skill"], mcp: [], off: expect.any(Number) });
    // no servers and no tools: no mcp.json at all
    expect(ctx.spec.mcpConfig).toBeUndefined();
    expect(run.body.canopyTools).toBeUndefined();
  });

  test("a loadout's servers go in the run's mcp.json, without canopy's unless asked", async () => {
    const run = await started({ loadout: "tools" });
    const ctx = await ctxOf(run.id);
    expect(Object.keys((JSON.parse(await readFile(ctx.spec.mcpConfig ?? "", "utf8")) as { mcpServers: object }).mcpServers)).toEqual(["probe"]);
    expect(ctx.spec.servers).toEqual(["probe"]);
    expect(run.body.canopyTools).toBeUndefined();
    await stop(run.id);

    const withTools = await started({ loadout: "tools", canopyTools: true });
    const tctx = await ctxOf(withTools.id);
    const file = JSON.parse(await readFile(tctx.spec.mcpConfig ?? "", "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(Object.keys(file.mcpServers)).toEqual(["canopy", "probe"]);
    expect(file.mcpServers["probe"]).toMatchObject({ command: "bash", args: ["-c", "true"] });
    expect(tctx.spec.servers).toEqual(["probe"]);
    expect(withTools.body.canopyTools).toBe(true);
  });

  test("the files go when the run stops", async () => {
    const run = await started({ loadout: "tools", canopyTools: true });
    const { settings, mcpConfig } = (await ctxOf(run.id)).spec;
    expect(existsSync(settings ?? "")).toBe(true);
    expect(existsSync(mcpConfig ?? "")).toBe(true);
    await post("/api/runs/stop", { id: run.id });
    await until(async () => !existsSync(settings ?? "") && !existsSync(mcpConfig ?? ""), "the run's files to go");
    const callers = (await (await get("/api/auth")).json()) as { callers: { kind: string }[] };
    expect(callers.callers.filter((c) => c.kind === "run")).toEqual([]);
  });

  test("a start that fails after the files are written leaves none behind", async () => {
    const before = await held();
    // the runner refuses an empty note, after the files are written
    const refused = await start({ loadout: "tools", canopyTools: true, note: "" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("write what the agent should do first");
    expect(await held()).toEqual(before);
    const callers = (await (await get("/api/auth")).json()) as { callers: { kind: string }[] };
    expect(callers.callers.filter((c) => c.kind === "run")).toEqual([]);
  });

  test("a codex loadout takes its harness, model and effort, and writes no files", async () => {
    const before = await held();
    const run = await started({ loadout: "quick" });
    const ctx = await ctxOf(run.id);
    expect(ctx.agent).toMatchObject({ harness: "codex", effort: "low" });
    expect(ctx.spec.settings).toBeUndefined();
    expect(ctx.spec.mcpConfig).toBeUndefined();
    expect(run.body.equip).toEqual({ loadout: "quick", model: "default", effort: "low", skills: [], mcp: [], off: 0 });
    expect(await held()).toEqual(before);
    // the loadout's harness is the one the action checks
    const propose = await start({ loadout: "quick", action: "propose" });
    expect(propose.status).toBe(400);
    expect(propose.body.error).toBe("plan, then build needs Claude Code");
  });

  test.each([
    [{ loadout: "nope" }, 400, "no loadout named nope; kit.json has docs, tools, missing"],
    [{ loadout: "missing" }, 400, "loadout missing names nope-xyz, which"],
    [{ loadout: "docs", times: 2 }, 400, "a loadout starts one run; a group picks a profile per member"],
    [{ loadout: 7 }, 400, "loadout must be a loadout's name"],
    [{ loadout: "Not A Name" }, 400, "loadout must be a loadout's name"],
    [{ loadout: "docs", action: "coordinate", branch: undefined }, 400, "a coordinator starts without a loadout"],
  ])("%j is refused", async (extra, status, words) => {
    const before = await held();
    const res = await start(extra);
    expect(res.status).toBe(status);
    expect(res.body.error).toContain(words);
    expect(await held()).toEqual(before);
  });

  test("an incubator seed's run takes no loadout", async () => {
    const res = await start({ loadout: "docs", branch: false }, `${SEEDS_DIR}/seedy`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("an incubator seed's run takes no loadout");
  });

  test("a provider whose settings file cannot be read refuses the start", async () => {
    const pick = (provider: string | null) => post("/api/agents/scope", { kind: "task", name: "ask", pick: provider ? { ...DEFAULT_AGENT, harness: "claude", provider } : null });
    try {
      expect((await pick("absent")).status).toBe(200);
      const before = await held();
      const absent = await start({ loadout: "docs" });
      expect(absent.status).toBe(400);
      expect(absent.body.error).toContain(`provider absent's settings file ${join(config, "providers", "absent.json")} cannot be read`);
      await mkdir(join(config, "providers"), { recursive: true });
      await writeFile(join(config, "providers", "broken.json"), "{ not json");
      expect((await pick("broken")).status).toBe(200);
      const broken = await start({ loadout: "docs" });
      expect(broken.status).toBe(400);
      expect(broken.body.error).toContain(`provider broken's settings file ${join(config, "providers", "broken.json")} cannot be read`);
      expect(await held()).toEqual(before);
    } finally {
      await pick(null);
    }
  });

  test("a provider's settings go under the loadout's skill overrides", async () => {
    const pick = (provider: string | null) => post("/api/agents/scope", { kind: "task", name: "ask", pick: provider ? { ...DEFAULT_AGENT, harness: "claude", provider } : null });
    await mkdir(join(config, "providers"), { recursive: true });
    await writeFile(join(config, "providers", "local.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" }, skillOverrides: { "repo-skill": "off", kept: "on" } }));
    try {
      expect((await pick("local")).status).toBe(200);
      const run = await started({ loadout: "docs" });
      const settings = JSON.parse(await readFile((await ctxOf(run.id)).spec.settings ?? "", "utf8")) as { env: Record<string, string>; skillOverrides: Record<string, string> };
      expect(settings.env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" });
      expect(settings.skillOverrides).toMatchObject({ "repo-skill": "on", kept: "on" });
    } finally {
      await pick(null);
    }
  });

  test("the kept run.json keeps equip", async () => {
    const run = await started({ loadout: "docs" });
    await ctxOf(run.id);
    await stop(run.id);
    const file = join(config, "runs", run.id, "run.json");
    const kept = await until(async () => existsSync(file) && (JSON.parse(await readFile(file, "utf8")) as Run), "the kept run.json");
    expect(kept.equip).toMatchObject({ loadout: "docs", model: "haiku" });
  });
});

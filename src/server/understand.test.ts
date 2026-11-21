import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import { UNDERSTAND_VERSION } from "../core/understand";
import {
  UNDERSTAND_SOURCE,
  keepOutOfGit,
  liveServer,
  openUnderstand,
  pluginDir,
  pluginInfo,
  preparedNow,
  skillScripts,
  sourceFiles,
  sourceKey,
  startPrepare,
  stopUnderstand,
  understandEnv,
  understandInfo,
} from "./understand";

// A two-file shop with a hand-written graph in place of the model's, and a
// stand-in for the prepared copy holding canopy's real viewer.mjs: a real
// viewer, real git, no claude and no install.
let root = "";
let config = "";
const savedConfig = process.env["CANOPY_CONFIG_DIR"];
const git = (...args: string[]) => exec(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root });

const graph = (commit: string) => ({
  version: "1.0.0",
  project: { name: "shop", languages: ["typescript"], frameworks: [], description: "A shop.", analyzedAt: "2026-11-20T09:00:00.000Z", gitCommitHash: commit },
  nodes: [
    { id: "file:src/a.ts", type: "file", name: "a.ts", filePath: "src/a.ts", summary: "Adds.", tags: [], complexity: "simple" },
    { id: "file:src/b.ts", type: "file", name: "b.ts", filePath: "src/b.ts", summary: "Prints.", tags: [], complexity: "simple" },
  ],
  edges: [{ source: "file:src/b.ts", target: "file:src/a.ts", type: "imports", direction: "forward", weight: 1 }],
  layers: [],
  tour: [],
});

/** a prepared copy without the install: the stamp, canopy's viewer.mjs,
 *  a page and a staleness module standing in for the built ones */
function fakeCopy(): void {
  const viewer = join(pluginDir(), "packages", "viewer");
  mkdirSync(join(viewer, "bin", "dist"), { recursive: true });
  mkdirSync(join(viewer, "dist"), { recursive: true });
  cpSync(join(UNDERSTAND_SOURCE, "packages", "viewer", "bin", "viewer.mjs"), join(viewer, "bin", "viewer.mjs"));
  writeFileSync(join(viewer, "bin", "dist", "staleness.js"), "export async function getGraphFreshnessBatch() { return {}; }\n");
  writeFileSync(join(viewer, "dist", "index.html"), "<!doctype html><title>Understand Anything</title>\n");
  writeFileSync(join(pluginDir(), ".canopy-prepared"), "{}\n");
}

beforeAll(async () => {
  config = realpathSync(mkdtempSync(join(tmpdir(), "canopy-understand-config-")));
  process.env["CANOPY_CONFIG_DIR"] = config;
  root = realpathSync(mkdtempSync(join(tmpdir(), "canopy-understand-")));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export const add = (a: number, b: number) => a + b;\n");
  writeFileSync(join(root, "src/b.ts"), 'import { add } from "./a";\nconsole.log(add(1, 2));\n');
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-qm", "init");
});

afterAll(async () => {
  if (root) {
    await stopUnderstand(root);
    rmSync(root, { recursive: true, force: true });
  }
  if (config) rmSync(config, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = savedConfig;
  delete process.env["UNDERSTAND_IDLE_MS"];
});

test("the source key follows the files' paths and bytes, and skips installs and builds", () => {
  const dir = mkdtempSync(join(tmpdir(), "canopy-understand-key-"));
  try {
    writeFileSync(join(dir, "a.txt"), "one");
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "i.js"), "1");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "b.js"), "2");
    expect(sourceFiles(dir)).toEqual(["a.txt"]);
    const first = sourceKey(dir);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    writeFileSync(join(dir, "node_modules", "x", "i.js"), "changed");
    expect(sourceKey(dir)).toBe(first);
    // canopy's notes change nothing that runs
    writeFileSync(join(dir, "VENDOR.md"), "notes");
    expect(sourceKey(dir)).toBe(first);
    writeFileSync(join(dir, "a.txt"), "two");
    expect(sourceKey(dir)).not.toBe(first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canopy's copy holds the plugin without its hooks, with a bun.lock and the workspaces bun needs", () => {
  const files = sourceFiles(UNDERSTAND_SOURCE);
  expect(files).toContain(".claude-plugin/plugin.json");
  expect(files).toContain("skills/understand/SKILL.md");
  expect(files).toContain("bun.lock");
  expect(files.some((f) => f.startsWith("hooks/"))).toBe(false);
  expect(files.some((f) => f.startsWith("packages/mcp/"))).toBe(false);
  const pkg: unknown = JSON.parse(readFileSync(join(UNDERSTAND_SOURCE, "package.json"), "utf8"));
  expect(pkg).toMatchObject({ version: UNDERSTAND_VERSION, workspaces: ["packages/*"] });
  const plugin: unknown = JSON.parse(readFileSync(join(UNDERSTAND_SOURCE, ".claude-plugin", "plugin.json"), "utf8"));
  expect(plugin).toMatchObject({ name: "understand-anything", version: UNDERSTAND_VERSION });
  expect(skillScripts(join(UNDERSTAND_SOURCE, "skills", "understand"))).toEqual(expect.arrayContaining(["scan-project.mjs", "merge-batch-graphs.py"]));
});

test("the run's env keeps a graph in the checkout it was asked about and finds python", () => {
  const env = understandEnv();
  expect(env["UNDERSTAND_NO_WORKTREE_REDIRECT"]).toBe("1");
  const dirs = (env["PATH"] ?? "").split(":");
  expect(dirs.some((d) => Bun.which("python", { PATH: d }) !== null)).toBe(Bun.which("python3") !== null || Bun.which("python") !== null);
});

describe("a checkout's graph, read and served", () => {
  test("no graph yet reads as none, the plugin unprepared, no server", async () => {
    expect(pluginInfo()).toEqual({ state: "unprepared" });
    expect(await understandInfo(root, null)).toMatchObject({ state: "none", folder: ".ua", behind: null, server: null, run: null, plugin: { state: "unprepared" } });
    await expect(openUnderstand(root)).rejects.toThrow("there is no graph here yet");
  });

  test("keepOutOfGit ignores the folder, and leaves a folder the repo tracks alone", async () => {
    await keepOutOfGit(root, ".ua");
    expect(readFileSync(join(root, ".ua", ".gitignore"), "utf8")).toContain("*");
    writeFileSync(join(root, ".ua", "scratch.json"), "{}");
    expect((await git("status", "--porcelain")).stdout.trim()).toBe("");

    mkdirSync(join(root, ".understand-anything"));
    writeFileSync(join(root, ".understand-anything", "knowledge-graph.json"), "{}");
    await git("add", ".understand-anything");
    await keepOutOfGit(root, ".understand-anything");
    expect(existsSync(join(root, ".understand-anything", ".gitignore"))).toBe(false);
    await git("rm", "-rq", "--cached", ".understand-anything");
    rmSync(join(root, ".understand-anything"), { recursive: true });
  });

  test("a graph reads with its size, its commit and the commits since", async () => {
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    writeFileSync(join(root, ".ua", "knowledge-graph.json"), JSON.stringify(graph(head)));
    expect(await understandInfo(root, "r9")).toMatchObject({ state: "graph", nodes: 2, files: 2, edges: 1, commit: head, behind: 0, changed: 0, domain: false, lessons: false, run: "r9" });
    writeFileSync(join(root, "src/c.ts"), "export const c = 3;\n");
    await git("add", "-A");
    await git("commit", "-qm", "c");
    expect(await understandInfo(root, null)).toMatchObject({ behind: 1, changed: 1 });
    writeFileSync(join(root, ".ua", "meta.json"), JSON.stringify({ lastAnalyzedAt: "2026-11-21T00:00:00.000Z", gitCommitHash: (await git("rev-parse", "HEAD")).stdout.trim(), version: "1", analyzedFiles: 3 }));
    expect(await understandInfo(root, null)).toMatchObject({ behind: 0, analyzedAt: "2026-11-21T00:00:00.000Z" });
    writeFileSync(join(root, ".ua", "knowledge-graph.json"), "{ not json");
    expect(await understandInfo(root, null)).toMatchObject({ state: "unknown", error: "knowledge-graph.json is not valid JSON" });
    writeFileSync(join(root, ".ua", "knowledge-graph.json"), JSON.stringify(graph(head)));
  });

  test("the viewer waits for the prepared copy, then starts, answers with its token and stops", async () => {
    await expect(openUnderstand(root)).rejects.toThrow("not ready");
    fakeCopy();
    expect(pluginInfo()).toEqual({ state: "ready" });
    const { port, token } = await openUnderstand(root);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect((await liveServer(root))?.port).toBe(port);
    expect((await understandInfo(root, null)).server).toEqual({ port });
    // a second open finds the same viewer
    expect(await openUnderstand(root)).toEqual({ port, token });

    expect((await fetch(`http://127.0.0.1:${port}/knowledge-graph.json`)).status).toBe(403);
    const got = await fetch(`http://127.0.0.1:${port}/knowledge-graph.json?token=${token}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ project: { name: "shop" }, nodes: [{ filePath: "src/a.ts" }, { filePath: "src/b.ts" }] });
    const file = await fetch(`http://127.0.0.1:${port}/file-content.json?token=${token}&path=src/a.ts`);
    expect(await file.json()).toMatchObject({ path: "src/a.ts", language: "typescript" });
    // a file the graph does not list is never served
    expect((await fetch(`http://127.0.0.1:${port}/file-content.json?token=${token}&path=src/c.ts`)).status).toBe(404);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain("Understand Anything");

    expect(await stopUnderstand(root)).toBe(true);
    expect(await liveServer(root)).toBeNull();
    expect(await stopUnderstand(root)).toBe(false);
  }, 30_000);

  test("canopy's copy of the viewer stops itself once idle", async () => {
    process.env["UNDERSTAND_IDLE_MS"] = "800";
    try {
      const { port } = await openUnderstand(root);
      expect((await liveServer(root))?.port).toBe(port);
      for (const end = Date.now() + 8_000; Date.now() < end && (await liveServer(root)); ) await Bun.sleep(300);
      expect(await liveServer(root)).toBeNull();
    } finally {
      delete process.env["UNDERSTAND_IDLE_MS"];
    }
  }, 15_000);
});

// The real prepare installs from npm and builds, a minute or more: run it
// with CANOPY_UNDERSTAND_IT=1.
test.skipIf(!process.env["CANOPY_UNDERSTAND_IT"])(
  "a prepare installs and builds the plugin into the config dir",
  async () => {
    rmSync(join(config, "understand"), { recursive: true, force: true });
    expect(startPrepare().state).toBe("preparing");
    expect(startPrepare().state).toBe("preparing");
    expect(await preparedNow()).toEqual({ state: "ready" });
    const dir = pluginDir();
    expect(existsSync(join(dir, "packages", "core", "dist", "index.js"))).toBe(true);
    expect(existsSync(join(dir, "packages", "viewer", "dist", "index.html"))).toBe(true);
    expect(existsSync(join(dir, "packages", "viewer", "bin", "dist", "staleness.js"))).toBe(true);
    mkdirSync(join(root, ".ua"), { recursive: true });
    const scan = await exec(["node", join(dir, "skills", "understand", "scan-project.mjs"), root, join(root, ".ua", "scan.json")], { cwd: root, timeoutMs: 60_000 });
    expect(scan.stderr).toContain("scan-project: filesScanned=");
    expect(scan.code).toBe(0);
    if (!existsSync(join(root, ".ua", "knowledge-graph.json"))) writeFileSync(join(root, ".ua", "knowledge-graph.json"), JSON.stringify(graph("0".repeat(40))));
    const { port, token } = await openUnderstand(root);
    expect(await (await fetch(`http://127.0.0.1:${port}/?token=${token}`)).text()).toContain("<div id=\"root\">");
    await stopUnderstand(root);
  },
  600_000,
);

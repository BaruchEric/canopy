import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import { FLOORPLAN_SKILL, floorplanInfo, floorplanNode, floorplanPath, liveServer, openFloorplan, readFloorplanStatus, stopFloorplan } from "./floorplan";

// A two-file shop with one endpoint and a page that calls it, mapped by
// canopy's own copy of Floorplan with a hand-written architecture.json in
// place of the model's: real scripts, a real server, no claude.
let root = "";
const node = floorplanNode();
const script = (name: string, ...args: string[]) => exec([node, join(FLOORPLAN_SKILL, "scripts", name), root, ...args], { cwd: root, timeoutMs: 60_000 });

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "canopy-floorplan-")));
  mkdirSync(join(root, "src", "server"), { recursive: true });
  mkdirSync(join(root, "src", "web"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "name": "shop", "type": "module", "dependencies": { "express": "^4" } }\n');
  writeFileSync(join(root, "src/server/index.js"), "import express from 'express';\nconst app = express();\napp.get('/api/orders', (req, res) => res.json([]));\napp.listen(3000);\n");
  writeFileSync(join(root, "src/web/app.js"), "export async function load() { return (await fetch('/api/orders')).json(); }\n");
  const git = (...args: string[]) => exec(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-qm", "init");
});

afterAll(async () => {
  if (root) {
    await stopFloorplan(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("floorplanPath puts node's and claude's folders first, once each", () => {
  expect(floorplanPath("/opt/homebrew/bin/node", "/Users/e/.local/bin/claude", "/usr/bin:/opt/homebrew/bin:/bin")).toBe("/opt/homebrew/bin:/Users/e/.local/bin:/usr/bin:/bin");
  expect(floorplanPath("/usr/bin/node", null, "")).toBe("/usr/bin");
});

describe("a checkout's map, through the real scripts", () => {
  test("no map yet reads as none, with no server", async () => {
    expect((await readFloorplanStatus(root)).state).toBe("none");
    expect(await floorplanInfo(root, null)).toMatchObject({ state: "none", server: null, run: null });
  }, 30_000);

  test("a built map reads as one, and its server starts, answers through its status and stops", async () => {
    expect((await script("scan.mjs")).code).toBe(0);
    writeFileSync(
      join(root, "floorplan", "architecture.json"),
      JSON.stringify({
        project: { name: "Shop", summary: "Takes orders." },
        nodes: [
          { id: "server", label: "Main server", kind: "service", summary: "Answers the order list.", paths: ["src/server/**"] },
          { id: "web", label: "Website", kind: "ui", summary: "Shows the orders.", paths: ["src/web/**"] },
        ],
      }),
    );
    const built = await script("build.mjs");
    expect(built.code).toBe(0);
    expect(await floorplanInfo(root, "r9")).toMatchObject({ state: "map", files: 2, nodes: 2, changed: 0, server: null, run: "r9" });

    // a serve.mjs that is not canopy's copy's is never started
    const served = join(root, "floorplan", "serve.mjs");
    const bytes = readFileSync(served);
    writeFileSync(served, `${bytes.toString("utf8")}\n// edited\n`);
    await expect(openFloorplan(root)).rejects.toThrow("not the one canopy's Floorplan");
    writeFileSync(served, bytes);

    const { port } = await openFloorplan(root);
    expect(port).toBeGreaterThanOrEqual(4378);
    expect((await liveServer(root))?.port).toBe(port);
    expect((await floorplanInfo(root, null)).server).toEqual({ port });
    // a second open finds the same server
    expect((await openFloorplan(root)).port).toBe(port);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("window.FLOORPLAN_SERVER");

    // a stop answers once the server is gone, so the read straight after
    // finds none and the page never frames it again
    expect(await stopFloorplan(root)).toBe(true);
    expect(await liveServer(root)).toBeNull();
    expect(await stopFloorplan(root)).toBe(false);
  }, 120_000);
});

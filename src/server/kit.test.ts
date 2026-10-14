import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../core/exec";
import type { ServerEvent } from "../core/types";
import { KitHub } from "./kit";

let dirs: string[] = [];
let hubs: KitHub[] = [];
afterEach(() => {
  for (const h of hubs) h.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  hubs = []; dirs = [];
});

const MANIFEST = {
  version: 1,
  machines: { mac: { backend: "mac" }, mini: { backend: "mini" }, gpd: { ssh: "gpd", via: "mac", dev: "/home/eric/dev" } },
  targets: [
    { agent: "claude", skills: "~/.claude/skills", mode: "store" },
    { agent: "codex", skills: "~/.codex/skills", mode: "link" },
  ],
  skills: {},
};

async function setup(manifest: unknown = MANIFEST) {
  const h = mkdtempSync(join(tmpdir(), "kithub-"));
  dirs.push(h);
  const store = join(h, ".claude");
  await exec(["git", "init", "-q", "-b", "main", store]);
  mkdirSync(join(store, "skills/ship"), { recursive: true });
  writeFileSync(join(store, "skills/ship/SKILL.md"), "x");
  await exec(["git", "-C", store, "add", "."]);
  await exec(["git", "-C", store, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  mkdirSync(join(h, ".codex/skills"), { recursive: true });
  const kitPath = join(store, "kit.json");
  writeFileSync(kitPath, typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  const events: ServerEvent[] = [];
  // gpd answers like a Tailscale SSH browser check; everything local runs for real
  const run = async (host: string | null, cmd: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) =>
    host === "gpd" ? { code: 255, stdout: "", stderr: "# Tailscale SSH requires an additional check." } : exec(cmd, opts);
  const hub = new KitHub({ self: "mac", devRoot: join(h, "dev"), kitPath, broadcast: (e) => events.push(e), run, env: { HOME: h }, every: 0 });
  hubs.push(hub);
  return { h, hub, events };
}

describe("KitHub", () => {
  test("scans its own machine and the ssh machine it is via, and broadcasts", async () => {
    const { hub, events } = await setup();
    const info = await hub.scan();
    expect(info.ok).toBe(true);
    expect(info.machines.map((m) => m.machine)).toEqual(["mac", "gpd"]);
    expect(info.machines[1]!.seen.away).toBe("Tailscale SSH requires an additional check.");
    expect(info.machines[0]!.plan).toEqual([{ kind: "link", agent: "codex", name: "ship", link: "../../.claude/skills/ship" }]);
    expect(events.at(-1)).toEqual({ type: "kit", kit: info });
  });
  test("apply carries out the plan and rescans; a dry run changes nothing", async () => {
    const { hub } = await setup();
    await hub.scan();
    const dry = await hub.apply("mac", undefined, true);
    expect(dry.done).toHaveLength(1);
    expect(hub.info().machines[0]!.plan).toHaveLength(1);
    const real = await hub.apply("mac");
    expect(real.failed).toEqual([]);
    expect(hub.info().machines[0]!.plan).toEqual([]);
  });
  test("routes: GET, scan, apply; unknown machine 400, away machine 409", async () => {
    const { hub } = await setup();
    await hub.scan();
    const call = (method: string, path: string, body?: unknown) =>
      hub.handle(new Request(`http://x${path}`, { method, body: body ? JSON.stringify(body) : undefined }), new URL(`http://x${path}`));
    expect((await call("GET", "/api/kit"))!.status).toBe(200);
    expect((await call("POST", "/api/kit/scan"))!.status).toBe(200);
    expect((await call("POST", "/api/kit/apply", { machine: "nope" }))!.status).toBe(400);
    expect((await call("POST", "/api/kit/apply", { machine: "gpd" }))!.status).toBe(409);
    expect(await call("GET", "/api/other")).toBeNull();
  });
  test("a malformed kit.json is an error with no machines, and apply refuses (review focus 5)", async () => {
    const { hub } = await setup("{ not json");
    const info = await hub.scan();
    expect(info).toMatchObject({ ok: false, machines: [], cells: [] });
    expect(info.error).toContain("kit.json");
    await expect(hub.apply("mac")).rejects.toThrow();
  });
  test("an action not in the plan is refused", async () => {
    const { hub } = await setup();
    await hub.scan();
    await expect(hub.apply("mac", [{ kind: "remove", agent: "codex", name: "ship" }])).rejects.toThrow("not in the current plan");
  });
});

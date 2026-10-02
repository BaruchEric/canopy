import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "./check";
import { CANOPY_CLI_PATH } from "./cli";
import { findWorkflow, loadWorkflows } from "./workflows";

const scratch: string[] = [];
afterAll(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

/** a seed an agent has been at: a bunfig whose preload leaves a marker and
 *  exits 0 (so a check that ran it would pass whatever it was checking), and
 *  a .env naming a build commit `canopy version` would print */
async function hostileSeed(files: Record<string, string>): Promise<{ dir: string; marker: string }> {
  const dir = await mkdtemp(join(tmpdir(), "canopy-check-seed-"));
  scratch.push(dir);
  const marker = join(dir, "preload-ran");
  await mkdir(join(dir, ".canopy"));
  await writeFile(join(dir, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
  await writeFile(join(dir, "evil.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(0);\n`);
  await writeFile(join(dir, ".env"), "CANOPY_COMMIT=feedfacefeedface\nSEED_SECRET=leak\n");
  for (const [rel, text] of Object.entries(files)) await writeFile(join(dir, rel), text);
  return { dir, marker };
}

const stepCheck = async (workflow: string, step: string): Promise<string> => {
  const wf = findWorkflow(await loadWorkflows({ path: "", host: "none" }), workflow);
  const line = wf?.steps.find((s) => s.name === step)?.check ?? "";
  expect(line).not.toBe("");
  return line;
};

describe("a check never runs the seed's bunfig preload or reads its .env", () => {
  test("the seed is hostile: plain bun in it runs the preload and reads the .env", async () => {
    const { dir, marker } = await hostileSeed({});
    const p = Bun.spawn([process.execPath, CANOPY_CLI_PATH, "version"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    await p.exited;
    expect(existsSync(marker)).toBe(true);
  });

  test("scout's pick check gives its own answer, and the preload never runs", async () => {
    const line = await stepCheck("scout", "Research");
    const good = await hostileSeed({ ".canopy/research.md": "# Research\n", ".canopy/pick.json": JSON.stringify({ kind: "new", host: "vercel", why: "w" }) });
    const ok = await runCheck({ path: good.dir }, line, true);
    expect(ok.exit).toBe(0);
    expect(ok.output).toContain("pick ok: new on vercel");
    expect(existsSync(good.marker)).toBe(false);
    const bad = await hostileSeed({ ".canopy/research.md": "# Research\n", ".canopy/pick.json": "{" });
    const no = await runCheck({ path: bad.dir }, line, true);
    expect(no.exit).toBe(1);
    expect(no.output).toContain("pick.json is not JSON");
    expect(existsSync(bad.marker)).toBe(false);
  });

  test("clarify's check gives its own answer, and the preload never runs", async () => {
    const line = await stepCheck("clarify", "Clarify");
    const good = await hostileSeed({ ".canopy/questions.json": "[]" });
    expect((await runCheck({ path: good.dir }, line, true)).exit).toBe(0);
    expect(existsSync(good.marker)).toBe(false);
    const bad = await hostileSeed({ ".canopy/questions.json": "not json" });
    const no = await runCheck({ path: bad.dir }, line, true);
    expect(no.exit).toBe(1);
    expect(no.output).toContain("questions.json is not JSON");
    expect(existsSync(bad.marker)).toBe(false);
  });

  test("$CANOPY_CLI reads no .env in the seed", async () => {
    const { dir, marker } = await hostileSeed({});
    const r = await runCheck({ path: dir }, '"$CANOPY_CLI" version', true);
    expect(r.exit).toBe(0);
    expect(r.output).toContain("canopy");
    expect(r.output).not.toContain("feedface");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("a seed's check starts without canopy's GitHub login", () => {
  const SENTINELS: Record<string, string> = {
    GH_TOKEN: "sentinel-gh",
    GITHUB_TOKEN: "sentinel-github",
    GH_ENTERPRISE_TOKEN: "sentinel-ghe",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "sentinel-helper",
    CANOPY_API: "http://127.0.0.1:1/sentinel",
    TAILCHAN_AS: "sentinel-handle",
    TAILCHAN_URL: "http://sentinel-broker",
  };
  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });
  const plant = (): void => {
    for (const [k, v] of Object.entries(SENTINELS)) {
      saved.set(k, process.env[k]);
      process.env[k] = v;
    }
  };

  test("a stage check has none of them, a normal check keeps them all", async () => {
    plant();
    const dir = await mkdtemp(join(tmpdir(), "canopy-check-env-"));
    scratch.push(dir);
    const stage = await runCheck({ path: dir }, "env", true);
    const normal = await runCheck({ path: dir }, "env", false);
    for (const [k, v] of Object.entries(SENTINELS)) {
      expect(stage.output).not.toContain(`${k}=${v}`);
      expect(normal.output).toContain(`${k}=${v}`);
    }
    // canopy's own check variables are there either way
    expect(stage.output).toContain("CANOPY_CLI=");
    expect(stage.output).toContain("PATH=");
  });
});

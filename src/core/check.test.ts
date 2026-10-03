import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinCheck } from "./builtincheck";
import { runCheck } from "./check";
import { CANOPY_CLI_PATH } from "./cli";
import { startStageRunner } from "../stage/runner";
import { StageClient } from "./stageclient";
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
    const ok = await builtinCheck(line, good.dir);
    expect(ok.exit).toBe(0);
    expect(ok.output).toContain("pick ok: new on vercel");
    expect(existsSync(good.marker)).toBe(false);
    const bad = await hostileSeed({ ".canopy/research.md": "# Research\n", ".canopy/pick.json": "{" });
    const no = await builtinCheck(line, bad.dir);
    expect(no.exit).toBe(1);
    expect(no.output).toContain("pick.json is not JSON");
    expect(existsSync(bad.marker)).toBe(false);
  });

  test("clarify's check gives its own answer, and the preload never runs", async () => {
    const line = await stepCheck("clarify", "Clarify");
    const good = await hostileSeed({ ".canopy/questions.json": "[]" });
    expect((await builtinCheck(line, good.dir)).exit).toBe(0);
    expect(existsSync(good.marker)).toBe(false);
    const bad = await hostileSeed({ ".canopy/questions.json": "not json" });
    const no = await builtinCheck(line, bad.dir);
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

describe("a stage check", () => {
  test("runs through the client, and with none it says the runner is not answering", async () => {
    const calls: { argv: string[]; cwd: string; env?: Record<string, string> }[] = [];
    const client = {
      exec: async (argv: string[], o: { cwd: string; timeoutMs: number; env?: Record<string, string> }) => (
        calls.push({ argv, cwd: o.cwd, ...(o.env ? { env: o.env } : {}) }), { code: 0, stdout: "ok", stderr: "" }
      ),
    } as unknown as StageClient;
    expect(await runCheck({ path: "/w/_incubator/coin" }, "bun test", true, client)).toEqual({ exit: 0, output: "ok" });
    // no env of canopy's: the runner builds the child's own
    // and no login shell: nothing a stage wrote into ~/.profile runs ahead of it
    expect(calls).toEqual([{ argv: ["sh", "-c", "bun test"], cwd: "/w/_incubator/coin" }]);
    expect(await runCheck({ path: "/w/_incubator/coin" }, "bun test", true, null)).toEqual({ exit: 127, output: "the stage runner is not answering", away: true });
  });

  test("with no runner set up, a stage check says the words it is handed", async () => {
    const why = "stages need the stage runner (CANOPY_STAGE_SOCKET), or CANOPY_INCUBATOR_UNISOLATED=1";
    expect(await runCheck({ path: "/w/_incubator/coin" }, "bun test", true, null, why)).toEqual({ exit: 127, output: why, away: true });
  });

  test("a check whose connection fails is away only when a hello finds no runner either", async () => {
    let up = false;
    const client = {
      exec: async () => ({ code: 127, stdout: "", stderr: "the stage runner is not answering: connect ENOENT /s.sock\n" }),
      hello: async () => (up ? ["claude"] : null),
    } as unknown as StageClient;
    const away = await runCheck({ path: "/w/_incubator/coin" }, "bun test", true, client);
    // the runner's words alone, not the connection's error
    expect(away).toEqual({ exit: 127, output: "the stage runner is not answering", away: true });
    up = true;
    // the runner answers: the words came from the command, which is a failed check
    const said = await runCheck({ path: "/w/_incubator/coin" }, "bun test", true, client);
    expect(said.exit).toBe(127);
    expect(said.away).toBeUndefined();
  });

  test("through a real runner, a ~/.profile a stage wrote is never sourced", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "canopy-check-profile-")));
    scratch.push(dir);
    const seed = join(dir, "_incubator", "coin");
    await mkdir(seed, { recursive: true });
    const marker = join(dir, "profile-ran");
    await writeFile(join(dir, ".profile"), `touch ${marker}\n`);
    const socket = join(dir, "s.sock");
    const runner = await startStageRunner({
      socket,
      root: join(dir, "_incubator"),
      env: { PATH: process.env["PATH"], HOME: dir, CANOPY_FENCE_PROBE: "http://probe.test/" },
      probe: async () => ({ result: "blocked" }),
    });
    try {
      const r = await runCheck({ path: seed }, "echo checked", true, new StageClient(socket));
      expect(r).toEqual({ exit: 0, output: "checked" });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await runner.stop();
    }
  });

  test("a check the runner refuses for its fence waits for the fence, in the runner's words", async () => {
    const client = {
      exec: async () => ({ code: 126, stdout: "", stderr: "the fence is down: http://192.168.1.1/ answered\n", unfenced: "the fence is down: http://192.168.1.1/ answered" }),
      hello: async () => ["claude"],
    } as unknown as StageClient;
    expect(await runCheck({ path: "/w/_incubator/coin" }, "bun test", true, client)).toEqual({
      exit: 126,
      output: "the fence is down: http://192.168.1.1/ answered",
      away: true,
    });
    // the same words from the command itself are only a failed check
    const said = { exec: async () => ({ code: 126, stdout: "", stderr: "the fence is down: http://192.168.1.1/ answered\n" }) } as unknown as StageClient;
    expect((await runCheck({ path: "/w/_incubator/coin" }, "bun test", true, said)).away).toBeUndefined();
  });

  test("its output is capped like a local check's, stderr after stdout", async () => {
    const client = { exec: async () => ({ code: 1, stdout: "x".repeat(5000), stderr: "boom" }) } as unknown as StageClient;
    const r = await runCheck({ path: "/w/_incubator/coin" }, "bun test", true, client);
    expect(r.exit).toBe(1);
    expect(r.output.startsWith("…")).toBe(true);
    expect(r.output.endsWith("x\nboom")).toBe(true);
    expect(r.output.length).toBe(4001);
  });

  test("an undefined client keeps the local exec", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-check-local-"));
    scratch.push(dir);
    expect(await runCheck({ path: dir }, "echo here", true, undefined)).toEqual({ exit: 0, output: "here" });
  });
});

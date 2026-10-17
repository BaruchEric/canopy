/**
 * The tokens a shell carries: minted into its environment when it starts,
 * dropped when it ends, pruned at start-up when its shell is gone, and none
 * in a run's. Against real servers on a scratch root; plain ptys
 * (`CANOPY_TMUX=0`), so nothing here touches a tmux server. The book keeps
 * hashes, so a token is looked for in callers.json by its hash.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnEnv } from "../core/driver";
import { runEnv } from "../core/runner";
import { startServer } from "./index";

setDefaultTimeout(30_000);

type Up ={ port: number; stop: () => void | Promise<void> };

let scratch: string;
let config: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_TMUX", "CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_CALLERS", "CANOPY_TOKEN"];
const dec = new TextDecoder();
const sha = (token: string): string => createHash("sha256").update(token).digest("hex");

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-callers-env-"));
  for (const k of ENV) saved[k] = process.env[k];
  config = join(scratch, "config");
  process.env["CANOPY_CONFIG_DIR"] = config;
  process.env["CANOPY_TMUX"] = "0";
  process.env["CANOPY_CALLERS"] = "log";
  delete process.env["CANOPY_BIND"];
  delete process.env["CANOPY_PUBLIC_ORIGIN"];
  const repo = join(scratch, "root", "app");
  await Bun.$`mkdir -p ${repo} && git -C ${repo} init -q`.quiet();
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

const start = (): Promise<Up> => startServer({ root: join(scratch, "root"), port: 0 });

/** whether callers.json holds this token's hash; the write is queued, so
 *  `want` is waited for rather than read once */
async function held(token: string, want: boolean): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    let now = false;
    try {
      const file = JSON.parse(await readFile(join(config, "callers.json"), "utf8")) as { hash: string }[];
      now = file.some((c) => c.hash === sha(token));
    } catch {
      // not written yet
    }
    if (now === want) return want;
    await Bun.sleep(50);
  }
  return !want;
}

/** a shell on a pty that prints its CANOPY_TOKEN; resolves the token */
async function shellToken(s: Up, id: string): Promise<{ token: string; ws: WebSocket }> {
  const q = new URLSearchParams({ id: "app", cols: "200", rows: "24", term: id, place: "strip" });
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/term?${q}`);
  ws.binaryType = "arraybuffer";
  let out = "";
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data !== "string") out += dec.decode(new Uint8Array(e.data));
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket failed"));
  });
  ws.send(new TextEncoder().encode('echo "tok=$CANOPY_TOKEN="\n'));
  for (let i = 0; i < 300; i++) {
    const m = /tok=(cnp_shell_[A-Za-z0-9_-]+)=/.exec(out);
    if (m?.[1]) return { token: m[1], ws };
    await Bun.sleep(50);
  }
  throw new Error(`no token in the shell's output: ${out}`);
}

describe("tokens in a child's env", () => {
  test("a shell has a token, the book holds it, and ending the shell drops it", async () => {
    const s = await start();
    try {
      const id = "abcdefabcdefabcdefabcdefabcdef11";
      const { token } = await shellToken(s, id);
      expect(token.startsWith("cnp_shell_")).toBe(true);
      expect(await held(token, true)).toBe(true);
      const res = await fetch(`http://127.0.0.1:${s.port}/api/terms?term=${id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await held(token, false)).toBe(false);
    } finally {
      await s.stop();
    }
  });

  test("a CANOPY_TOKEN in canopy's own env is gone once it starts", async () => {
    process.env["CANOPY_TOKEN"] = "cnp_page_outer";
    const s = await start();
    try {
      expect(process.env["CANOPY_TOKEN"]).toBeUndefined();
    } finally {
      await s.stop();
    }
  });

  test("a run's spawn env has no token", () => {
    const env = spawnEnv({ env: runEnv({ id: "r1", repoId: "app" }, "here") }, {});
    expect(env["CANOPY_TOKEN"]).toBeUndefined();
    expect(env["CANOPY_RUN"]).toBe("r1");
  });

  test("a server starting with no live shells prunes the one a gone server left", async () => {
    const first = await start();
    const { token } = await shellToken(first, "abcdefabcdefabcdefabcdefabcdef12");
    expect(await held(token, true)).toBe(true);
    await first.stop();
    expect(await held(token, true)).toBe(true);
    const second = await start();
    try {
      expect(await held(token, false)).toBe(false);
    } finally {
      await second.stop();
    }
  });
});

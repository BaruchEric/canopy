import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStageRunner } from "../stage/runner";
import { StageClient } from "./stageclient";

let dir = "";
let root = "";
let seed = "";
let client: StageClient;
const stops: (() => Promise<void>)[] = [];
/** a runner behind a fence: its probe target times out */
const runner = async (socket: string): Promise<() => Promise<void>> => {
  const { stop } = await startStageRunner({
    socket,
    root,
    env: { PATH: process.env["PATH"], HOME: dir, CANOPY_FENCE_PROBE: "http://probe.test/" },
    probe: async () => ({ result: "blocked" }),
    // the git on this Mac's PATH may sit in a folder its user owns
    writable: async () => false,
  });
  return stop;
};

beforeAll(async () => {
  // the realpath, since a Mac's tmpdir sits behind /var -> /private/var
  dir = await realpath(await mkdtemp(join(tmpdir(), "cc-")));
  root = join(dir, "_incubator");
  seed = join(root, "coin");
  await mkdir(seed, { recursive: true });
  const sock = join(dir, "s.sock");
  stops.push(await runner(sock));
  client = new StageClient(sock);
});
afterAll(async () => {
  for (const s of stops) await s();
  await rm(dir, { recursive: true, force: true });
});

const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(10);
};

describe("the stage client", () => {
  test("exec runs a check and hands back code, stdout and stderr", async () => {
    const r = await client.exec(["sh", "-c", "echo out; echo err >&2; exit 4"], { cwd: seed, timeoutMs: 5000 });
    expect(r).toEqual({ code: 4, stdout: "out\n", stderr: "err\n" });
  });

  test("a refusal is an exit 126 with the reason, and nothing runs", async () => {
    const r = await client.exec(["sh", "-c", "true"], { cwd: dir, timeoutMs: 5000 });
    expect(r.code).toBe(126);
    expect(r.stderr).toContain("not a seed");
  });

  test("spawn: a JSON line written before the child reads arrives whole, and 1 MB comes back byte for byte", async () => {
    const line = '{"type":"user","message":"hi"}';
    const p = client.spawn(["sh", "-c", "head -n1; head -c 1048576 /dev/zero | tr '\\0' a"], { cwd: seed, env: {} });
    p.stdin.write(`${line}\n`);
    p.stdin.end();
    const out = await new Response(p.stdout).text();
    expect(out.startsWith(`${line}\n`)).toBe(true);
    expect(out.length).toBe(line.length + 1 + 1_048_576);
    expect(out.slice(line.length + 1)).toBe("a".repeat(1_048_576));
    expect(await p.exited).toBe(0);
  });

  test("a JSON line longer than one frame goes down and comes back whole", async () => {
    // 200 KB is past the wire's 64 KB chunk, so the line rides several in
    // frames down and several out frames back
    const line = JSON.stringify({ type: "user", message: "é".repeat(100_000) });
    const p = client.spawn(["sh", "-c", "cat"], { cwd: seed, env: {} });
    p.stdin.write(`${line}\n`);
    p.stdin.end();
    const out = await new Response(p.stdout).text();
    expect(out).toBe(`${line}\n`);
    expect(await p.exited).toBe(0);
  });

  test("ending stdin is not ending the connection: the child keeps running to its own exit", async () => {
    const p = client.spawn(["sh", "-c", "cat >/dev/null; sleep 0.3; echo after"], { cwd: seed, env: {} });
    p.stdin.end();
    expect(await new Response(p.stdout).text()).toBe("after\n");
    expect(await p.exited).toBe(0);
  });

  test("spawn carries stderr on its own stream", async () => {
    const p = client.spawn(["sh", "-c", "echo oops >&2"], { cwd: seed, env: {} });
    p.stdin.end();
    expect(await new Response(p.stderr ?? undefined).text()).toBe("oops\n");
    expect(await p.exited).toBe(0);
  });

  test("kill ends a spawned process", async () => {
    const p = client.spawn(["sh", "-c", "sleep 300"], { cwd: seed, env: {} });
    await Bun.sleep(50);
    p.kill();
    expect(await p.exited).not.toBe(0);
  });

  test("a timeout kills and says so", async () => {
    const r = await client.exec(["sh", "-c", "sleep 300"], { cwd: seed, timeoutMs: 200 });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("timed out after 200 ms");
  });

  test("a dead socket is an exit 127 that says the runner is not answering", async () => {
    const r = await new StageClient(join(dir, "none.sock")).exec(["sh", "-c", "true"], { cwd: seed, timeoutMs: 2000 });
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("the stage runner is not answering");
    const p = new StageClient(join(dir, "none.sock")).spawn(["sh"], { cwd: seed, env: {} });
    p.stdin.write("x\n");
    p.stdin.end();
    expect(await new Response(p.stdout).text()).toBe("");
    expect(await p.exited).toBe(127);
  });

  test("git runs in the seed through the runner and hands back its output", async () => {
    const quiet = { stdout: "ignore", stderr: "ignore" } as const;
    expect(await Bun.spawn(["git", "init", "-q", "-b", "main"], { cwd: seed, ...quiet }).exited).toBe(0);
    // 1 MB of bytes no text decoder keeps whole
    const blob = new Uint8Array(1024 * 1024).map((_, i) => (i * 131 + 7) % 256);
    await Bun.write(join(seed, "blob.bin"), blob);
    expect(await Bun.spawn(["git", "add", "blob.bin"], { cwd: seed, ...quiet }).exited).toBe(0);
    const env = { GIT_AUTHOR_NAME: "canopy", GIT_AUTHOR_EMAIL: "c@x", GIT_COMMITTER_NAME: "canopy", GIT_COMMITTER_EMAIL: "c@x" };
    const made = await client.git(seed, ["commit", "-q", "-m", "one"], { timeoutMs: 10_000, env });
    expect(made).toEqual({ code: 0, stdout: "", stderr: "" });
    const log = await client.git(seed, ["log", "--format=%an %s"], { timeoutMs: 10_000 });
    expect(log.stdout).toBe("canopy one\n");
    const file = join(dir, "blob.out");
    const r = await client.gitToFile(seed, ["cat-file", "blob", "HEAD:blob.bin"], file, { timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(Buffer.from(await Bun.file(file).arrayBuffer()).equals(Buffer.from(blob))).toBe(true);
    // a name off git's own list is refused, not dropped
    const refused = await client.git(seed, ["add", "-A"], { timeoutMs: 10_000, env: { GIT_INDEX_FILE: join(dir, "i") } });
    expect(refused.code).toBe(126);
    expect(refused.away).toBeUndefined();
  }, 20_000);

  test("git with no runner to answer is away, and nothing runs", async () => {
    const r = await new StageClient(join(dir, "none.sock")).git(seed, ["status"], { timeoutMs: 2000 });
    expect(r.code).toBe(127);
    expect(r.away).toContain("the stage runner is not answering");
  });

  test("busy says whether anything has its cwd in the seed", async () => {
    expect(await client.busy(seed)).toBe(false);
    const p = client.spawn(["sh", "-c", "sleep 300"], { cwd: seed, env: {} });
    await Bun.sleep(100);
    expect(await client.busy(seed)).toBe(true);
    p.kill();
    await p.exited;
    expect(await client.busy(seed)).toBe(false);
    // a refusal and a dead socket both read as not known
    expect(await client.busy(dir)).toBe(null);
    expect(await new StageClient(join(dir, "none.sock")).busy(seed, 300)).toBe(null);
  }, 20_000);

  test("watch calls onUp once when the runner first answers", async () => {
    let ups = 0;
    const stopWatch = client.watch(50, () => ups++);
    await Bun.sleep(200);
    stopWatch();
    expect(ups).toBe(1);
    expect(client.harnessesNow()).toEqual(expect.any(Array));
  });

  test("watch calls onUp again on each answer after a miss, onDown on each miss after an answer, and harnessesNow follows", async () => {
    const sock = join(dir, "later.sock");
    const later = new StageClient(sock);
    let ups = 0;
    let downs = 0;
    const stopWatch = later.watch(30, () => ups++, () => downs++);
    await Bun.sleep(100);
    expect(ups).toBe(0);
    // never up yet, so not down either
    expect(downs).toBe(0);
    expect(later.harnessesNow()).toBe(null);
    let stop = await runner(sock);
    await until(() => ups === 1);
    expect(ups).toBe(1);
    expect(later.harnessesNow()).toEqual(expect.any(Array));
    await stop();
    await until(() => downs === 1);
    expect(later.harnessesNow()).toBe(null);
    await Bun.sleep(100);
    expect(downs).toBe(1);
    stop = await runner(sock);
    await until(() => ups === 2);
    stopWatch();
    await stop();
    expect(ups).toBe(2);
    expect(downs).toBe(1);
  }, 20_000);

  test("a hello made by anyone, not only the watch, moves the watch's up and down", async () => {
    const sock = join(dir, "other.sock");
    const other = new StageClient(sock);
    let stop = await runner(sock);
    let ups = 0;
    let downs = 0;
    let answers = 0;
    const stopWatch = other.watch(400, () => ups++, () => downs++, () => answers++);
    await until(() => ups === 1);
    expect(ups).toBe(1);
    expect(answers).toBe(1);
    // the runner goes away and comes back between two beats; a run or a
    // check saw it gone with a hello of its own
    await stop();
    expect(await other.hello()).toBe(null);
    await Bun.sleep(0);
    expect(downs).toBe(1);
    stop = await runner(sock);
    // the next beat finds it back: up again within one interval
    await until(() => ups === 2, 800);
    expect(ups).toBe(2);
    expect(answers).toBeGreaterThanOrEqual(2);
    // a stopped watch hears no more hellos
    stopWatch();
    await stop();
    await other.hello();
    await Bun.sleep(0);
    expect(downs).toBe(1);
  }, 20_000);

  test("a listener that throws does not turn an answer into a miss", async () => {
    const stopWatch = client.watch(60_000, () => {
      throw new Error("boom");
    });
    expect(await client.hello()).toEqual(expect.any(Array));
    await Bun.sleep(10);
    stopWatch();
  });

  test("hello answers, and a dead socket reads as not answering", async () => {
    expect(await client.hello()).toEqual(expect.any(Array));
    expect(await new StageClient(join(dir, "none.sock")).hello(300)).toBe(null);
  });

  test("the runner's --health exits 0 while it answers and 1 when it does not", async () => {
    const main = join(import.meta.dir, "..", "stage", "main.ts");
    const health = async (socket: string): Promise<number | null> => {
      const p = Bun.spawn([process.execPath, main, "--health"], {
        env: { PATH: process.env["PATH"], CANOPY_STAGE_SOCKET: socket, CANOPY_STAGE_ROOT: root },
        stdout: "ignore",
        stderr: "ignore",
      });
      return p.exited;
    };
    expect(await health(join(dir, "s.sock"))).toBe(0);
    expect(await health(join(dir, "none.sock"))).toBe(1);
  }, 20_000);
});

describe("the fence, as the client reads it", () => {
  test("a fenced runner's hello says fenced, with no reason", async () => {
    expect(await client.hello()).toEqual(expect.any(Array));
    expect(client.fenceNow()).toEqual({ fenced: true, reason: null });
  });

  test("an unfenced runner's hello carries why, and a spawn it refuses for the fence says so apart from its words", async () => {
    const sock = join(dir, "unfenced.sock");
    const { stop } = await startStageRunner({ socket: sock, root, env: { PATH: process.env["PATH"], HOME: dir } });
    try {
      const c = new StageClient(sock);
      expect(await c.hello()).toEqual(expect.any(Array));
      expect(c.fenceNow()).toEqual({ fenced: "unchecked", reason: "the fence is unchecked: set CANOPY_FENCE_PROBE" });
      const p = c.spawn(["sh", "-c", "exit 0"], { cwd: seed, env: {} });
      expect(await p.exited).toBe(126);
      expect(c.fenceRefusal(p)).toBe("the fence is unchecked: set CANOPY_FENCE_PROBE");
      const r = await c.exec(["sh", "-c", "exit 0"], { cwd: seed, timeoutMs: 5000 });
      expect(r.code).toBe(126);
      expect(r.unfenced).toBe("the fence is unchecked: set CANOPY_FENCE_PROBE");
    } finally {
      await stop();
    }
  });

  test("a refusal for any other reason is no fence refusal, whatever its words", async () => {
    const p = client.spawn(["sh", "-c", "exit 0"], { cwd: join(dir, "nowhere"), env: {} });
    expect(await p.exited).toBe(126);
    expect(client.fenceRefusal(p)).toBe(null);
    // a stage's own output that reads like the fence's words is only output
    const r = await client.exec(["sh", "-c", "echo 'the fence is down: x answered' >&2; exit 126"], { cwd: seed, timeoutMs: 5000 });
    expect(r.code).toBe(126);
    expect(r.unfenced).toBeUndefined();
  });

  test("a runner from before the fence, whose hello says nothing of it, reads as unchecked", async () => {
    const sock = join(dir, "old.sock");
    const old = createServer((c) => c.on("data", () => c.end(`${JSON.stringify({ t: "hello", harnesses: ["claude"] })}\n`)));
    await new Promise<void>((r) => old.listen(sock, r));
    try {
      const c = new StageClient(sock);
      expect(await c.hello()).toEqual(["claude"]);
      expect(c.fenceNow()).toEqual({ fenced: "unchecked", reason: null });
    } finally {
      await new Promise<void>((r) => old.close(() => r()));
    }
  });

  test("no answer is no fence state at all", async () => {
    const c = new StageClient(join(dir, "none.sock"));
    expect(await c.hello(300)).toBe(null);
    expect(c.fenceNow()).toBe(null);
  });
});

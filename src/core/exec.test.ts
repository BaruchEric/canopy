import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, KILL_GRACE, onHost } from "./exec";

/** whether a pid is still running (a zombie waiting on its reaper counts as gone) */
async function alive(pid: number): Promise<boolean> {
  const r = await exec(["ps", "-o", "stat=", "-p", String(pid)]);
  const stat = r.stdout.trim();
  return r.code === 0 && stat !== "" && !stat.startsWith("Z");
}

describe("exec", () => {
  test("captures output and the exit code", async () => {
    expect(await exec(["sh", "-c", "echo out; echo err >&2; exit 3"], { timeoutMs: 5_000 })).toEqual({
      code: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
    expect((await exec(["sh", "-c", "exit 4"])).code).toBe(4);
  });

  test("input goes to the child's stdin, so a file's text never sits in argv", async () => {
    expect(await exec(["cat"], { input: "a\nb $(no)" })).toMatchObject({ code: 0, stdout: "a\nb $(no)" });
    expect(await onHost(null, ["cat"], { input: "x" })).toMatchObject({ code: 0, stdout: "x" });
  });

  test("a missing binary is a result, not a throw", async () => {
    const r = await exec(["/nonexistent/canopy-no-such-binary"]);
    expect(r.code).toBe(127);
  });

  test("a timeout ends what the command started too, and keeps what it printed", async () => {
    // `; true` keeps sh from exec'ing the sleep, so the sleep is a
    // grandchild holding the pipes, the way git fetch's per-remote child is
    const start = Date.now();
    const r = await exec(["sh", "-c", "echo early; echo $$ >&2; sleep 30; true"], { timeoutMs: 300 });
    expect(Date.now() - start).toBeLessThan(300 + KILL_GRACE);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("early\n");
  });

  test("an idle timeout ends a command that goes quiet, and lets a talking one finish", async () => {
    const start = Date.now();
    const quiet = await exec(["sh", "-c", "echo early; sleep 30; true"], { idleMs: 300, timeoutMs: 60_000 });
    expect(Date.now() - start).toBeLessThan(300 + 2 * KILL_GRACE);
    expect(quiet.code).not.toBe(0);
    expect(quiet.stdout).toBe("early\n");
    // a line every 100 ms for 800 ms, against a 300 ms idle limit
    const talking = await exec(["sh", "-c", "for i in 1 2 3 4 5 6 7 8; do echo $i; sleep 0.1; done"], { idleMs: 300 });
    expect(talking.code).toBe(0);
    expect(talking.stdout).toBe("1\n2\n3\n4\n5\n6\n7\n8\n");
  });

  test("an abort ends the command and what it started, as the timeout does", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const start = Date.now();
    const r = await exec(["sh", "-c", "sleep 30 & echo $!; wait; true"], { timeoutMs: 60_000, signal: ctl.signal });
    expect(Date.now() - start).toBeLessThan(200 + KILL_GRACE);
    expect(r.code).not.toBe(0);
    const pid = Number(r.stdout.trim());
    await Bun.sleep(200);
    expect(await alive(pid)).toBe(false);
  });

  test("the whole group goes, not just the command", async () => {
    const r = await exec(["sh", "-c", "sleep 30 & echo $!; wait; true"], { timeoutMs: 300 });
    const pid = Number(r.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    await Bun.sleep(200);
    expect(await alive(pid)).toBe(false);
  });

  test("a process that leaves the group and keeps a pipe is not waited on forever", async () => {
    if (!Bun.which("python3")) return;
    const dir = mkdtempSync(join(tmpdir(), "canopy-exec-"));
    const ready = join(dir, "ready");
    // a daemon: forks, starts a session of its own, holds stdout open
    const script = [
      "import os, sys, time",
      "pid = os.fork()",
      "if pid == 0:",
      "    os.setsid()",
      "    print(os.getpid(), flush=True)",
      "    with open(sys.argv[1], 'w') as f:",
      "        f.write(str(os.getpid()))",
      "    time.sleep(30)",
      "else:",
      "    time.sleep(30)",
    ].join("\n");
    const ctl = new AbortController();
    const running = exec(["python3", "-c", script, ready], { timeoutMs: 10_000, signal: ctl.signal });
    try {
      // Interpreter startup can exceed 300 ms on a busy machine. Begin
      // measuring shutdown only once the child has left the process group.
      const deadline = performance.now() + 5_000;
      let daemon = 0;
      while (performance.now() < deadline) {
        if (existsSync(ready)) daemon = Number(readFileSync(ready, "utf8"));
        if (daemon > 0) break;
        await Bun.sleep(10);
      }
      expect(daemon).toBeGreaterThan(0);
      const start = performance.now();
      ctl.abort();
      const r = await running;
      expect(performance.now() - start).toBeLessThan(3 * KILL_GRACE);
      expect(r.code).not.toBe(0);
      expect(r.stdout.trim()).toBe(String(daemon));
      expect(await alive(daemon)).toBe(true);
    } finally {
      ctl.abort();
      await running;
      const daemon = existsSync(ready) ? Number(readFileSync(ready, "utf8")) : 0;
      if (daemon > 0) {
        try {
          process.kill(daemon, "SIGKILL");
        } catch {
          // gone already
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

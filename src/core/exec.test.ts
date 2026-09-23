import { describe, expect, test } from "bun:test";
import { exec, KILL_GRACE } from "./exec";

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

  test("the whole group goes, not just the command", async () => {
    const r = await exec(["sh", "-c", "sleep 30 & echo $!; wait; true"], { timeoutMs: 300 });
    const pid = Number(r.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    await Bun.sleep(200);
    expect(await alive(pid)).toBe(false);
  });

  test("a process that leaves the group and keeps a pipe is not waited on forever", async () => {
    // a daemon: forks, starts a session of its own, holds stdout open
    const script = [
      "import os, sys, time",
      "pid = os.fork()",
      "if pid == 0:",
      "    os.setsid()",
      "    time.sleep(30)",
      "else:",
      "    print(pid, flush=True)",
      "    time.sleep(30)",
    ].join("\n");
    if (!Bun.which("python3")) return;
    const start = Date.now();
    const r = await exec(["python3", "-c", script], { timeoutMs: 300 });
    expect(Date.now() - start).toBeLessThan(300 + 3 * KILL_GRACE);
    const daemon = Number(r.stdout.trim());
    expect(daemon).toBeGreaterThan(0);
    try {
      process.kill(daemon, "SIGKILL");
    } catch {
      // gone already
    }
  }, 15_000);
});

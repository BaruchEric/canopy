import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const STALL = '#!/bin/sh\necho $$ > "$CANOPY_LSOF_PID"\nexec sleep 30\n';
// what lsof has written when the timeout cuts it off mid-line: 127.0.0.1:7850 read as port 78
const CUT = '#!/bin/sh\necho $$ > "$CANOPY_LSOF_PID"\nprintf \'p1\\ncnode\\nn127.0.0.1:78\'\nexec sleep 30\n';

for (const [name, lsof] of [
  ["a stalled host port scan returns instead of hanging the request", STALL],
  ["a line the timeout cuts off is not read as a port", CUT],
] as const) {
  test.skipIf(process.platform !== "darwin")(name, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "canopy-ports-timeout-"));
    const pidFile = join(scratch, "pid");
    let child: Bun.Subprocess | undefined;
    try {
      await writeFile(join(scratch, "lsof"), lsof, { mode: 0o755 });
      const probe = Bun.spawn([process.execPath, "-e", `
        import { listeningPorts } from ${JSON.stringify(join(import.meta.dir, "ports.ts"))};
        const timer = setTimeout(() => process.exit(2), 6000);
        console.log(JSON.stringify(await listeningPorts()));
        clearTimeout(timer);
      `], {
        stdout: "pipe", stderr: "pipe",
        env: { ...process.env, PATH: `${scratch}${delimiter}${process.env["PATH"] ?? ""}`, CANOPY_LSOF_PID: pidFile },
      });
      child = probe;
      const [code, stdout, stderr] = await Promise.all([probe.exited, probe.stdout.text(), probe.stderr.text()]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual([]);
    } finally {
      child?.kill();
      const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
      if (pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
      await rm(scratch, { recursive: true, force: true });
    }
  }, 10_000);
}

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../scripts/canopy-restart");
const SECRET = "hunter2-fixture-secret";
const hasJq = Bun.which("jq") !== null;

let dir = "";

/** a docker that knows four projects, logs every call, and echoes the
 *  secret wherever a real one could: up's output and a JSON ps */
const FAKE = `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_LOG"
case "$*" in
  "compose ls -a --format json")
    printf '%s' '[{"Name":"buzz-prod","Status":"running(5)","ConfigFiles":"/opt/stacks/buzz/compose.yml,/opt/stacks/buzz/compose.mini.yml"},{"Name":"memory","ConfigFiles":"/opt/stacks/memory/docker-compose.yml"},{"Name":"canopy","ConfigFiles":"/home/eric/dev/dev-tools/canopy/docker-compose.yml"},{"Name":"sneaky","ConfigFiles":"/opt/stacks/sneaky/../../etc/compose.yml"}]'
    ;;
  *" up -d")
    echo "redis --requirepass ${SECRET}"
    echo "error near ${SECRET}" >&2
    exit "\${FAKE_UP_CODE:-0}"
    ;;
  *" ps -a --format json")
    echo '[{"Command":"redis-server --requirepass ${SECRET}"}]'
    ;;
  *" ps -a --format "*)
    printf 'redis\\trunning\\thealthy\\nrelay\\trunning\\t\\n'
    ;;
esac
`;

async function run(request: string, env: Record<string, string> = {}) {
  const log = join(dir, "log");
  await rm(log, { force: true });
  const p = Bun.spawn(["sh", SCRIPT], {
    env: { PATH: `${dir}:${process.env["PATH"] ?? ""}`, SSH_ORIGINAL_COMMAND: request, FAKE_LOG: log, CANOPY_RESTART_WAIT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const calls = await readFile(log, "utf8").catch(() => "");
  return { stdout, stderr, code, calls: calls.trim().split("\n").filter(Boolean) };
}

describe.skipIf(!hasJq)("scripts/canopy-restart", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "canopy-restart-"));
    await writeFile(join(dir, "docker"), FAKE);
    await chmod(join(dir, "docker"), 0o755);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("list names the projects under /opt/stacks with their files, and nothing else", async () => {
    const r = await run("list");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("buzz-prod\t/opt/stacks/buzz/compose.yml,/opt/stacks/buzz/compose.mini.yml\nmemory\t/opt/stacks/memory/docker-compose.yml\n");
  });

  test("restart runs up -d with the project's own files, in order, and prints only service, state and health", async () => {
    const r = await run("restart buzz-prod");
    expect(r.code).toBe(0);
    expect(r.calls).toContain("compose -p buzz-prod -f /opt/stacks/buzz/compose.yml -f /opt/stacks/buzz/compose.mini.yml up -d");
    expect(r.stdout).toBe("redis\trunning\thealthy\nrelay\trunning\t\n");
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });

  test("a failed up keeps compose's output to itself and exits with its code", async () => {
    const r = await run("restart memory", { FAKE_UP_CODE: "3" });
    expect(r.code).toBe(3);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });

  test("refuses a bad name, an unknown project, canopy's own and a path that climbs out", async () => {
    for (const [req, why] of [
      ["restart ../etc", "not a project name"],
      ["restart buzz-prod; rm -rf /", "not a project name"],
      ["restart nope", "no compose project named nope"],
      ["restart canopy", "outside /opt/stacks"],
      ["restart sneaky", "outside /opt/stacks"],
      ["up -d", "only list and restart"],
      ["list extra", "list takes nothing"],
      ["", "only list and restart"],
    ] as const) {
      const r = await run(req);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(why);
      expect(r.calls.some((c) => c.endsWith(" up -d"))).toBe(false);
    }
  });
});

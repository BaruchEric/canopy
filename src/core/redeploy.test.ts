import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "./host";

const script = join(import.meta.dir, "../../scripts/redeploy.sh");
const commit = "a".repeat(40);

for (const [name, response, ready] of [
  ["unavailable", "unavailable", false],
  ["the previous revision", JSON.stringify({ commit: "b".repeat(40) }), false],
  ["the requested revision", JSON.stringify({ commit }), true],
] as const) {
  test(`redeploy records success only when the backend serves ${name}`, async () => {
    const logs = await mkdtemp(join(tmpdir(), "canopy-redeploy-test-"));
    try {
      // Run the real detached job, replacing only host/container operations.
      const source = await readFile(script, "utf8");
      const job = source.slice(source.indexOf("\njob() {") + 1, source.indexOf("\nexport -f job"));
      const harness = `
docker() {
  if [ "$1" = port ]; then printf '100.64.0.1:7850\\n'; return 0; fi
  if [ "$1" = compose ] && [ "$2" = logs ]; then printf 'canopy → old server\\n'; return 0; fi
  if [ "$1" = compose ] && [ "$2" = exec ]; then
    shift 2
    while [ "${"${1:-}"}" != bun ] && [ "$#" -gt 0 ]; do shift; done
    shift
    ${shellQuote(process.execPath)} "$1" "globalThis.fetch = async () => { if (process.env.FAKE_ABOUT === 'unavailable') throw Error('unavailable'); return Response.json(JSON.parse(process.env.FAKE_ABOUT)); }; $2" "$3"
    return $?
  fi
  return 0
}
mkdir() { :; }
sleep() { :; }
seq() { printf '1\\n'; }
${job}
job
`;
      const child = Bun.spawn(["bash", "-c", harness], {
        stdout: "pipe", stderr: "pipe",
        env: { ...process.env, LOGS: logs, sha: "fixture revision", shells: "0", CANOPY_COMMIT: commit, FAKE_ABOUT: response },
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(ready ? 0 : 1);
      const record = Bun.file(join(logs, "deployed"));
      expect(await record.exists()).toBe(ready);
      if (ready) expect(await record.text()).toContain("fixture revision on 100.64.0.1:7850");
      else expect(stdout).toContain("did not become ready");
    } finally {
      await rm(logs, { recursive: true, force: true });
    }
  });
}

for (const [name, restart, upRecreates, recreated] of [
  ["leaves an unchanged container alone without --restart", "0", false, false],
  ["recreates an unchanged container with --restart", "1", false, true],
  ["does not recreate twice when up already did", "1", true, false],
] as const) {
  test(`redeploy ${name}`, async () => {
    const logs = await mkdtemp(join(tmpdir(), "canopy-redeploy-test-"));
    try {
      const source = await readFile(script, "utf8");
      const job = source.slice(source.indexOf("\njob() {") + 1, source.indexOf("\nexport -f job"));
      const calls = join(logs, "calls");
      const harness = `
id=old
docker() {
  printf '%s\\n' "$*" >>${shellQuote(calls)}
  if [ "$1" = inspect ]; then printf '%s\\n' "$id"; return 0; fi
  if [ "$*" = "compose up -d" ] && [ "$UP_RECREATES" = 1 ]; then id=new; return 0; fi
  if [ "$1" = port ]; then printf '100.64.0.1:7850\\n'; return 0; fi
  return 0
}
mkdir() { :; }
sleep() { :; }
seq() { printf '1\\n'; }
${job}
job
`;
      const child = Bun.spawn(["bash", "-c", harness], {
        stdout: "pipe", stderr: "pipe",
        env: {
          ...process.env, LOGS: logs, sha: "fixture revision", shells: "0", restart,
          CANOPY_COMMIT: commit, UP_RECREATES: upRecreates ? "1" : "0",
        },
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const forced = (await readFile(calls, "utf8")).split("\n").includes("compose up -d --no-deps --force-recreate canopy");
      expect(forced).toBe(recreated);
      expect(stdout.includes("recreating the canopy container")).toBe(recreated);
    } finally {
      await rm(logs, { recursive: true, force: true });
    }
  });
}

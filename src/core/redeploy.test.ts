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
chmod() { :; }
sleep() { :; }
seq() { printf '1\\n'; }
# canopy is not answering, so the work check carries on
curl() { return 7; }
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
chmod() { :; }
sleep() { :; }
seq() { printf '1\\n'; }
# canopy is not answering, so the work check carries on
curl() { return 7; }
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

const recreate = "Container canopy-canopy-1 Recreate";
const unchanged = "Container canopy-shells-1 Running\nContainer canopy-canopy-1 Running";
const busy = {
  runs: [
    { id: "r1", repoId: "web/app", verb: "fix", status: "working", progress: "editing" },
    { id: "r2", repoId: "web/site", verb: "ask", status: "waiting", progress: "" },
    { id: "r3", repoId: "web/app", verb: "fix", status: "done", progress: "" },
  ],
  flows: [
    { id: "f1", repoId: "tools/cli", verb: "ship", status: "working", current: 1, steps: [{ name: "Build" }, { name: "Gates" }] },
    { id: "f2", repoId: "tools/cli", verb: "ship", status: "gated", current: 0, steps: [{ name: "Build" }] },
  ],
  fleets: [
    { id: "fl1", verb: "bump", status: "working", repos: ["a", "b", "c", "d", "e"].map((repoId) => ({ repoId })) },
    { id: "fl2", verb: "bump", status: "done", repos: [{ repoId: "a" }] },
  ],
  landing: {
    runs: [], orphans: [],
    entries: [
      { id: "l1", repoId: "web/app", branch: "run/x", state: "gate", gate: "typecheck" },
      { id: "l2", repoId: "web/app", branch: "run/y", state: "queued" },
      { id: "l3", repoId: "web/app", branch: "run/z", state: "landed" },
    ],
  },
};
const idle = { runs: [busy.runs[2]], flows: [busy.flows[1]], fleets: [busy.fleets[1]], landing: { ...busy.landing, entries: [busy.landing.entries[2]] } };

for (const [name, opts, expected] of [
  ["stops with exit 4 naming the work a recreate cuts off", { plan: recreate, api: busy }, { code: 4, asked: true, up: false }],
  ["skips the work check with --force", { plan: recreate, api: busy, force: "1" }, { code: 0, asked: false, up: true }],
  ["carries on when canopy is not answering", { plan: recreate, down: true }, { code: 0, asked: true, up: true }],
  ["carries on when nothing is going", { plan: recreate, api: idle }, { code: 0, asked: true, up: true }],
  ["reads an older backend's missing routes as nothing going", { plan: recreate, api: { runs: [] } }, { code: 0, asked: true, up: true }],
  ["skips the work check when the canopy container stays up", { plan: unchanged, api: busy }, { code: 0, asked: false, up: true }],
  ["checks an unchanged container with --restart", { plan: unchanged, api: busy, restart: "1" }, { code: 4, asked: true, up: false }],
  ["stops when canopy answers but will not list its runs", { plan: recreate, api: {} }, { code: 1, asked: true, up: false }],
] as const) {
  test.skipIf(!Bun.which("jq"))(`redeploy ${name}`, async () => {
    const logs = await mkdtemp(join(tmpdir(), "canopy-redeploy-test-"));
    try {
      const source = await readFile(script, "utf8");
      const job = source.slice(source.indexOf("\njob() {") + 1, source.indexOf("\nexport -f job"));
      const calls = join(logs, "calls");
      const fixtures = join(logs, "api");
      await Bun.write(join(fixtures, ".keep"), "");
      const api: Record<string, unknown> = "api" in opts ? opts.api : {};
      for (const [route, body] of Object.entries(api)) await Bun.write(join(fixtures, `${route}.json`), JSON.stringify(body));
      const harness = `
docker() {
  printf '%s\\n' "$*" >>${shellQuote(calls)}
  if [ "$*" = "compose --dry-run up -d" ]; then printf '%s\\n' "$PLAN"; return 0; fi
  if [ "$1" = inspect ]; then printf 'same\\n'; return 0; fi
  if [ "$1" = port ]; then printf '100.64.0.1:7850\\n'; return 0; fi
  return 0
}
curl() {
  for u; do :; done
  printf 'curl %s\\n' "$u" >>${shellQuote(calls)}
  [ "$CANOPY_DOWN" = 1 ] && return 7
  f=${shellQuote(fixtures)}/\${u##*/api/}.json
  [ -f "$f" ] || return 22
  cat "$f"
}
mkdir() { :; }
chmod() { :; }
sleep() { :; }
seq() { printf '1\\n'; }
${job}
job
`;
      const child = Bun.spawn(["bash", "-c", harness], {
        stdout: "pipe", stderr: "pipe",
        env: {
          ...process.env, LOGS: logs, sha: "fixture revision", shells: "0", CANOPY_COMMIT: commit,
          restart: "restart" in opts ? opts.restart : "0", force: "force" in opts ? opts.force : "0",
          PLAN: opts.plan, CANOPY_DOWN: "down" in opts ? "1" : "0",
        },
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(expected.code);
      const lines = (await readFile(calls, "utf8")).split("\n");
      expect(lines.some((l) => l.startsWith("curl "))).toBe(expected.asked);
      expect(lines.includes("compose up -d")).toBe(expected.up);
      if (expected.code === 4) {
        expect(stdout).toContain("  run r1  web/app  fix, editing");
        expect(stdout).toContain("  run r2  web/site  ask, waiting on a prompt");
        expect(stdout).toContain("  flow f1  tools/cli  ship, at step Gates");
        expect(stdout).toContain("  fleet fl1  a, b, c and 2 more  bump");
        expect(stdout).toContain("  landing l1  web/app  gate (typecheck), run/x");
        expect(stdout).toContain("--force");
        for (const quiet of ["r3", "f2", "fl2", "l2", "l3"]) expect(stdout).not.toContain(` ${quiet} `);
      }
    } finally {
      await rm(logs, { recursive: true, force: true });
    }
  });
}

test("redeploy reports and probes canopy's own address, not the coordinator bridge's gateway", async () => {
  const logs = await mkdtemp(join(tmpdir(), "canopy-redeploy-test-"));
  try {
    const source = await readFile(script, "utf8");
    const job = source.slice(source.indexOf("\njob() {") + 1, source.indexOf("\nexport -f job"));
    const probed = join(logs, "probed");
    const harness = `
docker() {
  # the gateway binding first, as docker may list it
  if [ "$1" = port ]; then printf '10.250.14.1:7850\\n100.64.0.1:7850\\n'; return 0; fi
  if [ "$1" = compose ] && [ "$2" = exec ]; then return 0; fi
  return 0
}
mkdir() { :; }
chmod() { :; }
sleep() { :; }
seq() { printf '1\\n'; }
curl() { printf '%s\\n' "$*" >>${shellQuote(probed)}; return 7; }
${job}
job
`;
    const child = Bun.spawn(["bash", "-c", harness], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, LOGS: logs, sha: "fixture revision", shells: "0", restart: "1", CANOPY_COMMIT: commit },
    });
    const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(await Bun.file(join(logs, "deployed")).text()).toContain("fixture revision on 100.64.0.1:7850");
    const calls = await readFile(probed, "utf8");
    expect(calls).toContain("http://100.64.0.1:7850/api/runs");
    expect(calls).not.toContain("10.250.14.1");
  } finally {
    await rm(logs, { recursive: true, force: true });
  }
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = join(import.meta.dir, "../../scripts/mac-server.sh");
const ENTRY = resolve(import.meta.dir, "../../bin/canopy.ts");
const hasJq = Bun.which("jq") !== null;
/** every character a careless eval would trip on */
const AWKWARD = `it's "a" $HOME \`id\` ; k=v #x`;

let dir = "";

/** a bun that says what it was started with: its arguments, then each
 *  CANOPY_ variable it was handed */
const FAKE = `#!/bin/sh
printf 'ARGS %s\\n' "$*"
env | grep '^CANOPY_' | sort
[ -z "\${LD_PRELOAD:-}" ] || echo "LD_PRELOAD set"
`;

async function run(keys: unknown, args: string[] = ["ui", "/somewhere", "--port", "7850"]) {
  const file = join(dir, "keys.json");
  if (keys === undefined) await rm(file, { force: true });
  else await writeFile(file, typeof keys === "string" ? keys : JSON.stringify(keys));
  const p = Bun.spawn(["sh", SCRIPT, ...args], {
    env: { PATH: `${dir}:${process.env["PATH"] ?? ""}`, CANOPY_KEYS_FILE: file, CANOPY_PUBLIC_ORIGIN: "https://set.by.launchd" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { lines: stdout.trim().split("\n"), stderr, code };
}

describe.skipIf(!hasJq)("scripts/mac-server.sh", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "canopy-macserver-"));
    await writeFile(join(dir, "bun"), FAKE);
    await chmod(join(dir, "bun"), 0o755);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the keys file's CANOPY_ names reach the server, beside what launchd set", async () => {
    const r = await run({ providers: { canopy: { env: { CANOPY_VOICE_KEY: "sk_voice", CANOPY_LIVE_KEY: "sk-live" } } } });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      `ARGS run ${ENTRY} ui /somewhere --port 7850`,
      `CANOPY_KEYS_FILE=${join(dir, "keys.json")}`,
      "CANOPY_LIVE_KEY=sk-live",
      "CANOPY_PUBLIC_ORIGIN=https://set.by.launchd",
      "CANOPY_VOICE_KEY=sk_voice",
    ]);
  });

  test("the log names what was loaded and never a value", async () => {
    const r = await run({ providers: { canopy: { env: { CANOPY_VOICE_KEY: "sk_voice", CANOPY_LIVE_KEY: "sk-live" } } } });
    expect(r.stderr).toContain("CANOPY_VOICE_KEY");
    expect(r.stderr).toContain("CANOPY_LIVE_KEY");
    expect(r.stderr).not.toContain("sk_voice");
    expect(r.stderr).not.toContain("sk-live");
  });

  test("a value arrives as written, whatever is in it", async () => {
    const r = await run({ providers: { canopy: { env: { CANOPY_VOICE_KEY: AWKWARD } } } });
    expect(r.code).toBe(0);
    expect(r.lines).toContain(`CANOPY_VOICE_KEY=${AWKWARD}`);
  });

  test("only CANOPY_ names with text for a value are exported", async () => {
    const r = await run({
      providers: {
        canopy: {
          env: { LD_PRELOAD: "/tmp/x.dylib", "CANOPY_X; echo pwned": "1", CANOPY_NUMBER: 7, CANOPY_NULL: null, CANOPY_OK: "yes" },
        },
      },
    });
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => !l.startsWith("ARGS ") && !l.startsWith("CANOPY_KEYS_FILE=") && !l.startsWith("CANOPY_PUBLIC_ORIGIN="))).toEqual(["CANOPY_OK=yes"]);
    expect(r.lines.join("\n")).not.toContain("pwned");
  });

  test("no file, no canopy entry or a broken file starts the server without keys", async () => {
    for (const keys of [undefined, { providers: { github: { token: "t" } } }, "{ not json"]) {
      const r = await run(keys, ["ui"]);
      expect(r.code).toBe(0);
      expect(r.lines[0]).toBe(`ARGS run ${ENTRY} ui`);
      expect(r.lines.some((l) => l.startsWith("CANOPY_VOICE_KEY="))).toBe(false);
    }
  });
});

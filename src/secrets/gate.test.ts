import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "../core/secretwire";
import { Gate, type WebAuthn } from "./gate";

let dir = "";
let lines: string[] = [];
let t = 0;
let calls: Record<string, unknown>[] = [];

/** a stand-in for the browser and the library: verifies whatever it is told to */
function fake(verified = true): WebAuthn {
  return {
    genReg: (async () => ({ challenge: "c-reg" })) as unknown as WebAuthn["genReg"],
    verifyReg: (async (o: Record<string, unknown>) => {
      calls.push(o);
      return { verified, registrationInfo: { credential: { id: "cred1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] } } };
    }) as unknown as WebAuthn["verifyReg"],
    genAuth: (async () => ({ challenge: "c-auth" })) as unknown as WebAuthn["genAuth"],
    verifyAuth: (async (o: Record<string, unknown>) => {
      calls.push(o);
      return { verified, authenticationInfo: { newCounter: 1 } };
    }) as unknown as WebAuthn["verifyAuth"],
  };
}

const open = (wa = fake()) => Gate.open({ file: join(dir, "passkeys.json"), rpID: "canopy.beric.ca", origin: "https://canopy.beric.ca", now: () => t, wa, log: (l) => lines.push(l) });
const codeOf = (): string => /code ([0-9a-f]{10})/.exec(lines.join("\n"))?.[1] ?? "none";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-gate-"));
  lines = [];
  calls = [];
  t = Date.parse("2026-10-14T12:00:00.000Z");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function registered(): Promise<Gate> {
  const g = await open();
  expect((await g.begin("register", null, codeOf())).ok).toBe(true);
  expect((await g.finish("register", null, codeOf(), { id: "cred1" }, "phone")).ok).toBe(true);
  return g;
}

async function login(g: Gate): Promise<string> {
  expect((await g.begin("login", null, null)).ok).toBe(true);
  const r = await g.finish("login", null, null, { id: "cred1" }, "");
  if (!r.ok) throw new Error(r.error);
  return (r.data as { token: string }).token;
}

describe("the first passkey", () => {
  test("needs the printed code, and the code works once", async () => {
    const g = await open();
    expect(g.firstPasskey()).toBe(true);
    expect(codeOf()).not.toBe("none");
    expect(await g.begin("register", null, "0000000000")).toMatchObject({ ok: false });
    const first = codeOf();
    expect((await g.begin("register", null, first)).ok).toBe(true);
    expect((await g.finish("register", null, first, { id: "cred1" }, "phone")).ok).toBe(true);
    expect(g.firstPasskey()).toBe(false);
    expect(await g.begin("register", null, first)).toEqual({ ok: false, error: "open the passkey gate first", gate: "passkey" });
  });

  test("five wrong codes print a new one", async () => {
    const g = await open();
    const first = codeOf();
    for (let i = 0; i < 5; i++) await g.begin("register", null, "0000000000");
    expect(codeOf()).toBe(first);
    expect(/code ([0-9a-f]{10})/g.exec(lines.slice(1).join("\n"))?.[1]).not.toBe(first);
    expect((await g.begin("register", null, first)).ok).toBe(false);
  });

  test("the passkeys file is 0600 and holds no session", async () => {
    const g = await registered();
    const token = await login(g);
    expect((await stat(join(dir, "passkeys.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, "passkeys.json"), "utf8")).not.toContain(token);
  });
});

describe("login and sessions", () => {
  test("checks the origin, the rp id and user verification", async () => {
    const g = await registered();
    await login(g);
    for (const c of calls) {
      expect(c["expectedOrigin"]).toBe("https://canopy.beric.ca");
      expect(c["expectedRPID"]).toBe("canopy.beric.ca");
      expect(c["requireUserVerification"]).toBe(true);
    }
  });

  test("a session ends after 15 idle minutes", async () => {
    const g = await registered();
    const token = await login(g);
    t += LIMITS.idleMs - 1;
    expect(g.session(token)).not.toBeNull();
    t += LIMITS.idleMs + 1;
    expect(g.session(token)).toBeNull();
  });

  test("a session ends after an hour however busy", async () => {
    const g = await registered();
    const token = await login(g);
    for (let i = 0; i < 6; i++) {
      t += 10 * 60_000;
      expect(g.session(token)).not.toBeNull();
    }
    t += 1;
    expect(g.session(token)).toBeNull();
  });

  test("a challenge is used once and lasts two minutes", async () => {
    const g = await registered();
    await g.begin("login", null, null);
    expect((await g.finish("login", null, null, { id: "cred1" }, "")).ok).toBe(true);
    expect(await g.finish("login", null, null, { id: "cred1" }, "")).toMatchObject({ ok: false, error: "start the passkey prompt again" });
    await g.begin("login", null, null);
    t += 2 * 60_000 + 1;
    expect((await g.finish("login", null, null, { id: "cred1" }, "")).ok).toBe(false);
  });

  test("a response that does not verify opens nothing", async () => {
    const g = await registered();
    const bad = await Gate.open({ file: join(dir, "passkeys.json"), rpID: "canopy.beric.ca", origin: "https://canopy.beric.ca", now: () => t, wa: fake(false), log: () => {} });
    await bad.begin("login", null, null);
    expect((await bad.finish("login", null, null, { id: "cred1" }, "")).ok).toBe(false);
    expect(g.passkeys()).toHaveLength(1);
  });

  test("logout ends the session; the last passkey cannot be removed", async () => {
    const g = await registered();
    const token = await login(g);
    expect((await g.remove("cred1")).ok).toBe(false);
    g.logout(token);
    expect(g.session(token)).toBeNull();
  });
});

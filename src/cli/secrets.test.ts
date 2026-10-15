import { describe, expect, test } from "bun:test";
import { newIdentity, newSigningKey, openValue, sealValue, signingKey } from "../core/secretcrypt";
import { emptyFile, serializeFile, signFile, verifyFile } from "../core/secretfile";
import type { SecretsInfo } from "../core/types";
import { breakglassIdentity, listLines, recoverFile, statusExit, statusLines } from "./secrets";

const STAMP = "2026-10-14T12:00:00.000Z";
const V = "fixture-value-0x5eed";

const info = (over: Partial<SecretsInfo> = {}): SecretsInfo => ({
  ok: true,
  error: null,
  backend: "mac",
  role: "reader",
  head: "abc1234",
  refused: null,
  lock: "locked",
  secrets: [{ name: "cf_token", description: "dns edits", tags: ["dns"], created: STAMP, rotated: STAMP, to: ["breakglass", "mini"], allow: ["sink:dns"], usedBy: ["dns"] }],
  sinks: [{ id: "dns", machine: "mac", path: "/Users/e/x/.env", format: "dotenv", keys: { CF_TOKEN: "cf_token" }, state: { CF_TOKEN: "drift" }, error: null }],
  proposals: [],
  passkeys: [],
  session: false,
  firstPasskey: false,
  recipient: null,
  gate: "https://canopy.beric.ca/?view=secrets",
  unpushed: 0,
  ...over,
});

describe("lines", () => {
  test("the list names, dates, tags and users, and no value", () => {
    const text = listLines(info()).join("\n");
    expect(text).toContain("cf_token");
    expect(text).toContain("2026-10-14");
    expect(text).toContain("#dns");
    expect(text).toContain("dns edits");
  });

  test("the status names the lock, the commit, drift, and a refusal", () => {
    const text = statusLines(info({ refused: "the newest commit (def5678) is not signed by the pinned mini key; abc1234 stays" })).join("\n");
    expect(text).toContain("abc1234");
    expect(text).toContain("canopy secrets unlock");
    expect(text).toContain("CF_TOKEN drift");
    expect(text).toContain("not signed");
  });

  test("an open key names its recipient, so it can be set as a machine key later", () => {
    const text = statusLines(info({ lock: "open", recipient: "age1example" })).join("\n");
    expect(text).toContain("this machine's key is open, recipient age1example");
  });

  test("status exits 1 on a refusal, a sink error or drift, 0 otherwise", () => {
    expect(statusExit(info())).toBe(1);
    expect(statusExit(info({ sinks: [] }))).toBe(0);
    expect(statusExit(info({ sinks: [], refused: "x" }))).toBe(1);
    expect(statusExit(info({ ok: false, sinks: [] }))).toBe(1);
  });
});

test("breakglassIdentity finds the key line in an age identity file", () => {
  expect(breakglassIdentity("# created: today\n# public key: age1...\nAGE-SECRET-KEY-1ABC\n")).toBe("AGE-SECRET-KEY-1ABC");
  expect(breakglassIdentity("nothing here")).toBeNull();
});

describe("recoverFile", () => {
  test("opens every value with the break-glass key, reseals to a new mini key, and signs with a new key", async () => {
    const breakglass = await newIdentity();
    const oldMini = await newIdentity();
    const mac = await newIdentity();
    const oldSigner = await signingKey((await newSigningKey()).privateB64);
    const f = emptyFile({ mini: oldMini.recipient, mac: mac.recipient, breakglass: breakglass.recipient });
    f.secrets["cf_token"] = { description: "", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mac", "mini"], allow: ["sink:laptop"], value: await sealValue("cf_token", V, STAMP, [breakglass.recipient, mac.recipient, oldMini.recipient]) };
    f.sinks["laptop"] = { machine: "mac", path: "/Users/e/x/.env", format: "dotenv", keys: { CF: "cf_token" } };
    const r = await recoverFile(serializeFile(await signFile(f, oldSigner, "mini")), breakglass.identity);
    if ("error" in r) throw new Error(r.error);
    expect(r.file.keys["mini"]).toBe(r.recipient);
    expect(r.file.keys["mini"]).not.toBe(oldMini.recipient);
    expect(r.file.keys["mac"]).toBe(mac.recipient);
    expect(await verifyFile(r.file, r.signing.publicB64)).toBe(true);
    const e = r.file.secrets["cf_token"];
    expect(await openValue(e?.value ?? "", r.identity, { name: "cf_token", rotated: STAMP })).toBe(V);
    expect(await openValue(e?.value ?? "", mac.identity, { name: "cf_token", rotated: STAMP })).toBe(V);
    await expect(openValue(e?.value ?? "", oldMini.identity, { name: "cf_token", rotated: STAMP })).rejects.toThrow();
  });

  test("names the secret the break-glass key cannot open, and no value", async () => {
    const breakglass = await newIdentity();
    const other = await newIdentity();
    const f = emptyFile({ mini: other.recipient, breakglass: breakglass.recipient });
    f.secrets["cf_token"] = { description: "", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mini"], allow: [], value: await sealValue("cf_token", V, STAMP, [other.recipient]) };
    const r = await recoverFile(serializeFile(f), breakglass.identity);
    expect("error" in r ? r.error : "").toContain("cf_token");
    expect("error" in r ? r.error : "").not.toContain(V);
  });
});

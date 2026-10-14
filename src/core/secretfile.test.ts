import { describe, expect, test } from "bun:test";
import {
  AGE_HEAD,
  canonical,
  emptyFile,
  fileProblems,
  metaOf,
  parseSecretFile,
  recipientsFor,
  serializeFile,
  signFile,
  verifyFile,
  type SecretFile,
} from "./secretfile";

// a real recipient's shape (the break-glass key from the spec); the file
// check reads shape only, so one string serves every machine here
const R = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";
const SEALED = `${AGE_HEAD}\nnot really sealed\n-----END AGE ENCRYPTED FILE-----\n`;
const STAMP = "2026-10-14T12:00:00.000Z";

function fixture(): SecretFile {
  const f = emptyFile({ mini: R, mac: R, breakglass: R });
  f.secrets["cloudflare_token"] = { description: "dns edits", tags: ["cloudflare"], created: STAMP, rotated: STAMP, to: ["breakglass", "mini"], allow: [], value: SEALED };
  return f;
}

async function keyPair(): Promise<{ priv: CryptoKey; pub: string }> {
  const k = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey));
  return { priv: k.privateKey, pub: btoa(String.fromCharCode(...raw)) };
}

describe("canonical", () => {
  test("sorts keys at every depth, keeps array order, writes no whitespace", () => {
    expect(canonical({ b: 1, a: { d: [3, 1], c: "x y" } })).toBe('{"a":{"c":"x y","d":[3,1]},"b":1}');
  });

  test("drops undefined and refuses what JSON cannot hold", () => {
    expect(canonical({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonical({ a: Number.NaN })).toThrow();
    expect(() => canonical({ a: () => 1 })).toThrow();
  });
});

describe("the signature", () => {
  test("a file signed by the pinned key verifies after a round trip", async () => {
    const { priv, pub } = await keyPair();
    const signed = await signFile(fixture(), priv, "mini");
    const back = parseSecretFile(serializeFile(signed));
    if ("error" in back) throw new Error(back.error);
    expect(await verifyFile(back.file, pub)).toBe(true);
  });

  test("a file with its keys reordered still verifies", async () => {
    const { priv, pub } = await keyPair();
    const signed = await signFile(fixture(), priv, "mini");
    const reordered = JSON.parse(serializeFile(signed)) as Record<string, unknown>;
    const shuffled = JSON.stringify({ signature: reordered["signature"], sinks: reordered["sinks"], secrets: reordered["secrets"], keys: reordered["keys"], seq: reordered["seq"], version: 1 }, null, 4);
    const back = parseSecretFile(shuffled);
    if ("error" in back) throw new Error(back.error);
    expect(await verifyFile(back.file, pub)).toBe(true);
  });

  test("one changed byte of metadata fails", async () => {
    const { priv, pub } = await keyPair();
    const signed = await signFile(fixture(), priv, "mini");
    const text = serializeFile(signed).replace("dns edits", "dns edit!");
    const back = parseSecretFile(text);
    if ("error" in back) throw new Error(back.error);
    expect(await verifyFile(back.file, pub)).toBe(false);
  });

  test("the sequence number is signed: a file with its seq changed fails", async () => {
    const { priv, pub } = await keyPair();
    const signed = await signFile({ ...fixture(), seq: 7 }, priv, "mini");
    expect(await verifyFile(signed, pub)).toBe(true);
    expect(await verifyFile({ ...signed, seq: 8 }, pub)).toBe(false);
  });

  test("another key's signature, a missing one, or a broken public key fails", async () => {
    const a = await keyPair();
    const b = await keyPair();
    const signed = await signFile(fixture(), a.priv, "mini");
    expect(await verifyFile(signed, b.pub)).toBe(false);
    expect(await verifyFile({ ...signed, signature: null }, a.pub)).toBe(false);
    expect(await verifyFile(signed, "not base64!")).toBe(false);
  });
});

describe("parseSecretFile", () => {
  const good = (): Record<string, unknown> => JSON.parse(serializeFile(fixture())) as Record<string, unknown>;
  const refuses = (mutate: (f: Record<string, unknown>) => void, words: string) => {
    const f = good();
    mutate(f);
    const r = parseSecretFile(JSON.stringify(f));
    expect("error" in r ? r.error : "parsed").toContain(words);
  };

  test("takes a good file", () => {
    expect("file" in parseSecretFile(serializeFile(fixture()))).toBe(true);
  });

  test("refuses each broken part by name", () => {
    expect("error" in parseSecretFile("{")).toBe(true);
    refuses((f) => (f["version"] = 2), "version");
    refuses((f) => delete f["seq"], "seq");
    refuses((f) => (f["seq"] = -1), "seq");
    refuses((f) => delete (f["keys"] as Record<string, unknown>)["breakglass"], "breakglass");
    refuses((f) => ((f["keys"] as Record<string, unknown>)["mac"] = "age1short"), "key mac");
    refuses((f) => ((f["secrets"] as Record<string, unknown>)["9bad"] = {}), "9bad");
    refuses((f) => (((f["secrets"] as Record<string, Record<string, unknown>>)["cloudflare_token"] as Record<string, unknown>)["value"] = "plain text"), "not an age file");
    refuses((f) => (((f["secrets"] as Record<string, Record<string, unknown>>)["cloudflare_token"] as Record<string, unknown>)["allow"] = ["everyone"]), "everyone");
    refuses((f) => (((f["secrets"] as Record<string, Record<string, unknown>>)["cloudflare_token"] as Record<string, unknown>)["to"] = ["mini", "nas"]), "no key");
    refuses((f) => ((f["sinks"] as Record<string, unknown>)["dns"] = { machine: "mini", path: "/opt/stacks/../etc/x", format: "dotenv", keys: {} }), "absolute");
    refuses((f) => ((f["sinks"] as Record<string, unknown>)["dns"] = { machine: "mini", path: "/opt/stacks/dns/.env", format: "yaml", keys: {} }), "format");
    refuses((f) => ((f["sinks"] as Record<string, unknown>)["dns"] = { machine: "mini", path: "/opt/stacks/dns/.env", format: "dotenv", keys: { CF: "missing_one" } }), "missing_one");
    refuses((f) => ((f["sinks"] as Record<string, unknown>)["dns"] = { machine: "mini", path: "/opt/stacks/dns/.env", format: "dotenv", keys: { "a.b": "cloudflare_token" } }), "a.b");
    refuses((f) => ((f["sinks"] as Record<string, unknown>)["dns"] = { machine: "breakglass", path: "/x", format: "dotenv", keys: {} }), "machine");
  });
});

describe("recipients and problems", () => {
  test("the mini and the break-glass key always, and each sink's machine; gpd's sinks add the Mac", () => {
    const f = fixture();
    expect(recipientsFor(f, "cloudflare_token")).toEqual(["breakglass", "mini"]);
    f.sinks["laptop"] = { machine: "mac", path: "/Users/e/x/.env", format: "dotenv", keys: { CF: "cloudflare_token" } };
    f.sinks["pad"] = { machine: "gpd", path: "/home/eric/x/.env", format: "dotenv", keys: { CF: "cloudflare_token" } };
    expect(recipientsFor(f, "cloudflare_token")).toEqual(["breakglass", "mac", "mini"]);
  });

  test("names a sink missing from the allowlist and a value sealed to the wrong machines", () => {
    const f = fixture();
    expect(fileProblems(f)).toEqual([]);
    f.sinks["laptop"] = { machine: "mac", path: "/Users/e/x/.env", format: "dotenv", keys: { CF: "cloudflare_token" } };
    const p = fileProblems(f);
    expect(p.some((l) => l.includes("sink:laptop"))).toBe(true);
    expect(p.some((l) => l.includes("not breakglass, mac, mini"))).toBe(true);
  });

  test("metadata carries no value", () => {
    const m = metaOf(fixture(), "cloudflare_token");
    expect(JSON.stringify(m)).not.toContain(AGE_HEAD);
    expect(m?.usedBy).toEqual([]);
  });
});

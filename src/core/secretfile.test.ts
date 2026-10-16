import { describe, expect, test } from "bun:test";
import {
  AGE_HEAD,
  canonical,
  emptyFile,
  fileProblems,
  impactOf,
  mcpEnvPath,
  mcpSinkId,
  metaOf,
  parseMcpAllow,
  parseSecretFile,
  reachText,
  recipientsFor,
  serializeFile,
  signFile,
  stackFor,
  verifyFile,
  type SecretFile,
  type SinkDef,
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

describe("a secret's reach", () => {
  const H = "a".repeat(64);
  function reach(): SecretFile {
    const f = fixture();
    f.secrets["gh_token"] = { description: "", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mac", "mini"], allow: [`mcp:github#${H}`, "sink:dev-env", "sink:mcp-github-mac", "sink:mcp-github-mini"], value: SEALED };
    f.sinks["dev-env"] = { machine: "mini", path: "/opt/stacks/dev/.env", format: "dotenv", keys: { GH_TOKEN: "gh_token", OTHER: "cloudflare_token" }, restart: "dev" };
    f.sinks["mcp-github-mac"] = { machine: "mac", path: mcpEnvPath("/Users/e", "github"), format: "dotenv", keys: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" } };
    f.sinks["mcp-github-mini"] = { machine: "mini", path: mcpEnvPath("/home/eric", "github"), format: "dotenv", keys: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" } };
    return f;
  }

  test("ids and paths for a server's sinks", () => {
    expect(mcpSinkId("github", "mac")).toBe("mcp-github-mac");
    expect(mcpSinkId("hook", "mini", true)).toBe("mcp-hook-mini-headers");
    expect(mcpEnvPath("/home/eric/", "github")).toBe("/home/eric/.claude/mcp-env/github.env");
    expect(mcpEnvPath("/Users/e", "hook", true)).toBe("/Users/e/.claude/mcp-env/hook.headers.json");
    expect(parseMcpAllow(`mcp:github#${H}`)).toEqual({ server: "github", hash: H });
    expect(parseMcpAllow("sink:dns")).toBeNull();
  });

  test("lists every sink by machine with its keys, every server with the machines holding its env sink, and the stacks", () => {
    expect(impactOf(reach(), "gh_token")).toEqual({
      sinks: [
        { id: "dev-env", machine: "mini", path: "/opt/stacks/dev/.env", keys: ["GH_TOKEN"] },
        { id: "mcp-github-mac", machine: "mac", path: "/Users/e/.claude/mcp-env/github.env", keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
        { id: "mcp-github-mini", machine: "mini", path: "/home/eric/.claude/mcp-env/github.env", keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
      ],
      servers: [{ server: "github", hash: H, machines: ["mac", "mini"] }],
      stacks: ["dev"],
    });
    expect(impactOf(reach(), "cloudflare_token").servers).toEqual([]);
    expect(impactOf(reach(), "gone")).toEqual({ sinks: [], servers: [], stacks: [] });
  });

  test("the project a sink restarts: set, none, or found from its folder (phase 3)", () => {
    const projects = [
      { name: "buzz-prod", files: ["/opt/stacks/buzz/compose.yml", "/opt/stacks/buzz/compose.mini.yml"] },
      { name: "music-assistant", files: ["/opt/stacks/music-assistant/compose.yaml"] },
      { name: "music-assistant-alexa", files: ["/opt/stacks/music-assistant/alexa/compose.yaml"] },
      { name: "twin-a", files: ["/opt/stacks/twin/a.yml"] },
      { name: "twin-b", files: ["/opt/stacks/twin/b.yml"] },
    ];
    const sink = (path: string, over: Partial<SinkDef> = {}): SinkDef => ({ machine: "mini", path, format: "dotenv", keys: {}, ...over });
    expect(stackFor(sink("/opt/stacks/buzz/.env"), "mini", projects)).toBe("buzz-prod");
    // the alexa project's file is a folder down, so only music-assistant sits in the folder
    expect(stackFor(sink("/opt/stacks/music-assistant/.env"), "mini", projects)).toBe("music-assistant");
    expect(stackFor(sink("/opt/stacks/twin/.env"), "mini", projects)).toBeNull();
    expect(stackFor(sink("/opt/stacks/nothing/.env"), "mini", projects)).toBeNull();
    expect(stackFor(sink("/home/eric/.claude/mcp-env/github.env"), "mini", projects)).toBeNull();
    expect(stackFor(sink("/opt/stacks/buzz/.env", { machine: "mac" }), "mini", projects)).toBeNull();
    expect(stackFor(sink("/opt/stacks/buzz/.env", { restart: "none" }), "mini", projects)).toBeNull();
    expect(stackFor(sink("/opt/stacks/buzz/.env", { restart: "buzz-dev" }), "mini", projects)).toBe("buzz-dev");
    // a writer's reach names the found project; a reader knows only the set one
    const f = reach();
    delete f.sinks["dev-env"]?.restart;
    expect(impactOf(f, "gh_token").stacks).toEqual([]);
    expect(impactOf(f, "gh_token", (_id, s) => stackFor(s, "mini", [{ name: "dev-prod", files: ["/opt/stacks/dev/compose.yml"] }])).stacks).toEqual(["dev-prod"]);
  });

  test("metadata carries the reach; the words name sinks and servers", () => {
    const r = impactOf(reach(), "gh_token");
    expect(metaOf(reach(), "gh_token")?.impact).toEqual(r);
    expect(reachText("gh_token", r)).toBe("gh_token is used by dev-env, mcp-github-mac, mcp-github-mini and the MCP server github");
    expect(reachText("x", { sinks: [], servers: [], stacks: [] })).toBe("x is used by nothing");
  });
});

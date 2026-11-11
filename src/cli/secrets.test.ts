import { describe, expect, test } from "bun:test";
import { newIdentity, newSigningKey, openValue, sealValue, signingKey } from "../core/secretcrypt";
import { emptyFile, serializeFile, signFile, verifyFile } from "../core/secretfile";
import { AGE_HEAD } from "../core/secretfile";
import { LIMITS } from "../core/secretwire";
import type { SecretProposalIn, SecretsInfo } from "../core/types";
import type { Target } from "./health";
import { breakglassIdentity, listLines, parsePropose, pickProposals, propose, recoverFile, statusExit, statusLines, type ProposeArgs } from "./secrets";

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

describe("propose", () => {
  const BUNDLE = "/Users/e/.claude/credentials/.credentials.json";
  const NOTES = "/Users/e/dev/.env";
  // a sealed value's text stands in for the value: no line the command prints may hold it
  const SEALED = `${AGE_HEAD}\nsealed-fixture-0x5eed\n`;
  const item = (source: string, key: string, over: Partial<SecretProposalIn> = {}): SecretProposalIn => ({ from: "mac", source, key, sealed: SEALED, merges: null, ...over });
  const items = [
    item(BUNDLE, "providers.canopy.env.CANOPY_VOICE_KEY"),
    item(BUNDLE, "providers.canopy.env.CANOPY_LIVE_KEY"),
    item(BUNDLE, "providers.cloudflare.api_token"),
    item(NOTES, "OPENAI_API_KEY", { partial: true }),
  ];
  const args = (over: Partial<ProposeArgs> = {}): ProposeArgs => ({ match: [], all: false, to: null, dry: false, ...over });

  test("the flags: one or more texts or --all, never both and never neither", () => {
    expect(parsePropose(["--match", "voice", "--match", "LIVE", "--dry-run"])).toEqual({ match: ["voice", "LIVE"], all: false, to: null, dry: true });
    expect(parsePropose(["--all", "--to", "mini"])).toEqual({ match: [], all: true, to: "mini", dry: false });
    expect(parsePropose([])).toContain("--match TEXT");
    expect(parsePropose(["--all", "--match", "x"])).toContain("--match TEXT");
    expect(parsePropose(["--match"])).toBe("--match needs a text");
    expect(parsePropose(["--match", "--all"])).toBe("--match needs a text");
    expect(parsePropose(["--all", "--to"])).toBe("--to needs a backend's name");
    expect(parsePropose(["--all", "extra"])).toBe("not understood: extra");
  });

  test("a text picks by key or by file, in any case; --all picks every value", () => {
    expect(pickProposals(items, args({ match: ["canopy_voice"] })).map((p) => p.key)).toEqual(["providers.canopy.env.CANOPY_VOICE_KEY"]);
    expect(pickProposals(items, args({ match: ["voice", "live"] })).length).toBe(2);
    expect(pickProposals(items, args({ match: ["DEV/.ENV"] })).map((p) => p.key)).toEqual(["OPENAI_API_KEY"]);
    expect(pickProposals(items, args({ match: ["nothing-here"] }))).toEqual([]);
    expect(pickProposals(items, args({ all: true })).length).toBe(4);
  });

  /** a home backend that reads, a registry of two others, and whatever the writer was posted */
  function world(o: { scan?: SecretProposalIn[]; role?: SecretsInfo["role"]; writerAway?: boolean } = {}) {
    const lines: string[] = [];
    const posted: SecretProposalIn[][] = [];
    const asked: string[] = [];
    const mini: Target = { name: "mini", urls: ["http://100.0.0.2:7850"] };
    const deps = {
      homeUrl: "http://127.0.0.1:7850",
      home: async <T,>(method: string, path: string): Promise<T> => {
        asked.push(`home ${method} ${path}`);
        if (path === "/api/secrets") return info({ role: o.role ?? "reader" }) as T;
        if (path === "/api/secrets/scan") return { items: o.scan ?? items, missing: ["/Users/e/.codex/config.toml"], left: 0, skipped: [{ path: NOTES, lines: [8, 11] }] } as T;
        if (path === "/api/backends") return { self: "mac", backends: [{ name: "mac", tailnet: "http://100.0.0.1:7850" }, { name: "desoto", tailnet: "http://100.0.0.3:7850" }, { name: "mini", tailnet: mini.urls[0] }] } as T;
        throw new Error(`unexpected ${path}`);
      },
      at: async <T,>(t: Target, method: string, path: string, body?: unknown): Promise<T> => {
        asked.push(`${t.name} ${method} ${path}`);
        if (path === "/api/secrets") {
          if (t.name === "mini" && o.writerAway) throw new Error("did not answer");
          return info({ backend: t.name, role: t.name === "mini" ? "writer" : "reader" }) as T;
        }
        if (path === "/api/secrets/proposals" && t.name === "mini") {
          const batch = (body as { items: SecretProposalIn[] }).items;
          posted.push(batch);
          return { added: batch.length, dropped: 0 } as T;
        }
        throw new Error(`unexpected ${t.name} ${path}`);
      },
      print: (line: string) => void lines.push(line),
      fail: (msg: string): never => {
        throw new Error(msg);
      },
    };
    return { deps, lines, posted, asked };
  }

  test("sends only what matched, to the backend that answers as the writer, and prints names and counts", async () => {
    const w = world();
    expect(await propose(args({ match: ["CANOPY_"] }), false, w.deps)).toBe(0);
    expect(w.posted.map((b) => b.map((p) => p.key))).toEqual([["providers.canopy.env.CANOPY_VOICE_KEY", "providers.canopy.env.CANOPY_LIVE_KEY"]]);
    expect(w.asked).toContain("desoto GET /api/secrets");
    const text = w.lines.join("\n");
    expect(text).toContain("CANOPY_VOICE_KEY");
    expect(text).toContain("2 sent to mini: 2 waiting for approval");
    expect(text).toContain("https://canopy.beric.ca/?view=secrets");
    expect(text).toContain("lines 8, 11 are not KEY=value");
    expect(text).not.toContain("sealed-fixture");
    expect(text).not.toContain("cloudflare");
  });

  test("a value from a file with unread lines goes with its mark, so the store offers no sink for it", async () => {
    const w = world();
    await propose(args({ match: ["openai"] }), true, w.deps);
    expect(w.posted[0]?.[0]?.partial).toBe(true);
    const out = JSON.parse(w.lines.join("\n")) as { found: number; picked: { from: string; source: string; key: string; partial: boolean }[]; sent: { writer: string; added: number; dropped: number } };
    expect(out.found).toBe(4);
    expect(out.picked).toEqual([{ from: "mac", source: NOTES, key: "OPENAI_API_KEY", partial: true }]);
    expect(out.sent).toEqual({ writer: "mini", added: 1, dropped: 0 });
    expect(w.lines.join("\n")).not.toContain("sealed-fixture");
  });

  test("--dry-run lists what would go and asks no other backend", async () => {
    const w = world();
    expect(await propose(args({ all: true, dry: true }), false, w.deps)).toBe(0);
    expect(w.posted).toEqual([]);
    expect(w.asked.filter((a) => !a.startsWith("home "))).toEqual([]);
    expect(w.lines.join("\n")).toContain("4 of 4 would be sent; nothing was");
  });

  test("nothing matched: nothing is sent and the exit code says so", async () => {
    const w = world();
    expect(await propose(args({ match: ["nothing-here"] }), false, w.deps)).toBe(1);
    expect(w.posted).toEqual([]);
    expect(w.lines.join("\n")).toContain("nothing to send: 4 values found, none with nothing-here in its key or file");
  });

  test("a long pick goes a batch at a time, in order", async () => {
    const many = Array.from({ length: LIMITS.proposals + 5 }, (_, i) => item(BUNDLE, `k.K${i}`));
    const w = world({ scan: many });
    expect(await propose(args({ all: true }), false, w.deps)).toBe(0);
    expect(w.posted.map((b) => b.length)).toEqual([LIMITS.proposals, 5]);
    expect(w.posted[1]?.[0]?.key).toBe(`k.K${LIMITS.proposals}`);
  });

  test("the writer itself, an unknown --to, and no writer in the list are each refused with the reason", async () => {
    const self = world({ role: "writer" });
    await expect(propose(args({ all: true }), false, self.deps)).rejects.toThrow("is the store's writer");
    const named = world();
    await expect(propose(args({ all: true, to: "nas" }), false, named.deps)).rejects.toThrow("no backend named nas; the home backend lists desoto, mini");
    const away = world({ writerAway: true });
    await expect(propose(args({ all: true }), false, away.deps)).rejects.toThrow("answered as the store's writer; name it with --to");
    expect(away.posted).toEqual([]);
  });

  test("--to sends to the named backend without asking the others who writes", async () => {
    const w = world();
    expect(await propose(args({ match: ["voice"], to: "mini" }), false, w.deps)).toBe(0);
    expect(w.asked.filter((a) => a.endsWith("GET /api/secrets") && !a.startsWith("home "))).toEqual([]);
    expect(w.posted.length).toBe(1);
  });
});

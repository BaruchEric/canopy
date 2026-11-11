import { describe, expect, test } from "bun:test";
import { newIdentity, newSigningKey, openValue, sealValue, signingKey } from "../core/secretcrypt";
import { emptyFile, serializeFile, signFile, verifyFile } from "../core/secretfile";
import { AGE_HEAD } from "../core/secretfile";
import { LIMITS } from "../core/secretwire";
import type { SecretProposalIn, SecretsInfo } from "../core/types";
import type { Target } from "./health";
import { breakglassIdentity, HIDDEN_START, listLines, makeKey, parsePropose, pickProposals, propose, recoverFile, statusExit, statusLines, typeHidden, unlockLines, unlockRefusal, type ProposeArgs } from "./secrets";

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

describe("a hidden line as it is typed", () => {
  const type = (...chunks: string[]) => chunks.reduce(typeHidden, HIDDEN_START);
  const ESC = "\u001b";

  test("enter ends the line, and what follows it in the same chunk is not taken", () => {
    expect(type("correct horse", "\r")).toEqual({ text: "correct horse", esc: "", done: "line" });
    expect(type("abc\nrest").text).toBe("abc");
    expect(type("abc").done).toBeNull();
  });

  test("ctrl-c cancels", () => {
    expect(type("abc\u0003").done).toBe("cancel");
  });

  test("spaces, symbols and letters outside ascii are kept as typed", () => {
    const pass = " With Spaces & Symbols! #$%^*()\u0027\"\\ pässwörd-日本語 ";
    expect(type(pass, "\r").text).toBe(pass);
  });

  test("backspace takes one whole character", () => {
    expect(type("abX\u007fc\r").text).toBe("abc");
    expect(type("ab\b\b\b\bc\r").text).toBe("c");
    expect(type("a🌲\u007fb\r").text).toBe("ab");
  });

  test("ctrl-u starts the line over and ctrl-w takes the last word", () => {
    expect(type("oops-wrong\u0015right one\r").text).toBe("right one");
    expect(type("right one junk\u0017\r").text).toBe("right one ");
    expect(type("right one  \u0017two\r").text).toBe("right two");
  });

  test("an arrow, the delete key and a paste\u0027s markers add nothing, even split across chunks", () => {
    expect(type(`pass-0${ESC}[D1\r`).text).toBe("pass-01");
    expect(type(`pass-01${ESC}[3~\r`).text).toBe("pass-01");
    expect(type(`${ESC}OApass-01\r`).text).toBe("pass-01");
    expect(type(`${ESC}[200~pasted text${ESC}[201~`, "\r").text).toBe("pasted text");
    expect(type("pass", ESC, "[", "1;5", "C", "-01\r").text).toBe("pass-01");
  });

  test("other control keys add nothing, and enter still ends a line after a stray escape", () => {
    expect(type("pa\tss\u0001\u0004-01\r").text).toBe("pass-01");
    expect(type(`pass-01${ESC}\r`)).toEqual({ text: "pass-01", esc: "", done: "line" });
  });
});

describe("a key the store does not know, and a kept passphrase", () => {
  test("status names an open key the store does not seal to, with where to set it, and fails", () => {
    const unlisted = info({ lock: "open", recipient: "age1example", keyUnlisted: true, sinks: [] });
    const text = statusLines(unlisted).join("\n");
    expect(text).toContain("the store does not seal to this key yet");
    expect(text).toContain("machine key mac");
    expect(text).toContain("https://canopy.beric.ca/?view=secrets");
    expect(statusExit(unlisted)).toBe(1);
    expect(statusLines(info({ lock: "open", recipient: "age1example" })).join("\n")).not.toContain("does not seal");
  });

  test("status says a kept passphrase opens the key at the start", () => {
    expect(statusLines(info({ kept: true })).join("\n")).toContain("kept in the login Keychain");
    expect(statusLines(info()).join("\n")).not.toContain("Keychain");
  });

  test("an unlock says nothing of keeping unless it was asked, and names the trade when the keychain took it", () => {
    expect(unlockLines({})).toEqual(["unlocked; this machine's sinks are written now"]);
    const kept = unlockLines({ kept: true }).join("\n");
    expect(kept).toContain("kept in the login Keychain");
    expect(kept).toContain("any process that runs as you can read it there");
    expect(kept).toContain("canopy secrets forget");
    const not = unlockLines({ kept: false, why: "the keychain did not answer" }).join("\n");
    expect(not).toContain("unlocked");
    expect(not).toContain("the passphrase was not kept: the keychain did not answer");
  });
});

describe("a refused unlock", () => {
  test("a wrong passphrase names the way out when it is lost; any other refusal is passed on", () => {
    expect(unlockRefusal("wrong passphrase")).toContain("canopy secrets key --replace");
    expect(unlockRefusal("wrong passphrase").split("\n")[0]).toBe("wrong passphrase");
    expect(unlockRefusal("no key for this machine yet; create one first")).toBe("no key for this machine yet; create one first\nmake one with canopy secrets key");
    expect(unlockRefusal("this call needs the admin right")).toBe("this call needs the admin right");
  });
});

describe("a new key for this machine", () => {
  const RECIPIENT = "age1fixturerecipient0x5eed";
  const PASS = "a long enough passphrase";

  function world(o: { lock?: SecretsInfo["lock"]; role?: SecretsInfo["role"]; typed?: string[]; kept?: true } = {}) {
    const lines: string[] = [];
    const prompts: string[] = [];
    const posted: unknown[] = [];
    const typed = [...(o.typed ?? [PASS, PASS])];
    const deps = {
      read: async (prompt: string) => {
        prompts.push(prompt);
        return typed.shift() ?? "";
      },
      home: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        if (method === "GET" && path === "/api/secrets") return info({ lock: o.lock ?? "locked", role: o.role ?? "reader", ...(o.kept ? { kept: true as const } : {}) }) as T;
        if (method === "POST" && path === "/api/secrets/key") {
          posted.push(body);
          return { recipient: RECIPIENT } as T;
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
      print: (line: string) => void lines.push(line),
      fail: (msg: string): never => {
        throw new Error(msg);
      },
    };
    return { lines, prompts, posted, deps };
  }

  test("a machine with no key gets one: the passphrase is asked twice and the recipient and the next step are printed", async () => {
    const w = world({ lock: "none" });
    await makeKey({ replace: false }, w.deps);
    expect(w.prompts.length).toBe(2);
    expect(w.posted).toEqual([{ passphrase: PASS, replace: false }]);
    const out = w.lines.join("\n");
    expect(out).toContain(RECIPIENT);
    expect(out).toContain("machine key mac");
    expect(out).toContain("https://canopy.beric.ca/?view=secrets");
    expect(out).not.toContain(PASS);
  });

  test("a machine that has a key keeps it unless --replace is given, and nothing is asked", async () => {
    for (const lock of ["locked", "open"] as const) {
      const w = world({ lock });
      await expect(makeKey({ replace: false }, w.deps)).rejects.toThrow("canopy secrets key --replace");
      expect(w.prompts).toEqual([]);
      expect(w.posted).toEqual([]);
    }
  });

  test("--replace makes a new key over a locked one and says the old one no longer opens anything here", async () => {
    const w = world({ lock: "locked" });
    await makeKey({ replace: true }, w.deps);
    expect(w.posted).toEqual([{ passphrase: PASS, replace: true }]);
    expect(w.lines.join("\n")).toContain("the old key is gone");
    expect(w.lines.join("\n")).not.toContain("Keychain");
    const kept = world({ lock: "locked", kept: true });
    await makeKey({ replace: true }, kept.deps);
    expect(kept.lines.join("\n")).toContain("canopy secrets unlock --keep keeps the new one");
  });

  test("two passphrases that differ, or one too short, change nothing", async () => {
    const differ = world({ lock: "none", typed: [PASS, `${PASS}x`] });
    await expect(makeKey({ replace: false }, differ.deps)).rejects.toThrow("differ");
    expect(differ.posted).toEqual([]);
    const short = world({ lock: "none", typed: ["seven77", "seven77"] });
    await expect(makeKey({ replace: false }, short.deps)).rejects.toThrow("at least 8 characters");
    expect(short.posted).toEqual([]);
    const eight = world({ lock: "none", typed: ["eight888", "eight888"] });
    await makeKey({ replace: false }, eight.deps);
    expect(eight.posted).toEqual([{ passphrase: "eight888", replace: false }]);
    expect(eight.prompts[0]).toContain("8 characters or more");
  });

  test("the store\u0027s writer has no key under a passphrase", async () => {
    const w = world({ role: "writer" });
    await expect(makeKey({ replace: true }, w.deps)).rejects.toThrow("is the store\u0027s writer");
    expect(w.posted).toEqual([]);
  });
});

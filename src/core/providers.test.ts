import { expect, test } from "bun:test";
import { envNamesOf, parseProviders, parseProvidersRecord, planProviders, providerHere, resolveProvider, type ProvidersRecord } from "./providers";
import type { KitMachine, KitProvider } from "./types";

const machines: KitMachine[] = [
  { name: "mac", backend: "mac", ssh: null, via: null, dev: null },
  { name: "mini", backend: "mini", ssh: null, via: null, dev: null },
];
const hash = (t: string): string => `h${t.length}:${t.slice(0, 40)}`;

test("no block is no providers and no errors", () => {
  expect(parseProviders(undefined, machines)).toEqual({ providers: [], errors: [] });
});

test("a provider parses with its defaults, and settings keep their env references", () => {
  const got = parseProviders({
    local: { note: "llama", machines: ["mac"] },
    gw: { settings: { env: { ANTHROPIC_BASE_URL: "http://x:4000", ANTHROPIC_AUTH_TOKEN: "${env:GW_TOKEN}" } } },
    or: { harness: "codex" },
  }, machines);
  expect(got.errors).toEqual([]);
  expect(got.providers).toEqual([
    { id: "local", note: "llama", harness: "claude", machines: ["mac"], settings: null },
    { id: "gw", note: "", harness: "claude", machines: null, settings: { env: { ANTHROPIC_BASE_URL: "http://x:4000", ANTHROPIC_AUTH_TOKEN: "${env:GW_TOKEN}" } } },
    { id: "or", note: "", harness: "codex", machines: null, settings: null },
  ]);
  expect(envNamesOf(got.providers[1]!)).toEqual(["GW_TOKEN"]);
});

test.each([
  [{ "1bad": {} }, "providers.1bad: an id of letters, digits, _ and -, starting with a letter, and not default"],
  [{ default: {} }, "providers.default: an id of letters, digits, _ and -, starting with a letter, and not default"],
  [{ a: "x" }, "providers.a: not an object"],
  [{ a: { env: {} } }, "providers.a.env: not a provider field"],
  [{ a: { harness: "gpt" } }, "providers.a.harness: claude or codex"],
  [{ a: { machines: ["desk"] } }, "providers.a.machines: names desk, which machines does not declare"],
  [{ a: { machines: "mac" } }, "providers.a.machines: a list of machine names"],
  [{ a: { harness: "codex", settings: {} } }, "providers.a.settings: a codex provider lives in codex's own config.toml, so it takes no settings"],
  [{ a: { settings: [] } }, "providers.a.settings: a Claude Code settings object"],
  [{ a: { settings: { env: { T: "${secret:gw}" } } } }, "providers.a.settings.env.T: a secret is not taken here yet; read it from the backend's env with ${env:NAME}"],
  [{ a: { settings: { env: { T: "Bearer ${env:X}" } } } }, "providers.a.settings.env.T: holds ${ that is not one whole ${env:NAME}"],
  [{ a: { settings: { env: { T: "${env:1x}" } } } }, "providers.a.settings.env.T: ${env:1x} is not a variable name"],
])("%j is refused with its reason, and only that provider goes", (bad, why) => {
  const got = parseProviders({ ...bad, good: {} }, machines);
  expect(got.errors).toEqual([why]);
  expect(got.providers.map((p) => p.id)).toEqual(["good"]);
});

test("a block that is not an object is one error", () => {
  expect(parseProviders([], machines)).toEqual({ providers: [], errors: ["providers: an object of provider id to definition"] });
});

test("a provider is here when it lists the machine or lists none", () => {
  expect(providerHere({ machines: null }, null)).toBe(true);
  expect(providerHere({ machines: ["mac"] }, "mac")).toBe(true);
  expect(providerHere({ machines: ["mac"] }, "mini")).toBe(false);
  expect(providerHere({ machines: ["mac"] }, null)).toBe(false);
});

const gw: KitProvider = { id: "gw", note: "", harness: "claude", machines: null, settings: { env: { URL: "http://x", TOKEN: "${env:GW_TOKEN}" }, model: "opus" } };

test("resolving reads each reference from the env, or names the ones it lacks", () => {
  expect(resolveProvider(gw, {})).toEqual({ unresolved: ["GW_TOKEN"] });
  expect(resolveProvider(gw, { GW_TOKEN: "" })).toEqual({ unresolved: ["GW_TOKEN"] });
  const got = resolveProvider(gw, { GW_TOKEN: "t0k" });
  expect("text" in got && JSON.parse(got.text)).toEqual({ env: { URL: "http://x", TOKEN: "t0k" }, model: "opus" });
});

const empty: ProvidersRecord = { written: {}, adopted: [] };
const plan = (o: Partial<Parameters<typeof planProviders>[0]>) =>
  planProviders({ providers: [gw], machine: "mac", container: false, env: { GW_TOKEN: "t" }, files: {}, record: empty, hash, ...o });
const text = (): string => (resolveProvider(gw, { GW_TOKEN: "t" }) as { text: string }).text;

test("a central provider with no file is written, and reads ok", () => {
  const got = plan({});
  expect(got.actions).toEqual([{ kind: "write", id: "gw", text: text(), hash: hash(text()) }]);
  expect(got.views[0]).toMatchObject({ id: "gw", state: "ok", central: true, envNames: ["GW_TOKEN"], keys: ["env", "model", "env.URL", "env.TOKEN"] });
});

test("the kit's file in step is left alone; one out of step is written again", () => {
  expect(plan({ files: { gw: hash(text()) }, record: { written: { gw: hash(text()) }, adopted: [] } }).actions).toEqual([]);
  const old = "h2:{}";
  expect(plan({ files: { gw: old }, record: { written: { gw: old }, adopted: [] } }).actions).toEqual([{ kind: "write", id: "gw", text: text(), hash: hash(text()) }]);
});

test("a hand file is never written over", () => {
  const got = plan({ files: { gw: "mine" } });
  expect(got.actions).toEqual([]);
  expect(got.views[0]).toMatchObject({ state: "hand" });
});

test("a kit file someone changed reads drift and stays", () => {
  const got = plan({ files: { gw: "edited" }, record: { written: { gw: "kit" }, adopted: [] } });
  expect(got.actions).toEqual([]);
  expect(got.views[0]?.state).toBe("drift");
});

test("an env name the backend lacks writes nothing and says which", () => {
  const got = plan({ env: {} });
  expect(got.actions).toEqual([]);
  expect(got.views[0]).toMatchObject({ state: "unresolved", why: "the backend's env does not set GW_TOKEN" });
});

test("a container backend refuses a value from the env, and keeps a file it wrote before", () => {
  const got = plan({ container: true, files: { gw: "kit" }, record: { written: { gw: "kit" }, adopted: [] } });
  expect(got.actions).toEqual([]);
  expect(got.views[0]?.state).toBe("refused");
  // literal settings are fine in a container
  const lit: KitProvider = { ...gw, settings: { env: { URL: "http://x" } } };
  expect(plan({ providers: [lit], container: true }).views[0]?.state).toBe("ok");
});

test("a provider for another machine is off, and its kit file goes", () => {
  const got = plan({ providers: [{ ...gw, machines: ["mini"] }], files: { gw: "kit" }, record: { written: { gw: "kit" }, adopted: [] } });
  expect(got.views[0]?.state).toBe("off");
  expect(got.actions).toEqual([{ kind: "remove", id: "gw" }]);
});

test("this machine's own file beats a kit.json provider for other machines; the kit's leftover does not (FR-083)", () => {
  const far: KitProvider = { ...gw, machines: ["mini"] };
  const own = plan({ providers: [far], files: { gw: "mine" } });
  expect(own.views[0]).toMatchObject({ state: "hand", central: false, why: "kit.json's gw is for mini; this machine keeps its own providers/gw.json" });
  expect(own.actions).toEqual([]);
  // the kit's file, changed by hand since, is this machine's now: the kit lets go of it
  const changed = plan({ providers: [far], files: { gw: "edited" }, record: { written: { gw: "kit" }, adopted: [] } });
  expect(changed.views[0]?.state).toBe("hand");
  expect(changed.actions).toEqual([{ kind: "forget", id: "gw" }]);
  // a codex provider has no file here to read
  expect(plan({ providers: [{ ...far, harness: "codex" }], files: { gw: "mine" } }).views[0]?.state).toBe("off");
});

test("a provider gone from kit.json takes its unchanged file with it; a changed one is let go", () => {
  expect(plan({ providers: [], files: { gw: "kit" }, record: { written: { gw: "kit" }, adopted: [] } }).actions).toEqual([{ kind: "remove", id: "gw" }]);
  expect(plan({ providers: [], files: { gw: "edited" }, record: { written: { gw: "kit" }, adopted: [] } }).actions).toEqual([{ kind: "forget", id: "gw" }]);
  expect(plan({ providers: [], record: { written: { gw: "kit" }, adopted: [] } }).actions).toEqual([{ kind: "forget", id: "gw" }]);
});

test("a declared provider reads hand with a file and missing without one", () => {
  const local: KitProvider = { id: "local", note: "", harness: "claude", machines: ["mac"], settings: null };
  expect(plan({ providers: [local], files: { local: "x" } }).views[0]?.state).toBe("hand");
  expect(plan({ providers: [local] }).views[0]?.state).toBe("missing");
  // one the kit wrote while it had settings goes, and reads missing meanwhile
  const got = plan({ providers: [local], files: { local: "kit" }, record: { written: { local: "kit" }, adopted: [] } });
  expect(got.views[0]?.state).toBe("missing");
  expect(got.actions).toEqual([{ kind: "remove", id: "local" }]);
});

test("a codex provider is declared only", () => {
  const got = plan({ providers: [{ id: "or", note: "", harness: "codex", machines: null, settings: null }] });
  expect(got.actions).toEqual([]);
  expect(got.views[0]?.state).toBe("declared");
});

test("an adopted provider says so", () => {
  expect(plan({ record: { written: {}, adopted: ["gw"] } }).views[0]?.adopted).toBe(true);
});

test("the record reads leniently", () => {
  expect(parseProvidersRecord(null)).toEqual({ written: {}, adopted: [] });
  expect(parseProvidersRecord({ written: { gw: "h", "../x": "h", n: 1 }, adopted: ["gw", 2, "../y"] })).toEqual({ written: { gw: "h" }, adopted: ["gw"] });
});

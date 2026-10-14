import { describe, expect, test } from "bun:test";
import type { SecretMeta, SecretSinkInfo, SecretsInfo } from "../../src/core/types";
import { filterSecrets, gateHere, hostOf, isGateClosed, keysText, parseKeysText, sinkRows, tagsOf, writerOf } from "./secrets";

const info = (over: Partial<SecretsInfo> = {}): SecretsInfo => ({
  ok: true,
  error: null,
  backend: "mini",
  role: "writer",
  head: "abc1234",
  refused: null,
  lock: "none",
  secrets: [],
  sinks: [],
  proposals: [],
  passkeys: [],
  session: false,
  firstPasskey: false,
  gate: "https://canopy.beric.ca/?view=secrets",
  unpushed: 0,
  ...over,
});
const meta = (name: string, over: Partial<SecretMeta> = {}): SecretMeta => ({
  name,
  description: "",
  tags: [],
  created: "2026-10-14T00:00:00.000Z",
  rotated: "2026-10-14T00:00:00.000Z",
  to: ["mini", "mac"],
  allow: [],
  usedBy: [],
  ...over,
});
const sink = (id: string, machine: string, state: SecretSinkInfo["state"] = {}): SecretSinkInfo => ({
  id,
  machine,
  path: `/x/${id}/.env`,
  format: "dotenv",
  keys: { K: "k" },
  state,
  error: null,
});

describe("where the store and its gate are", () => {
  test("the writer is the backend whose info says so, in page order", () => {
    const all = { mac: info({ backend: "mac", role: "reader" }), mini: info() };
    expect(writerOf(all, ["mac", "mini"])).toBe("mini");
    expect(writerOf({ mac: all.mac }, ["mac", "mini"])).toBeNull();
  });

  test("gated actions are offered only on the writer's own gate origin", () => {
    expect(gateHere(info(), "https://canopy.beric.ca")).toBe(true);
    expect(gateHere(info(), "http://mini.tail:7850")).toBe(false);
    expect(gateHere(info({ role: "reader" }), "https://canopy.beric.ca")).toBe(false);
    expect(gateHere(undefined, "https://canopy.beric.ca")).toBe(false);
    expect(gateHere(info({ gate: "" }), "https://canopy.beric.ca")).toBe(false);
  });

  test("a closed gate is an error carrying status 401, nothing else", () => {
    expect(isGateClosed(Object.assign(new Error("open a passkey session"), { status: 401 }))).toBe(true);
    expect(isGateClosed(Object.assign(new Error("not here"), { status: 403 }))).toBe(false);
    expect(isGateClosed(new Error("401"))).toBe(false);
    expect(isGateClosed("401")).toBe(false);
  });

  test("hostOf names a gate page's host and survives an empty one", () => {
    expect(hostOf("https://canopy.beric.ca/?view=secrets")).toBe("canopy.beric.ca");
    expect(hostOf("")).toBe("");
  });
});

describe("the list", () => {
  const list = [meta("cf_token", { tags: ["cloudflare", "dns"], description: "DNS edit token" }), meta("immich_db", { tags: ["stacks"] }), meta("openai_key", { description: "Codex" })];

  test("tags are every tag once, sorted", () => {
    expect(tagsOf(list)).toEqual(["cloudflare", "dns", "stacks"]);
  });

  test("the filter reads name, description and tags, case aside", () => {
    expect(filterSecrets(list, "DNS", null).map((m) => m.name)).toEqual(["cf_token"]);
    expect(filterSecrets(list, "codex", null).map((m) => m.name)).toEqual(["openai_key"]);
    expect(filterSecrets(list, "", "stacks").map((m) => m.name)).toEqual(["immich_db"]);
    expect(filterSecrets(list, "token", "stacks")).toEqual([]);
    expect(filterSecrets(list, "  ", null)).toHaveLength(3);
  });
});

describe("sinks", () => {
  test("each sink takes its key states from the backend that owns it", () => {
    const all = {
      mini: info({ sinks: [sink("mac-env", "mac"), sink("immich", "mini", { K: "same" })] }),
      mac: info({ backend: "mac", role: "reader", sinks: [sink("mac-env", "mac", { K: "drift" }), sink("immich", "mini")] }),
    };
    const rows = sinkRows(all, ["mac", "mini"], "mini");
    expect(rows.map((r) => [r.sink.id, r.owner, r.sink.state["K"]])).toEqual([
      ["mac-env", "mac", "drift"],
      ["immich", "mini", "same"],
    ]);
  });

  test("with no writer answering, the first readable copy lists them, unowned when nobody reports", () => {
    const all = { mac: info({ backend: "mac", role: "reader", sinks: [sink("gpd-env", "gpd")] }) };
    expect(sinkRows(all, ["mac", "mini"], null)).toEqual([{ sink: sink("gpd-env", "gpd"), owner: null }]);
    expect(sinkRows({}, ["mac"], null)).toEqual([]);
  });

  test("the key editor reads one KEY=secret a line and checks both sides", () => {
    expect(parseKeysText("A_KEY=cf_token\n\n  DB = immich_db  ", "dotenv")).toEqual({ A_KEY: "cf_token", DB: "immich_db" });
    expect(parseKeysText("mcp.cloudflare.token=cf_token", "json")).toEqual({ "mcp.cloudflare.token": "cf_token" });
    expect(parseKeysText("no equals sign", "dotenv")).toEqual({ error: "line 1 has no =" });
    expect(parseKeysText("a.b=cf_token", "dotenv")).toEqual({ error: "line 1: a.b is not a dotenv key" });
    expect(parseKeysText("A=../x", "dotenv")).toEqual({ error: "line 1: ../x is not a secret name" });
    expect(parseKeysText("A=x\nA=y", "dotenv")).toEqual({ error: "line 2: A is mapped twice" });
  });

  test("keysText writes what parseKeysText reads", () => {
    const keys = { A_KEY: "cf_token", DB: "immich_db" };
    expect(parseKeysText(keysText(keys), "dotenv")).toEqual(keys);
  });
});

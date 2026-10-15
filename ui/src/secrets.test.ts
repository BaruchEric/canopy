import { describe, expect, test } from "bun:test";
import type { SecretMeta, SecretSinkInfo, SecretsInfo } from "../../src/core/types";
import { filterSecrets, gateHere, hostOf, isGateClosed, keysText, parseKeysText, markOf, passedOver, reachRows, readersOf, restartLine, sinkRows, stateTone, tagsOf, usedByText, writerOf, type SinkRow } from "./secrets";

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
  recipient: null,
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

  test("the readers, which the page asks to pull after an allow or a revoke (final review 6)", () => {
    const all = { mac: info({ backend: "mac", role: "reader" }), mini: info(), gpd: info({ backend: "gpd", role: "reader" }) };
    expect(readersOf(all, ["mini", "mac", "gpd"])).toEqual(["mac", "gpd"]);
    expect(readersOf({ mini: all.mini }, ["mini"])).toEqual([]);
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

describe("a rotation's reach", () => {
  const H = "a".repeat(64);
  const meta = (over: Partial<SecretMeta> = {}): SecretMeta => ({
    name: "gh_token", description: "", tags: [], created: "2026-10-14T12:00:00.000Z", rotated: "2026-10-14T12:00:00.000Z", to: ["mac", "mini"], allow: [], usedBy: ["dev-env", "mcp-github-mac"],
    impact: {
      sinks: [{ id: "dev-env", machine: "mini", path: "/opt/stacks/dev/.env", keys: ["GH_TOKEN"] }, { id: "mcp-github-mac", machine: "mac", path: "/Users/e/.claude/mcp-env/github.env", keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] }],
      servers: [{ server: "github", hash: H, machines: ["mac"] }],
      stacks: ["dev"],
    },
    ...over,
  });
  const sink = (id: string, state: SecretSinkInfo["state"], error: string | null = null): SinkRow => ({ sink: { id, machine: "mac", path: "/x", format: "dotenv", keys: {}, state, error }, owner: "mac" });

  test("the restart line is the stack's compose up", () => {
    expect(restartLine("dev")).toBe("cd /opt/stacks/dev && docker compose up -d");
  });

  test("lists sinks with their states, servers with the session note, and stacks with their line", () => {
    const r = reachRows(meta(), [sink("dev-env", { GH_TOKEN: "same" }), sink("mcp-github-mac", { GITHUB_PERSONAL_ACCESS_TOKEN: "waiting" })]);
    expect(r).toEqual([
      { kind: "sink", name: "dev-env", machine: "mini", detail: "/opt/stacks/dev/.env, GH_TOKEN", state: "same" },
      { kind: "sink", name: "mcp-github-mac", machine: "mac", detail: "/Users/e/.claude/mcp-env/github.env, GITHUB_PERSONAL_ACCESS_TOKEN", state: "waiting" },
      { kind: "server", name: "github", machine: "mac", detail: "new agent sessions get the new value; running ones keep the old one", state: null },
      { kind: "stack", name: "dev", machine: "mini", detail: "cd /opt/stacks/dev && docker compose up -d", state: null },
    ]);
    expect(reachRows(meta(), [sink("dev-env", {}, "cannot write")])[0]?.state).toBe("cannot write");
  });

  test("used by reads the reach, or the sinks from a backend without it", () => {
    expect(usedByText(meta())).toBe("dev-env, mcp-github-mac and the MCP server github");
    const { impact: _, ...old } = meta();
    expect(usedByText(old)).toBe("dev-env, mcp-github-mac");
    expect(usedByText(meta({ usedBy: [], impact: { sinks: [], servers: [], stacks: [] } }))).toBe("nothing");
  });

  test("without the reach, a backend from before lists the sinks it has", () => {
    const { impact: _, ...old } = meta();
    const r = reachRows(old, [{ sink: { id: "dev-env", machine: "mini", path: "/x", format: "dotenv", keys: { GH_TOKEN: "gh_token" }, state: { GH_TOKEN: "drift" }, error: null }, owner: "mini" }]);
    expect(r).toEqual([
      { kind: "sink", name: "dev-env", machine: "mini", detail: "", state: "drift" },
      { kind: "sink", name: "mcp-github-mac", machine: "", detail: "", state: null },
    ]);
  });

  test("a sink missing from the rows has no state, and several states join once each", () => {
    expect(reachRows(meta(), [])[0]?.state).toBeNull();
    const two = meta({ impact: { sinks: [{ id: "s", machine: "mac", path: "/x", keys: ["A", "B", "C"] }], servers: [], stacks: [] } });
    expect(reachRows(two, [sink("s", { A: "same", B: "waiting", C: "same" })])[0]?.state).toBe("same, waiting");
    expect(reachRows(two, [sink("s", { A: "same" })])[0]?.state).toBe("same, unknown");
  });

  test("a sink whose owner has not passed over the write reads as waiting for it", () => {
    const rows = [sink("dev-env", { GH_TOKEN: "same" }), sink("mcp-github-mac", { GITHUB_PERSONAL_ACCESS_TOKEN: "same" })];
    const r = reachRows(meta(), rows, (owner) => owner === "mac");
    expect(r.map((x) => x.state)).toEqual(["waiting for mac's pass", "waiting for mac's pass", null, null]);
    expect(reachRows(meta(), rows, () => false)[0]?.state).toBe("same");
  });

  test("the key states wear the worst tone, and an error or a wait is not a drift", () => {
    expect(stateTone("same")).toBe("moss");
    expect(stateTone("same, waiting")).toBe("sky");
    expect(stateTone("same, drift")).toBe("rust");
    expect(stateTone("missing, waiting")).toBe("lichen");
    expect(stateTone("waiting for mac's pass")).toBe("sky");
    expect(stateTone("cannot write")).toBe("rust");
    expect(stateTone("phase 3")).toBe("");
    expect(stateTone(null)).toBe("");
  });
});

describe("whether an owner has passed over a write", () => {
  const at = (sinksAt: string | null | undefined, head = "x"): SecretsInfo => ({ ...info(), head, sinksAt });
  test("the mark takes the act's commit and each backend's last finished pass", () => {
    expect(markOf({ head: "bbb2222" }, { mac: at("aaa1111"), mini: at(undefined) })).toEqual({ head: "bbb2222", at: { mac: "aaa1111", mini: undefined } });
    expect(markOf("nothing", { mac: at("aaa1111") }).head).toBeNull();
  });
  test("passed once the owner's pass reached the commit, or moved on from where it was", () => {
    const mark = { head: "bbb2222", at: { mac: "aaa1111" } };
    expect(passedOver(mark, "mac", at("aaa1111", "bbb2222"))).toBe(false); // head moved, pass not finished
    expect(passedOver(mark, "mac", at(null, "bbb2222"))).toBe(false);
    expect(passedOver(mark, "mac", at("bbb2222"))).toBe(true);
    expect(passedOver(mark, "mac", at("ccc3333"))).toBe(true);
    expect(passedOver({ head: "bbb2222", at: { mac: "bbb2222" } }, "mac", at("bbb2222"))).toBe(true);
  });
  test("passed when nothing can be known", () => {
    expect(passedOver(null, "mac", at("a"))).toBe(true);
    expect(passedOver({ head: null, at: {} }, "mac", at("a"))).toBe(true);
    expect(passedOver({ head: "b", at: {} }, null, at("a"))).toBe(true);
    expect(passedOver({ head: "b", at: {} }, "mac", at(undefined))).toBe(true);
    expect(passedOver({ head: "b", at: {} }, "mac", undefined)).toBe(true);
  });
});

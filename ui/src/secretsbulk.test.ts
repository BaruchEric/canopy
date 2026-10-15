import { describe, expect, test } from "bun:test";
import type { SecretProposalInfo } from "../../src/core/types";
import { bulkAct, looksSecret, pick, sinkIdOf } from "./secretsbulk";

const P = (over: Partial<SecretProposalInfo> = {}): SecretProposalInfo => ({
  id: "p1",
  from: "mini",
  source: "/opt/stacks/tailchan/.env",
  key: "TELEGRAM_BOT_TOKEN",
  suggested: "tailchan_telegram_bot_token",
  merges: null,
  same: null,
  namesOnly: false,
  expires: 0,
  ...over,
});

describe("looksSecret", () => {
  test.each([
    "TELEGRAM_BOT_TOKEN",
    "ANSWER_TOKENS",
    "EXECUTOR_SECRET_KEY",
    "BETTER_AUTH_SECRET",
    "EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD",
    "GMAIL_REFRESH_TOKEN",
    "POSTGRES_PASSWORD",
    "BUZZ_S3_ACCESS_KEY",
    "BUZZ_RELAY_PRIVATE_KEY",
    "GF_ADMIN_PW",
    "QBIT_PASS",
    "WIREGUARD_PRIVATE_KEY",
    "DATABASE_URL",
    "SENTRY_DSN",
    "mcpServers.github.env.GITHUB_TOKEN",
  ])("%s is a secret", (key) => expect(looksSecret(key)).toBe(true));

  test.each([
    "TELEGRAM_CHAT_ID",
    "TRUST_NETS",
    "HUMANS",
    "EXECUTOR_BOOTSTRAP_ADMIN_EMAIL",
    "COLLABORATIVE_IMAGE",
    "BUZZ_REQUIRE_AUTH_TOKEN",
    "BUZZ_ALLOW_NIP_OA_AUTH",
    "OPENAI_REALTIME_CONTEXT_TOKENS",
    "CANOPY_SECRETS_REMOTE",
    "LITELLM_MAX_TOKENS",
    "PUBLIC_URL",
    "TZ",
  ])("%s is a setting", (key) => expect(looksSecret(key)).toBe(false));
});

describe("sinkIdOf", () => {
  test("a stack's env file is named for the stack", () => {
    expect(sinkIdOf("/opt/stacks/beric-gate/.env")).toBe("beric-gate");
  });
  test("any other dotenv or json file is named for the file", () => {
    expect(sinkIdOf("/import/canopy.env")).toBe("canopy");
    expect(sinkIdOf("/home/eric/.claude/credentials/.credentials.json")).toBe("credentials");
  });
  test("a file that cannot be a sink gets none", () => {
    expect(sinkIdOf("/home/eric/.codex/config.toml")).toBeNull();
    expect(sinkIdOf("/opt/stacks/memory/env.sops.yaml")).toBeNull();
  });
  test("a name outside the sink alphabet is folded into it", () => {
    expect(sinkIdOf("/opt/stacks/My_Stack/.env")).toBe("my-stack");
  });
});

describe("bulkAct", () => {
  test("approves under the suggested name, described and tagged by its stack, kept as a sink", () => {
    expect(bulkAct(P())).toEqual({
      a: "approve",
      proposal: "p1",
      name: "tailchan_telegram_bot_token",
      description: "TELEGRAM_BOT_TOKEN in tailchan",
      tags: ["tailchan"],
      value: null,
      sink: { id: "tailchan" },
    });
  });
  test("an update keeps the secret it updates", () => {
    expect(bulkAct(P({ merges: "tg_token" }))?.name).toBe("tg_token");
  });
  test("a source that can only be listed is left for a typed value", () => {
    expect(bulkAct(P({ namesOnly: true }))).toBeNull();
  });
  test("a key a dotenv sink cannot hold is approved without a sink", () => {
    expect(bulkAct(P({ key: "a.b-c" }))?.sink).toBeNull();
  });
  test("a toml source is approved without a sink", () => {
    const act = bulkAct(P({ source: "/home/eric/.codex/config.toml", key: "mcp_servers.x.env.API_KEY", suggested: "x_api_key" }));
    expect(act?.sink).toBeNull();
    expect(act?.tags).toEqual(["config"]);
  });
});

describe("pick", () => {
  const list = [P({ id: "a" }), P({ id: "b", key: "TRUST_NETS" }), P({ id: "c", namesOnly: true })];
  test("secrets picks what looks secret and can be approved here", () => {
    expect([...pick(list, "secrets")]).toEqual(["a"]);
  });
  test("settings picks what does not look secret; a secret listed by name only is in neither", () => {
    expect([...pick(list, "settings")]).toEqual(["b"]);
    expect([...pick([P({ id: "d", key: "TZ", namesOnly: true })], "settings")]).toEqual(["d"]);
  });
  test("none picks nothing", () => {
    expect(pick(list, "none").size).toBe(0);
  });
});

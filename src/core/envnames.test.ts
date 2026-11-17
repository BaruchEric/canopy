import { describe, expect, test } from "bun:test";
import { gateDrops, stageDrops, takeTriggerSecrets, TRIGGER_ENV_PREFIX, workEnv } from "./envnames";

describe("workEnv", () => {
  test("keeps everything but the server's NODE_ENV and unset names", () => {
    expect(workEnv({ NODE_ENV: "production", PATH: "/bin", GH_TOKEN: "t", GONE: undefined })).toEqual({ PATH: "/bin", GH_TOKEN: "t" });
  });
});

describe("takeTriggerSecrets", () => {
  test("takes every trigger variable out of the env and leaves the rest", () => {
    const env: Record<string, string | undefined> = { CANOPY_TRIGGER_SHOP_SECRET: " s3cret ", CANOPY_TRIGGER_EMPTY: "", PATH: "/bin", SENTRY_DSN: "x" };
    const got = takeTriggerSecrets(env);
    expect([...got.entries()]).toEqual([["CANOPY_TRIGGER_SHOP_SECRET", "s3cret"]]);
    expect(env).toEqual({ PATH: "/bin", SENTRY_DSN: "x" });
  });

  test("a gate would drop one left behind anyway; a stage drops what it lists", () => {
    expect(gateDrops(`${TRIGGER_ENV_PREFIX}X`)).toBe(true);
    expect(stageDrops("PATH")).toBe(false);
  });
});

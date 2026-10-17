import { describe, expect, test } from "bun:test";
import { gateDrops, stageDrops, takeTriggerSecrets, TRIGGER_ENV_PREFIX } from "./envnames";

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

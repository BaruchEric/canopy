import { describe, expect, test } from "bun:test";
import { runConsoleAction } from "./RunSheet";

describe("run console actions", () => {
  test("a send action displays the error and rejects so the composer restores its draft", async () => {
    let shown = "";
    await expect(runConsoleAction(async () => {
      throw new Error("offline");
    }, (message) => {
      shown = message;
    }, true)).rejects.toThrow("offline");
    expect(shown).toBe("offline");
  });

  test("a void action displays the error without an unhandled rejection", async () => {
    let shown = "";
    await runConsoleAction(async () => {
      throw new Error("cannot stop");
    }, (message) => {
      shown = message;
    });
    expect(shown).toBe("cannot stop");
  });
});

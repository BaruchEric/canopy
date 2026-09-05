import { describe, expect, test } from "bun:test";
import { ACTIONS } from "./actions";
import { cliArgs } from "./runner";
import { DEFAULT_AGENT } from "./types";

describe("the print-mode command line", () => {
  test("defaults ask through the prompt tool in the default mode", () => {
    const args = cliArgs(ACTIONS.commit, DEFAULT_AGENT);
    expect(args.slice(0, 2)).toEqual(["-p", "--output-format"]);
    expect(args).toContain("--permission-prompt-tool");
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "default",
    ]);
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("the repo's settings ride along; yolo becomes the bypass mode", () => {
    const args = cliArgs(ACTIONS.chat, { model: "opus", effort: "high", yolo: true, extra: "--name x" });
    expect(args.slice(-6)).toEqual(["--model", "opus", "--effort", "high", "--name", "x"]);
    expect(args).toContain("bypassPermissions");
    // print mode takes the mode, not the interactive flag
    expect(args).not.toContain("--dangerously-skip-permissions");
    // the prompt tool stays: questions still come to the browser
    expect(args).toContain("--permission-prompt-tool");
  });
});

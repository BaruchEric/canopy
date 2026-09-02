import { describe, expect, test } from "bun:test";
import {
  agentShellCommand,
  isOpenerId,
  kittyAgentArgs,
  kittySessionLines,
  terminalAgentArgs,
} from "./openers";

describe("agent launch", () => {
  test("runs claude through the login, interactive shell", () => {
    expect(agentShellCommand("/bin/zsh")).toEqual(["/bin/zsh", "-l", "-i", "-c", "claude"]);
  });

  test("kitty gets a held window at the repo running that shell", () => {
    const args = kittyAgentArgs("/Users/me/dev/a repo", "/bin/zsh");
    expect(args.slice(0, 4)).toEqual(["open", "-na", "kitty.app", "--args"]);
    expect(args).toContain("--single-instance");
    expect(args).toContain("--hold");
    expect(args.slice(args.indexOf("--directory"), args.indexOf("--directory") + 2)).toEqual([
      "--directory",
      "/Users/me/dev/a repo",
    ]);
    expect(args.slice(-5)).toEqual(["/bin/zsh", "-l", "-i", "-c", "claude"]);
  });

  test("Terminal quotes the path for the shell and the line for AppleScript", () => {
    const args = terminalAgentArgs(`/Users/me/it's "here"`);
    expect(args[0]).toBe("osascript");
    const script = args[args.indexOf("-e", 2) + 1];
    // The shell sees cd '/Users/me/it'\''s "here"' once AppleScript has
    // unescaped its own backslashes.
    expect(script).toBe(
      String.raw`do script "cd '/Users/me/it'\\''s \"here\"' && claude"`,
    );
    expect(args).toContain("activate");
  });
});

describe("kitty session", () => {
  test("a plain tab per repo", () => {
    expect(kittySessionLines(["/a/x", "/b/y"], "kitty")).toBe(
      "new_tab x\ncd /a/x\nlaunch\nnew_tab y\ncd /b/y\nlaunch\n",
    );
  });

  test("the agent tab launches held", () => {
    expect(kittySessionLines(["/a/x"], "agent", "/bin/zsh")).toBe(
      "new_tab x\ncd /a/x\nlaunch --hold /bin/zsh -l -i -c claude\n",
    );
  });
});

test("agent is an opener id", () => {
  expect(isOpenerId("agent")).toBe(true);
  expect(isOpenerId("emacs")).toBe(false);
});

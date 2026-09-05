import { describe, expect, test } from "bun:test";
import {
  agentShellCommand,
  claudeLine,
  isOpenerId,
  kittyAgentArgs,
  kittySessionLines,
  remoteFolderUri,
  sshSessionArgs,
  terminalAgentArgs,
} from "./openers";

const opusYolo = { model: "opus", effort: "high", yolo: true, extra: "--add-dir '../my lib'" } as const;

describe("agent launch", () => {
  test("runs claude through the login, interactive shell", () => {
    expect(agentShellCommand("/bin/zsh")).toEqual(["/bin/zsh", "-l", "-i", "-c", "claude"]);
  });

  test("the repo's agent settings become flags on that one line", () => {
    expect(claudeLine(opusYolo)).toBe(
      "claude --model opus --effort high --dangerously-skip-permissions --add-dir '../my lib'",
    );
    expect(agentShellCommand("/bin/zsh", opusYolo).at(-1)).toBe(claudeLine(opusYolo));
    expect(kittyAgentArgs("/a/x", "/bin/zsh", opusYolo).at(-1)).toBe(claudeLine(opusYolo));
    expect(sshSessionArgs("wsl", "/home/me/x", "agent", opusYolo).at(-1)).toBe(
      `cd '/home/me/x' && ${claudeLine(opusYolo)}`,
    );
    expect(kittySessionLines(["/a/x"], "agent", "/bin/zsh", () => opusYolo)).toContain(
      `launch --hold /bin/zsh -l -i -c ${claudeLine(opusYolo)}\n`,
    );
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

describe("repos on another host", () => {
  test("an ssh session lands at the repo, in a shell or the agent", () => {
    expect(sshSessionArgs("wsl", "/home/me/a repo", "shell")).toEqual([
      "ssh",
      "-t",
      "--",
      "wsl",
      `cd '/home/me/a repo' && exec "$SHELL" -l`,
    ]);
    expect(sshSessionArgs("wsl", "/home/me/x", "agent").at(-1)).toBe("cd '/home/me/x' && claude");
  });

  test("Terminal runs the ssh line for a remote agent", () => {
    const args = terminalAgentArgs("ssh://wsl/home/me/x");
    const script = args[args.indexOf("-e", 2) + 1];
    expect(script).toBe(
      // the shell sees cd '/home/me/x' inside the ssh line once AppleScript
      // has unescaped its backslashes, as in the local case above
      String.raw`do script "'ssh' '-t' '--' 'wsl' 'cd '\\''/home/me/x'\\'' && claude'"`,
    );
  });

  test("a kitty session tab for a remote repo launches ssh instead of cd", () => {
    const lines = kittySessionLines(["/Users/me/dev/a", "ssh://wsl/home/me/b"], "kitty");
    expect(lines).toBe(
      "new_tab a\ncd /Users/me/dev/a\nlaunch\n" +
        `new_tab b\nlaunch 'ssh' '-t' '--' 'wsl' 'cd '\\''/home/me/b'\\'' && exec "$SHELL" -l'\n`,
    );
    expect(kittySessionLines(["ssh://wsl/home/me/b"], "agent", "/bin/zsh")).toContain(
      "launch --hold 'ssh'",
    );
  });

  test("VS Code gets the Remote-SSH folder form", () => {
    expect(remoteFolderUri("wsl", "/home/me/dev")).toBe("vscode-remote://ssh-remote+wsl/home/me/dev");
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

test("agent and herdr are opener ids", () => {
  expect(isOpenerId("agent")).toBe(true);
  expect(isOpenerId("herdr")).toBe(true);
  expect(isOpenerId("emacs")).toBe(false);
});

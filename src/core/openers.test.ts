import { describe, expect, test } from "bun:test";
import {
  agentShellCommand,
  claudeLine,
  fileOpenArgs,
  isOpenerId,
  kittyAgentArgs,
  kittyInstanceArgs,
  kittySessionLines,
  kittyTabArgs,
  linuxAgentArgs,
  linuxCommandFor,
  linuxRemoteCommandFor,
  remoteFolderUri,
  sshSessionArgs,
  terminalAgentArgs,
  terminalLineArgs,
  userShell,
} from "./openers";
import { shellQuote } from "./host";
import { DEFAULT_AGENT } from "./types";

const opusYolo = { model: "opus", effort: "high", yolo: true, extra: "--add-dir '../my lib'" } as const;
/** the defaults with yolo off, for the tests about a bare `claude` line */
const ask = { ...DEFAULT_AGENT, yolo: false };

describe("agent launch", () => {
  test("runs claude through the login, interactive shell", () => {
    expect(agentShellCommand("/bin/zsh", ask)).toEqual(["/bin/zsh", "-l", "-i", "-c", "claude"]);
  });

  test("the defaults skip permissions", () => {
    expect(agentShellCommand("/bin/zsh").at(-1)).toBe("claude --dangerously-skip-permissions");
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
      `launch --hold /bin/zsh -l -i -c ${shellQuote(claudeLine(opusYolo))}\n`,
    );
  });

  test("kitty gets a held window at the repo running that shell", () => {
    const args = kittyAgentArgs("/Users/me/dev/a repo", "/bin/zsh", ask);
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
    const args = terminalAgentArgs(`/Users/me/it's "here"`, ask);
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
    expect(sshSessionArgs("wsl", "/home/me/x", "agent", ask).at(-1)).toBe(
      "cd '/home/me/x' && claude",
    );
  });

  test("Terminal runs the ssh line for a remote agent", () => {
    const args = terminalAgentArgs("ssh://wsl/home/me/x", ask);
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
    expect(kittySessionLines(["/a/x"], "agent", "/bin/zsh", () => ask)).toBe(
      "new_tab x\ncd /a/x\nlaunch --hold /bin/zsh -l -i -c claude\n",
    );
  });
});

describe("tabs", () => {
  test("a kitty tab goes over the socket, at the folder or running a held command", () => {
    expect(kittyTabArgs("kitten", "/cfg/kitty.sock-12", "/a/x")).toEqual([
      "kitten",
      "@",
      "--to",
      "unix:/cfg/kitty.sock-12",
      "launch",
      "--type=tab",
      "--cwd=/a/x",
    ]);
    expect(kittyTabArgs("kitten", "/s", null, ["ssh", "-t", "--", "wsl", "cd x"], true)).toEqual([
      "kitten",
      "@",
      "--to",
      "unix:/s",
      "launch",
      "--type=tab",
      "--hold",
      "ssh",
      "-t",
      "--",
      "wsl",
      "cd x",
    ]);
  });

  test("every kitty canopy starts is its own instance, listening socket-only", () => {
    expect(kittyInstanceArgs("/cfg/kitty.sock")).toEqual([
      "--single-instance",
      "--instance-group",
      "canopy",
      "--listen-on",
      "unix:/cfg/kitty.sock",
      "-o",
      "allow_remote_control=socket-only",
    ]);
    expect(kittyAgentArgs("/a/x", "/bin/zsh", ask)).toContain("allow_remote_control=socket-only");
  });

  test("a Terminal tab presses cmd-t in the front window, or opens one when there is none", () => {
    const lines = (args: string[]) => args.filter((a) => a !== "-e").slice(1);
    expect(lines(terminalLineArgs("cd /a/x"))).toEqual([
      'tell application "Terminal"',
      'do script "cd /a/x"',
      "activate",
      "end tell",
    ]);
    const tab = lines(terminalLineArgs("cd /a/x", true));
    expect(tab[0]).toBe('tell application "Terminal"');
    expect(tab).toContain("if (count of windows) is 0 then");
    expect(tab).toContain('tell application "System Events" to keystroke "t" using command down');
    expect(tab).toContain('do script "cd /a/x" in front window');
  });
});

test("agent and herdr are opener ids", () => {
  expect(isOpenerId("agent")).toBe(true);
  expect(isOpenerId("herdr")).toBe(true);
  expect(isOpenerId("emacs")).toBe(false);
});

describe("fileOpenArgs", () => {
  test("a local file opens in VS Code at its line through -g", () => {
    expect(fileOpenArgs(null, "/Users/me/dev/app", "src/a b.ts", 12)).toEqual([
      "code",
      "-g",
      "/Users/me/dev/app/src/a b.ts:12",
    ]);
  });

  test("a remote file goes through the host's Remote-SSH window", () => {
    expect(fileOpenArgs("wsl", "/home/me/dev/app", "src/a.ts", 3)).toEqual([
      "code",
      "--remote",
      "ssh-remote+wsl",
      "-g",
      "/home/me/dev/app/src/a.ts:3",
    ]);
  });
});

describe("userShell", () => {
  const saved = process.env.SHELL;
  const restore = () => {
    if (saved === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved;
  };

  test("the login shell the server was started with wins", () => {
    process.env.SHELL = "/opt/homebrew/bin/fish";
    try {
      expect(userShell()).toBe("/opt/homebrew/bin/fish");
    } finally {
      restore();
    }
  });

  test("without one, the platform's default: zsh on a Mac, bash elsewhere", () => {
    delete process.env.SHELL;
    try {
      expect(userShell()).toBe(process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    } finally {
      restore();
    }
  });
});

describe("the openers on a Linux desktop", () => {
  const inst = ["--single-instance", "--instance-group", "canopy", "--listen-on", "unix:/x/kitty.sock", "-o", "allow_remote_control=socket-only"];

  test("kitty detaches at the folder, code and xdg-open take the path", () => {
    expect(linuxCommandFor("kitty", "/r", inst)).toEqual(["kitty", "--detach", ...inst, "--directory", "/r"]);
    expect(linuxCommandFor("code", "/r", inst)).toEqual(["code", "/r"]);
    expect(linuxCommandFor("finder", "/r", inst)).toEqual(["xdg-open", "/r"]);
    expect(() => linuxCommandFor("terminal", "/r", inst)).toThrow(/Mac app/);
  });

  test("a repo on another host: kitty runs the ssh session, code the remote uri", () => {
    expect(linuxRemoteCommandFor("kitty", "mini", "/r", inst)).toEqual([
      "kitty", "--detach", ...inst, "ssh", "-t", "--", "mini", "cd '/r' && exec \"$SHELL\" -l",
    ]);
    expect(linuxRemoteCommandFor("code", "mini", "/r", inst)).toEqual(["code", "--folder-uri", "vscode-remote://ssh-remote+mini/r"]);
    expect(() => linuxRemoteCommandFor("finder", "mini", "/r", inst)).toThrow(/another host/);
  });

  test("the agent is a held kitty window, at the folder or over ssh", () => {
    expect(linuxAgentArgs("/r", ask, "/bin/bash", inst)).toEqual([
      "kitty", "--detach", ...inst, "--hold", "--directory", "/r", "/bin/bash", "-l", "-i", "-c", "claude",
    ]);
    expect(linuxAgentArgs("ssh://mini/r", opusYolo, "/bin/bash", inst)).toEqual([
      "kitty", "--detach", ...inst, "--hold", "ssh", "-t", "--", "mini", `cd '/r' && ${claudeLine(opusYolo)}`,
    ]);
  });
});

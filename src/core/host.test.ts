import { describe, expect, test } from "bun:test";
import {
  isSshHost,
  parseLocator,
  parseSshHosts,
  remoteCommand,
  shellQuote,
  sshArgs,
  tildeQuote,
  toLocator,
} from "./host";

describe("locators", () => {
  test("a plain path is local", () => {
    expect(parseLocator("/Users/me/dev")).toEqual({ host: null, path: "/Users/me/dev" });
    expect(toLocator(null, "/Users/me/dev")).toBe("/Users/me/dev");
  });

  test("ssh:// carries the host and keeps the absolute path", () => {
    expect(parseLocator("ssh://wsl/home/me/dev")).toEqual({ host: "wsl", path: "/home/me/dev" });
    expect(toLocator("wsl", "/home/me/dev")).toBe("ssh://wsl/home/me/dev");
    expect(parseLocator(toLocator("a@b", "/x"))).toEqual({ host: "a@b", path: "/x" });
  });

  test("a host alone means its root", () => {
    expect(parseLocator("ssh://wsl")).toEqual({ host: "wsl", path: "/" });
  });
});

describe("host names", () => {
  test("accepts aliases and user@host, refuses options and spaces", () => {
    expect(isSshHost("wsl")).toBe(true);
    expect(isSshHost("eric@macmini-2018.tail.ts.net")).toBe(true);
    expect(isSshHost("-oProxyCommand=evil")).toBe(false);
    expect(isSshHost("a host")).toBe(false);
    expect(isSshHost("")).toBe(false);
  });
});

describe("quoting", () => {
  test("single quotes survive", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
  });

  test("a leading tilde stays outside the quotes so the remote expands it", () => {
    expect(tildeQuote("~")).toBe("~");
    expect(tildeQuote("~/my dev")).toBe(`~/'my dev'`);
    expect(tildeQuote("/abs/path")).toBe("'/abs/path'");
    expect(tildeQuote("")).toBe("~");
  });

  test("the remote command is one quoted line", () => {
    expect(remoteCommand(["git", "-C", "/a b", "status"])).toBe(
      "'git' '-C' '/a b' 'status'",
    );
  });

  test("ssh never prompts and shares a connection per host", () => {
    const args = sshArgs("wsl", "/tmp/cfg");
    expect(args[0]).toBe("ssh");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ControlMaster=auto");
    expect(args).toContain("ControlPath=/tmp/cfg/ssh-%C");
    // the host comes after "--", so a name can never read as an option
    expect(args.slice(-2)).toEqual(["--", "wsl"]);
  });
});

describe("ssh config", () => {
  test("lists aliases, skips patterns and duplicates", () => {
    const text = `
Host qnap qnap-lan
  HostName 192.168.1.10
Host *
  ServerAliveInterval 30
host wsl
Host qnap !qnap-lan
`;
    expect(parseSshHosts(text)).toEqual(["qnap", "qnap-lan", "wsl"]);
  });
});

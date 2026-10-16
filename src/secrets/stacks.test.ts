import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../core/exec";
import { parseContainers, parseStacks, sshStacks } from "./stacks";

describe("the restart key's answers", () => {
  test("parseStacks keeps well-formed project lines, sorted", () => {
    expect(parseStacks("memory\t/opt/stacks/memory/docker-compose.yml\nbuzz-prod\t/opt/stacks/buzz/compose.yml,/opt/stacks/buzz/compose.mini.yml\nBad Name\t/x\nnofiles\t\nrel\tcompose.yml\n")).toEqual([
      { name: "buzz-prod", files: ["/opt/stacks/buzz/compose.yml", "/opt/stacks/buzz/compose.mini.yml"] },
      { name: "memory", files: ["/opt/stacks/memory/docker-compose.yml"] },
    ]);
  });

  test("parseContainers keeps three fields a line and nothing else", () => {
    expect(parseContainers("redis\trunning\thealthy\nrelay\trunning\t\n\nextra\ta\tb\tc\n")).toEqual([
      { service: "redis", state: "running", health: "healthy" },
      { service: "relay", state: "running", health: "" },
    ]);
  });
});

describe("sshStacks", () => {
  const calls: string[][] = [];
  const answer = (r: Partial<ExecResult>) => async (argv: string[]): Promise<ExecResult> => {
    calls.push(argv);
    return { code: 0, stdout: "", stderr: "", ...r };
  };
  const o = { dir: "/restart", host: "192.168.48.1", user: "eric" };

  test("asks over ssh with the key, the pinned host key and no prompt, the request as the command", async () => {
    calls.length = 0;
    const s = sshStacks({ ...o, run: answer({ stdout: "dns-prod\t/opt/stacks/dns/compose.yml\n" }) });
    expect(await s.list()).toEqual({ stacks: [{ name: "dns-prod", files: ["/opt/stacks/dns/compose.yml"] }] });
    const argv = calls[0] ?? [];
    expect(argv.slice(0, 3)).toEqual(["ssh", "-i", "/restart/key"]);
    expect(argv).toContain("UserKnownHostsFile=/restart/known_hosts");
    expect(argv).toContain("StrictHostKeyChecking=yes");
    expect(argv).toContain("BatchMode=yes");
    expect(argv.slice(-2)).toEqual(["eric@192.168.48.1", "list"]);
  });

  test("a restart returns compose's code and the containers; ssh's own failure and a refusal are errors", async () => {
    expect(await sshStacks({ ...o, run: answer({ code: 1, stdout: "redis\texited\t\n" }) }).restart("buzz-prod")).toEqual({ code: 1, containers: [{ service: "redis", state: "exited", health: "" }] });
    expect(await sshStacks({ ...o, run: answer({ code: 255, stderr: "Permission denied (publickey).\n" }) }).restart("buzz-prod")).toEqual({ error: "Permission denied (publickey)." });
    expect(await sshStacks({ ...o, run: answer({ code: 2, stderr: "canopy-restart: no compose project named x\n" }) }).restart("x")).toEqual({ error: "canopy-restart: no compose project named x" });
    expect(await sshStacks({ ...o, run: answer({}) }).restart("a b")).toEqual({ error: "a b is not a project name" });
    expect(await sshStacks({ ...o, run: answer({ code: 255, stderr: "" }) }).list()).toEqual({ error: "the host did not list its stacks: exit 255" });
  });
});

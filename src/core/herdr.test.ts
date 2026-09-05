import { describe, expect, test } from "bun:test";
import {
  herdrAgentName,
  herdrRemoteLine,
  herdrStartArgs,
  parseAgentNames,
  parseCreated,
  parsePanes,
} from "./herdr";
import { DEFAULT_AGENT } from "./types";

describe("herdr names and argv", () => {
  test("a repo name becomes a legal, unique agent name", () => {
    expect(herdrAgentName("canopy", [])).toBe("canopy");
    expect(herdrAgentName("My Repo.v2", [])).toBe("my-repo-v2");
    expect(herdrAgentName("123", [])).toBe("claude");
    expect(herdrAgentName("canopy", ["canopy"])).toBe("canopy-2");
    expect(herdrAgentName("canopy", ["canopy", "canopy-2"])).toBe("canopy-3");
    const long = herdrAgentName("a".repeat(40), ["a".repeat(32)]);
    expect(long).toBe(`${"a".repeat(30)}-2`);
    expect(long.length).toBeLessThanOrEqual(32);
  });

  test("agent start passes the settings after --, and nothing without them", () => {
    expect(herdrStartArgs("canopy", "wF:p1", DEFAULT_AGENT)).toEqual([
      "agent",
      "start",
      "canopy",
      "--kind",
      "claude",
      "--pane",
      "wF:p1",
    ]);
    expect(
      herdrStartArgs("canopy", "wF:p1", { model: "opus", effort: "default", yolo: true, extra: "" }),
    ).toEqual([
      "agent",
      "start",
      "canopy",
      "--kind",
      "claude",
      "--pane",
      "wF:p1",
      "--",
      "--model",
      "opus",
      "--dangerously-skip-permissions",
    ]);
  });

  test("a remote repo's pane runs an ssh session that starts claude there", () => {
    expect(
      herdrRemoteLine("wsl", "/home/me/a repo", { ...DEFAULT_AGENT, model: "sonnet" }),
    ).toBe(`ssh -t -- wsl 'cd '\\''/home/me/a repo'\\'' && claude --model sonnet'`);
  });
});

describe("herdr replies", () => {
  const created = JSON.stringify({
    id: "cli:workspace:create",
    result: {
      type: "workspace_created",
      root_pane: { pane_id: "wF:p1", workspace_id: "wF", cwd: "/x" },
      tab: { tab_id: "wF:t1" },
      workspace: { workspace_id: "wF", label: "x" },
    },
  });

  test("workspace create names the workspace and its pane", () => {
    expect(parseCreated(created)).toEqual({ workspace: "wF", pane: "wF:p1" });
    expect(parseCreated("not json")).toBeNull();
    expect(parseCreated(JSON.stringify({ result: { type: "ok" } }))).toBeNull();
  });

  test("pane list keeps the fields the lookup needs", () => {
    const json = JSON.stringify({
      result: {
        panes: [
          { pane_id: "w8:p1", workspace_id: "w8", cwd: "/Users/me", agent_status: "unknown" },
          { pane_id: "wE:p1", workspace_id: "wE", cwd: "/Users/me/dev/x", agent_status: "working" },
          { nonsense: true },
        ],
      },
    });
    expect(parsePanes(json)).toEqual([
      { pane_id: "w8:p1", workspace_id: "w8", cwd: "/Users/me", agent_status: "unknown" },
      { pane_id: "wE:p1", workspace_id: "wE", cwd: "/Users/me/dev/x", agent_status: "working" },
    ]);
    expect(parsePanes("")).toEqual([]);
  });

  test("agent list yields the names in use, skipping unnamed agents", () => {
    const json = JSON.stringify({
      result: { agents: [{ agent: "claude", name: "reviewer" }, { agent: "claude" }] },
    });
    expect(parseAgentNames(json)).toEqual(["reviewer"]);
  });
});

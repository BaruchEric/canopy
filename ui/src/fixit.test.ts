import { describe, expect, test } from "bun:test";
import { fixMove, fixPrompt, lastRun, taskFixPrompt } from "./fixit";

describe("fixMove", () => {
  test("knows the moves an agent can finish", () => {
    expect(fixMove("push")).toBe("push");
    expect(fixMove("commit+push")).toBe("commit+push");
    expect(fixMove("spec sync")).toBe("spec sync");
  });

  test("leaves out the rest", () => {
    expect(fixMove("suggest")).toBeNull();
    expect(fixMove("open-vscode")).toBeNull();
    expect(fixMove("seed")).toBeNull();
    expect(fixMove("toString")).toBeNull();
  });
});

describe("fixPrompt", () => {
  const rejected = [
    "To https://github.com/BaruchEric/homelab.git",
    " ! [rejected]        main -> main (non-fast-forward)",
    "error: failed to push some refs to 'https://github.com/BaruchEric/homelab.git'",
  ].join("\n");

  test("quotes git and asks for the push to be finished", () => {
    const p = fixPrompt("push", `${rejected}\n`);
    expect(p.startsWith("I pressed push in canopy and it failed:")).toBe(true);
    expect(p).toContain(" ! [rejected]        main -> main (non-fast-forward)");
    expect(p).toContain("then finish the push.");
    expect(p).not.toContain("Do not push");
  });

  test("a plain commit says not to push", () => {
    expect(fixPrompt("commit", "nothing staged")).toContain("then finish the commit. Do not push.");
  });

  test("keeps the last 40 lines of a long answer", () => {
    const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const p = fixPrompt("pull", long);
    expect(p).toContain("line 99");
    expect(p).toContain("line 60");
    expect(p).not.toContain("line 59\n");
  });
});

describe("lastRun", () => {
  const line = (n: number, text: string, mark?: true) => ({ n, text, at: mark ? n : null, ...(mark ? { mark } : {}) });

  test("keeps what follows the last start marker", () => {
    const lines = [line(1, "<m>", true), line(2, "old run"), line(3, "<m>", true), line(4, "new run"), line(5, "exit")];
    expect(lastRun(lines)).toEqual(["new run", "exit"]);
  });

  test("keeps the whole tail when no marker is in it", () => {
    expect(lastRun([line(7, "a"), line(8, "b")])).toEqual(["a", "b"]);
  });
});

describe("taskFixPrompt", () => {
  const task = { name: "test", cmd: "bun run test", exitCode: 1 };

  test("names the task, its command and its exit, and quotes the output", () => {
    const p = taskFixPrompt(task, ["(fail) spawnOnPty > leads a session", " 1 fail"]);
    expect(p.startsWith("I ran the test task in canopy (bun run test) and it exited 1.")).toBe(true);
    expect(p).toContain("(fail) spawnOnPty > leads a session");
    expect(p).toContain("run bun run test again until it passes.");
    expect(p).toContain("do not commit or push.");
  });

  test("a task that vanished died, and one that printed nothing says so", () => {
    const p = taskFixPrompt({ ...task, exitCode: null }, []);
    expect(p).toContain("and it died.");
    expect(p).toContain("(it printed nothing)");
  });

  test("keeps the last 60 lines of a long run", () => {
    const p = taskFixPrompt(task, Array.from({ length: 100 }, (_, i) => `line ${i}`));
    expect(p).toContain("line 99");
    expect(p).toContain("line 40");
    expect(p).not.toContain("line 39\n");
  });
});

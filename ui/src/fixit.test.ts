import { describe, expect, test } from "bun:test";
import { fixMove, fixPrompt } from "./fixit";

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

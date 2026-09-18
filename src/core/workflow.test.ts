import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "./workflow";

const meta = { name: "ship", source: "bundled" as const, file: "/x/ship.md" };

const SHIP = `---
name: ship
label: ship it
verb: ship
blurb: Runs the gates, commits, pushes.
when: dirty-or-unpushed
expects-change: true
note: anything Claude should know
---

## Gates
tools: bun
turns: 12
check: bun run typecheck && bun test

Run the project's own gates.

## Commit
tools: git-read, git-commit, Bash(cargo fmt:*)
gate: verdict

Task: commit the current changes.

## Push
tools: git-read, git-push
gate: ask

Task: push the branch.
`;

describe("parseWorkflow", () => {
  test("reads the frontmatter and every step", () => {
    const e = parseWorkflow(SHIP, meta);
    if (!e.ok) throw new Error(e.error);
    const w = e.workflow;
    expect(w.name).toBe("ship");
    expect(w.label).toBe("ship it");
    expect(w.verb).toBe("ship");
    expect(w.when).toBe("dirty-or-unpushed");
    expect(w.expectsChange).toBe(true);
    expect(w.notePlaceholder).toBe("anything Claude should know");
    expect(w.noteRequired).toBe(false);
    expect(w.source).toBe("bundled");
    expect(w.file).toBe("/x/ship.md");
    expect(w.steps.map((s) => s.name)).toEqual(["Gates", "Commit", "Push"]);
    const [gates, commit, push] = w.steps;
    expect(gates?.turns).toBe(12);
    expect(gates?.check).toBe("bun run typecheck && bun test");
    expect(gates?.gate).toBe("continue");
    expect(gates?.tools).toContain("Bash(bun run:*)");
    expect(gates?.body).toBe("Run the project's own gates.");
    expect(commit?.tools).toContain("Bash(git commit:*)");
    expect(commit?.tools).toContain("Bash(cargo fmt:*)");
    expect(commit?.gate).toBe("verdict");
    expect(commit?.turns).toBe(30);
    expect(push?.gate).toBe("ask");
    expect(push?.check).toBeNull();
  });

  test("defaults: name from the file, label from the name, verb from the label, git-read tools, when any", () => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## Only\n\nDo it.\n`, { ...meta, name: "tidy" });
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.name).toBe("tidy");
    expect(e.workflow.label).toBe("tidy");
    expect(e.workflow.verb).toBe("tidy");
    expect(e.workflow.when).toBe("any");
    expect(e.workflow.expectsChange).toBe(false);
    expect(e.workflow.steps[0]?.tools).toEqual(["Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git branch:*)", "Bash(git remote:*)", "Bash(git rev-parse:*)", "Bash(git fetch:*)"]);
  });

  test("a check-only step has no body", () => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## Gates\ncheck: bun test\n\n## Do\n\nWork.\n`, meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.steps[0]?.body).toBe("");
    expect(e.workflow.steps[0]?.check).toBe("bun test");
  });

  test("note-required makes the note the task", () => {
    const e = parseWorkflow(`---\nblurb: b\nnote: what to do\nnote-required: true\n---\n\n## Do\n\nWork.\n`, meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.noteRequired).toBe(true);
  });

  test.each([
    ["no frontmatter", `## Do\n\nWork.\n`, "frontmatter"],
    ["no blurb", `---\nname: x\n---\n\n## Do\n\nWork.\n`, "blurb"],
    ["bad name", `---\nname: Bad Name\nblurb: b\n---\n\n## Do\n\nWork.\n`, "name"],
    ["bad when", `---\nblurb: b\nwhen: sometimes\n---\n\n## Do\n\nWork.\n`, "when"],
    ["no steps", `---\nblurb: b\n---\n\nJust prose.\n`, "step"],
    ["bad gate", `---\nblurb: b\n---\n\n## Do\ngate: maybe\n\nWork.\n`, "gate"],
    ["bad turns", `---\nblurb: b\n---\n\n## Do\nturns: lots\n\nWork.\n`, "turns"],
    ["duplicate step", `---\nblurb: b\n---\n\n## Do\n\nA.\n\n## Do\n\nB.\n`, "twice"],
    ["empty step", `---\nblurb: b\n---\n\n## Do\n\n## Next\n\nB.\n`, "neither a prompt nor a check"],
  ])("rejects %s", (_label, text, word) => {
    const e = parseWorkflow(text, meta);
    expect(e.ok).toBe(false);
    if (!e.ok) {
      expect(e.error).toContain(word);
      expect(e.name).toBe("ship");
      expect(e.file).toBe("/x/ship.md");
    }
  });
});

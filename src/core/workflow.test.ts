import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

  test("agent: a step's own profile, else the workflow's, else none", () => {
    const text = `---\nblurb: b\nagent: deep\n---\n\n## Plan\n\nThink.\n\n## Review\nagent: review\ntools: git-read\n\nLook.\n\n## Check\ncheck: bun test\n`;
    const e = parseWorkflow(text, meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.steps.map((s) => s.agent)).toEqual(["deep", "review", "deep"]);
    expect(e.workflow.steps[1]?.tools).toContain("Bash(git status:*)");
    const plain = parseWorkflow(`---\nblurb: b\n---\n\n## Do\n\nWork.\n`, meta);
    if (!plain.ok) throw new Error(plain.error);
    expect(plain.workflow.steps[0]).not.toHaveProperty("agent");
    // an empty line is no pick
    const empty = parseWorkflow(`---\nblurb: b\n---\n\n## Do\nagent:\n\nWork.\n`, meta);
    if (!empty.ok) throw new Error(empty.error);
    expect(empty.workflow.steps[0]?.agent).toBeUndefined();
  });

  test("a bare tools: line falls back to git-read", () => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## Do\ntools:\n\nWork.\n`, meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.steps[0]?.tools).toEqual(["Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git branch:*)", "Bash(git remote:*)", "Bash(git rev-parse:*)", "Bash(git fetch:*)"]);
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
    ["bad step agent", `---\nblurb: b\n---\n\n## Do\nagent: Deep One\n\nWork.\n`, "step Do: agent must name a profile"],
    ["bad workflow agent", `---\nblurb: b\nagent: --yolo\n---\n\n## Do\n\nWork.\n`, "agent must name a profile"],
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

describe("the bundled ship file", () => {
  // The Gates check is one shell line with quotes, braces and a $ in it. The
  // parser takes a key line's value raw, and this proves it stays that way.
  const CHECK =
    '[ ! -f package.json ] || for s in typecheck lint test build; do grep -q "\\"$s\\"" package.json && { bun run "$s" || exit 1; }; done; exit 0';
  test("parses with its check kept character for character", async () => {
    const file = join(import.meta.dir, "../../lib/workflows/ship.md");
    const e = parseWorkflow(await readFile(file, "utf8"), { name: "ship", source: "bundled", file });
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.workflow.steps[0]?.check).toBe(CHECK);
  });
});

describe("retries, back, evidence and budget", () => {
  const three = (keys: string, front = "") =>
    `---\nblurb: b\n${front}---\n\n## First\n\nOne.\n\n## Second\n${keys}\n\nTwo.\n\n## Third\n\nThree.\n`;

  test("defaults: no retries, back to itself, no evidence, no budget", () => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## Do\n\nWork.\n`, meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.budget).toBeNull();
    expect(e.workflow.steps[0]?.retries).toBe(0);
    expect(e.workflow.steps[0]?.back).toBe("Do");
    expect(e.workflow.steps[0]?.evidence).toEqual([]);
  });

  test("reads every key", () => {
    const e = parseWorkflow(
      three("gate: judge\nretries: 2\nback: First\nevidence: .canopy/intent.md .canopy/research.md", "budget: 30 runs, 6h\n"),
      meta,
    );
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.budget).toEqual({ runs: 30, hours: 6 });
    const s = e.workflow.steps[1];
    expect(s?.gate).toBe("judge");
    expect(s?.retries).toBe(2);
    expect(s?.back).toBe("First");
    expect(s?.evidence).toEqual([".canopy/intent.md", ".canopy/research.md"]);
  });

  test("a single run and fractional hours", () => {
    const e = parseWorkflow(three("", "budget: 1 run, 0.5h\n"), meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.budget).toEqual({ runs: 1, hours: 0.5 });
  });

  test.each<[string, string, string]>([
    ["retries: -1", "", "retries must be a whole number from 0 to 10"],
    ["retries: 11", "", "retries must be a whole number from 0 to 10"],
    ["retries: two", "", "retries must be a whole number from 0 to 10"],
    ["back: Third", "", "back must name this step or an earlier one, not Third"],
    ["back: Nope", "", "back names no step called Nope"],
    ["gate: judge\nevidence: /etc/passwd", "", "evidence must be paths inside the repo, not /etc/passwd"],
    ["gate: judge\nevidence: ../x.md", "", "evidence must be paths inside the repo, not ../x.md"],
    ["evidence: a.md", "", "evidence is only read by gate: judge"],
    ["", "budget: lots\n", 'budget must read like "30 runs, 6h", not lots'],
    ["", "budget: 0 runs, 1h\n", 'budget must read like "30 runs, 6h", not 0 runs, 1h'],
    ["", "budget: 3 runs, 0h\n", 'budget must read like "30 runs, 6h", not 3 runs, 0h'],
  ])("refuses %p %p", (keys, front, error) => {
    const e = parseWorkflow(three(keys, front), meta);
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error).toContain(error);
  });

  // a check-only step has no body, so the table's three() helper cannot build it
  const checkOnly = (keys: string) =>
    `---\nblurb: b\n---\n\n## First\n\nOne.\n\n## Gate\ncheck: true\n${keys}\n\n## Third\n\nThree.\n`;

  test("refuses retries on a check-only step that goes back to itself", () => {
    const e = parseWorkflow(checkOnly("retries: 2"), meta);
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error).toContain("step Gate: a check-only step's retries need back: an earlier step");
  });

  test("allows retries on a check-only step that goes back to an earlier one", () => {
    const e = parseWorkflow(checkOnly("retries: 2\nback: First"), meta);
    expect(e.ok).toBe(true);
  });

  test("allows a check-only step with no retries", () => {
    expect(parseWorkflow(checkOnly(""), meta).ok).toBe(true);
  });
});

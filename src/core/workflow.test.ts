import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GATES_CHECK } from "./gates";
import type { Workflow } from "./types";
import { chained, parseWorkflow, readOnlyStep, readOnlyTools, unattendedRefusal, type RecordedWorkflow } from "./workflow";

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

describe("a check line", () => {
  // A check can be one shell line with quotes, braces and a $ in it. The
  // parser takes a key line's value raw, and this proves it stays that way.
  const CHECK =
    '[ ! -f package.json ] || for s in typecheck lint test build; do grep -q "\\"$s\\"" package.json && { bun run "$s" || exit 1; }; done; exit 0';
  test("parses with its check kept character for character", () => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## Gates\ncheck: ${CHECK}\n\nRun them.\n`, meta);
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.workflow.steps[0]?.check).toBe(CHECK);
  });

  test("the bundled ship file checks its Gates step with the repo's gates", async () => {
    const file = join(import.meta.dir, "../../lib/workflows/ship.md");
    const e = parseWorkflow(await readFile(file, "utf8"), { name: "ship", source: "bundled", file });
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.workflow.steps[0]?.check).toBe("@gates");
  });

  test("the bundled issue-fix file is one unlisted step that commits and never pushes", async () => {
    const file = join(import.meta.dir, "../../lib/workflows/issue-fix.md");
    const e = parseWorkflow(await readFile(file, "utf8"), { name: "issue-fix", source: "bundled", file });
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.workflow.listed).toBe(false);
    expect(e.workflow.expectsChange).toBe(true);
    expect(e.workflow.steps).toHaveLength(1);
    expect(e.workflow.steps[0]?.tools).toContain("Bash(git commit:*)");
    expect(e.workflow.steps[0]?.tools.some((t) => t.includes("push"))).toBe(false);
    expect(e.workflow.steps[0]?.body).toContain("do not push");
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

describe("listed", () => {
  const meta = { name: "w", source: "bundled" as const, file: "/w.md" };
  const text = (line: string) => `---\nblurb: b\n${line}---\n\n## A\n\nDo it.\n`;
  test("absent or true is listed; false marks it", () => {
    const plain = parseWorkflow(text(""), meta);
    expect(plain.ok && plain.workflow.listed).toBeUndefined();
    const yes = parseWorkflow(text("listed: true\n"), meta);
    expect(yes.ok && yes.workflow.listed).toBeUndefined();
    const no = parseWorkflow(text("listed: false\n"), meta);
    expect(no.ok && no.workflow.listed).toBe(false);
  });
  test("anything else is an error", () => {
    const bad = parseWorkflow(text("listed: maybe\n"), meta);
    expect(bad.ok).toBe(false);
  });
});

describe("after, when and mode", () => {
  const graph = (review = "", fix = "", docs = "") =>
    `---\nblurb: b\n---\n\n## Build\ntools: git-read, git-commit\n\nbuild\n\n## Review\ntools: read\ngate: verdict\n${review}\n\nreview\n\n## Fix\nafter: Review\n${fix}\n\nfix\n\n## Docs\nafter: Build\ntools: read\n${docs}\n\ndocs\n`;

  test("reads the keys, and writes the chain out where a step has none", () => {
    const e = parseWorkflow(graph("", "when: verdict partial, verdict blocked\nmode: manual"), meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.steps.map((s) => s.after)).toEqual([[], ["Build"], ["Review"], ["Build"]]);
    expect(e.workflow.steps.map((s) => s.when)).toEqual([["always"], ["always"], ["verdict partial", "verdict blocked"], ["always"]]);
    expect(e.workflow.steps.map((s) => s.mode)).toEqual(["auto", "auto", "manual", "auto"]);
    expect(e.workflow.steps[2]).not.toHaveProperty("modeFrom");
  });

  test("after is trimmed and deduped", () => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## A\n\na\n\n## B\n\nb\n\n## C\nafter: A ,, B, A\n\nc\n`, meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.steps[2]?.after).toEqual(["A", "B"]);
  });

  test("an empty when list defaults to always", () => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## A\nwhen: , ,\n\na\n`, meta);
    if (!e.ok) throw new Error(e.error);
    expect(e.workflow.steps[0]?.when).toEqual(["always"]);
  });

  test.each<[string, string]>([
    [graph("", "after: Nope"), "step Fix: after names no step called Nope"],
    [graph("", "after: Fix"), "step Fix: after names itself"],
    [graph("", "after: Docs"), "step Fix: after names a later step, Docs"],
    [graph("", "when: sometimes"), "step Fix: when must be one of always, verdict done, verdict partial, verdict blocked, judge meets, judge partly, judge misses, check pass, check fail, changed, unchanged, skipped, not sometimes"],
    [graph("", "", "when: verdict done"), "step Docs: when verdict done needs a step before it with gate: verdict"],
    [graph("", "when: judge meets"), "step Fix: when judge meets needs a step before it with gate: judge"],
    [graph("", "when: check fail"), "step Fix: when check fail needs a step before it with a check"],
    [graph("", "mode: sometimes"), "step Fix: mode must be one of auto, manual, not sometimes"],
    [`---\nblurb: b\n---\n\n## A\nwhen: always\n\na\n`, "step A: when needs a step before it to wait on"],
  ])("refuses %s", (text, error) => {
    const e = parseWorkflow(text, meta);
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error).toBe(error);
  });

  test("retries, back and after go together", () => {
    const e = parseWorkflow(graph("", "after: Review\nretries: 1\nback: Build"), meta);
    expect(e.ok).toBe(true);
  });

  test("every bundled workflow and the example are chains", async () => {
    const dir = join(import.meta.dir, "../../lib/workflows");
    const files = (await readdir(dir)).filter((n) => n.endsWith(".md")).map((n) => join(dir, n));
    files.push(join(import.meta.dir, "../../docs/workflows/example-update-deps.md"));
    for (const file of files) {
      const e = parseWorkflow(await readFile(file, "utf8"), { name: "x", source: "bundled", file });
      if (!e.ok) throw new Error(`${file}: ${e.error}`);
      const names = e.workflow.steps.map((s) => s.name);
      const chain = names.map((_, i) => {
        const previous = names[i - 1];
        return previous === undefined ? [] : [previous];
      });
      expect(e.workflow.steps.map((s) => s.after)).toEqual(chain);
      expect(e.workflow.steps.every((s) => s.when.length === 1 && s.when[0] === "always" && s.mode === "auto")).toBe(true);
    }
  });
});

describe("readOnlyTools and readOnlyStep", () => {
  const t = (line: string) => {
    const e = parseWorkflow(`---\nblurb: b\n---\n\n## A\ntools: ${line}\n\na\n`, meta);
    if (!e.ok) throw new Error(e.error);
    const first = e.workflow.steps[0];
    if (!first) throw new Error("expected one step");
    return first.tools;
  };
  test("the read-only sets, and nothing else", () => {
    expect(readOnlyTools(t("git-read"))).toBe(true);
    expect(readOnlyTools(t("read"))).toBe(true);
    expect(readOnlyTools(t("git-read, read"))).toBe(true);
    expect(readOnlyTools(t("bun"))).toBe(false);
    expect(readOnlyTools(t("git-commit"))).toBe(false);
    expect(readOnlyTools(t("git-push"))).toBe(false);
    expect(readOnlyTools(t("read, Bash(ls:*)"))).toBe(false);
    expect(readOnlyTools(t("Edit"))).toBe(false);
  });
  test("a check that is not the gates line makes a step a writer", () => {
    expect(readOnlyStep({ tools: t("read"), check: null })).toBe(true);
    expect(readOnlyStep({ tools: t("read"), check: GATES_CHECK })).toBe(true);
    expect(readOnlyStep({ tools: t("read"), check: "bun test" })).toBe(false);
    expect(readOnlyStep({ tools: t("bun"), check: null })).toBe(false);
  });
});

test("chained fills the keys an old record lacks and leaves the rest", () => {
  const e = parseWorkflow(SHIP, meta);
  if (!e.ok) throw new Error(e.error);
  const old: RecordedWorkflow = { ...e.workflow, steps: e.workflow.steps.map(({ after: _after, when: _when, mode: _mode, ...step }) => step) };
  expect(chained(old)).toEqual(e.workflow);
  expect(chained(e.workflow)).toEqual(e.workflow);
});

describe("unattendedRefusal", () => {
  const e = parseWorkflow(SHIP, meta);
  if (!e.ok) throw new Error(e.error);
  const ship = e.workflow;
  test("names the first step that asks, or is manual, and who made it so", () => {
    expect(unattendedRefusal(ship, "a trigger's run")).toBe("ship's Push step asks before the next one starts, and no one answers a trigger's run");
    const manual: Workflow = { ...ship, steps: ship.steps.map((s) => (s.name === "Commit" ? { ...s, mode: "manual" } : s)) };
    expect(unattendedRefusal(manual, "an incubator stage")).toBe("ship's Commit step waits for a go, made manual by its workflow file, and no one gives one in an incubator stage");
    const repo: Workflow = { ...ship, steps: ship.steps.map((s) => (s.name === "Commit" ? { ...s, mode: "manual", modeFrom: "repo" } : s)) };
    expect(unattendedRefusal(repo, "a trigger's run")).toBe("ship's Commit step waits for a go, made manual by the repo's .canopy/workflows.json, and no one gives one in a trigger's run");
    const plain: Workflow = { ...ship, steps: ship.steps.map((s) => ({ ...s, gate: "continue" })) };
    expect(unattendedRefusal(plain, "a trigger's run")).toBeNull();
  });
});

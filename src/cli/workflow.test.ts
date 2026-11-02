import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowGraph } from "../core/flowgraph";
import type { Workflow, WorkflowEntry } from "../core/types";
import { parseWorkflow } from "../core/workflow";
import { checkLines, dotText, listLines, showLines, workflowCommand } from "./workflow";

const FAN_TEXT = `---
blurb: b
---

## Build
tools: git-commit

build

## Lint
after: Build
tools: read
gate: verdict

lint

## Docs
after: Build
tools: read
check: bun test
retries: 1
back: Build

docs

## Ship
after: Lint, Docs
when: verdict done, check pass
mode: manual

ship
`;

const fan = (): Workflow => {
  const e = parseWorkflow(FAN_TEXT, { name: "fan", source: "user", file: "/c/workflows/fan.md" });
  if (!e.ok) throw new Error(e.error);
  return e.workflow;
};

describe("showLines", () => {
  test("a line per step, indented by depth, with what it waits for, when, mode and gate", () => {
    expect(showLines(fan())).toEqual([
      "fan  user  /c/workflows/fan.md",
      "Build",
      "  Lint    after Build · gate verdict",
      "  Docs    after Build · check bun test · retries 1, back Build",
      "    Ship  after Lint, Docs · when verdict done, check pass · manual",
    ]);
  });

  test("the repo's modes are marked (repo), with its warnings and a broken file's refusal", () => {
    const wf = fan();
    const lines = showLines(wf, workflowGraph(wf, { ok: true, modes: { fan: { Ship: "auto", Gone: "manual" }, "*": { Build: "manual" } } }));
    expect(lines[1]).toBe("Build     manual (repo)");
    expect(lines[4]).toBe("    Ship  after Lint, Docs · when verdict done, check pass · auto (repo)");
    expect(lines[5]).toBe("warning: .canopy/workflows.json: modes.fan.Gone names no step of fan");
    const broken = showLines(wf, workflowGraph(wf, { ok: false, error: ".canopy/workflows.json must be an object" }));
    expect(broken.at(-1)).toBe("modes: .canopy/workflows.json must be an object; a flow of fan is refused until it is fixed");
  });
});

test("dotText: a box per step, after as arrows with the condition, back dashed", () => {
  const wf = fan();
  expect(dotText(wf, workflowGraph(wf, { ok: true, modes: { "*": { Build: "manual" } } }))).toBe(
    [
      'digraph "fan" {',
      "  rankdir=LR;",
      "  node [shape=box];",
      '  "Build" [label="Build\\nmanual (repo)", style=bold];',
      '  "Lint" [label="Lint\\ngate verdict"];',
      '  "Docs";',
      '  "Ship" [label="Ship\\nmanual", style=bold];',
      '  "Build" -> "Lint";',
      '  "Build" -> "Docs";',
      '  "Lint" -> "Ship" [label="when verdict done, check pass"];',
      '  "Docs" -> "Ship" [label="when verdict done, check pass"];',
      '  "Docs" -> "Build" [style=dashed, label="back"];',
      "}",
    ].join("\n"),
  );
  const odd = parseWorkflow('---\nblurb: b\n---\n\n## Say "hi" \\ go\n\nx\n', { name: "odd", source: "user", file: "/odd.md" });
  if (!odd.ok) throw new Error(odd.error);
  expect(dotText(odd.workflow)).toContain('  "Say \\"hi\\" \\\\ go";');
});

test("listLines: source and shape, the repo's say, problems under the entry, a broken file once", () => {
  const wf = fan();
  const chain = parseWorkflow("---\nblurb: b\n---\n\n## One\n\none\n", { name: "one", source: "bundled", file: "/one.md" });
  if (!chain.ok) throw new Error(chain.error);
  const entries: WorkflowEntry[] = [
    { ok: true, workflow: chain.workflow },
    { ok: true, workflow: wf, graph: workflowGraph(wf, { ok: true, modes: { fan: { Build: "manual", Gone: "auto" } } }) },
    { ok: false, name: "bad", source: "repo", file: "/r/.canopy/workflows/bad.md", error: "step Fix: after names no step called Nope" },
  ];
  expect(listLines("workflows for app", entries)).toEqual([
    "workflows for app",
    "  one  bundled  1 step",
    "  fan  user     4 steps as a graph, Ship manual, Build manual (repo)",
    "                warning: .canopy/workflows.json: modes.fan.Gone names no step of fan",
    "  bad  repo     does not parse: step Fix: after names no step called Nope",
  ]);
  const held: WorkflowEntry[] = [{ ok: true, workflow: wf, graph: workflowGraph(wf, { ok: false, error: "x is not JSON" }) }];
  expect(listLines("workflows for app", held).at(-1)).toBe("modes: x is not JSON; every flow on this repo is refused until it is fixed");
  expect(listLines("workflows for app", [])).toEqual(["workflows for app: no workflows"]);
});

test("checkLines: the steps when it parses, the error when it does not", () => {
  const ok = checkLines(parseWorkflow(FAN_TEXT, { name: "fan", source: "user", file: "/fan.md" }));
  expect(ok.ok).toBe(true);
  expect(ok.lines[0]).toBe("/fan.md: ok, 4 steps");
  expect(ok.lines[1]).toBe("Build");
  const bad = checkLines(parseWorkflow(FAN_TEXT.replace("after: Lint, Docs", "after: Lint, Nope"), { name: "fan", source: "user", file: "/fan.md" }));
  expect(bad).toEqual({ ok: false, lines: ["/fan.md: step Ship: after names no step called Nope"] });
});

describe("the command", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "canopy-workflow-cli-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** the command against a fake backend: what it printed, the paths it asked for, and the failure if it failed */
  async function drive(argv: string[], answers: Record<string, unknown> = {}) {
    const asked: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        asked.push(`${url.pathname}${url.search}`);
        return url.pathname in answers ? Response.json(answers[url.pathname]) : Response.json({ error: "not found" }, { status: 404 });
      },
    });
    const lines: string[] = [];
    const log = console.log;
    console.log = (s: string) => {
      lines.push(s);
    };
    let failed: string | null = null;
    try {
      await workflowCommand([...argv, "--backend", `http://127.0.0.1:${server.port}`], {
        fail: (m) => {
          throw new Error(m);
        },
      });
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    } finally {
      console.log = log;
      await server.stop(true);
    }
    return { lines, asked, failed };
  }

  test("check on a broken file fails with its error, and on a good one prints its steps", async () => {
    const bad = join(dir, "bad.md");
    await writeFile(bad, FAN_TEXT.replace("when: verdict done, check pass", "when: judge meets"));
    const got = await drive(["check", bad]);
    expect(got.failed).toBe(`${bad}: step Ship: when judge meets needs a step before it with gate: judge`);
    expect(got.asked).toEqual([]);
    const good = join(dir, "fan.md");
    await writeFile(good, FAN_TEXT);
    const fine = await drive(["check", good]);
    expect(fine.failed).toBeNull();
    expect(fine.lines[0]?.split("\n")[0]).toBe(`${good}: ok, 4 steps`);
    expect((await drive(["check", join(dir, "none.md")])).failed).toBe(`no such file: ${join(dir, "none.md")}`);
  });

  test("show --repo asks the backend for the repo's list and draws its graph", async () => {
    const wf = fan();
    const list: WorkflowEntry[] = [{ ok: true, workflow: wf, graph: workflowGraph(wf, { ok: true, modes: { fan: { Ship: "auto" } } }) }];
    const got = await drive(["show", "fan", "--repo", "web/app"], { "/api/repos/workflows": list });
    expect(got.failed).toBeNull();
    expect(got.asked).toEqual(["/api/repos/workflows?id=web%2Fapp"]);
    expect(got.lines[0]?.split("\n").at(-1)).toBe("    Ship  after Lint, Docs · when verdict done, check pass · auto (repo)");
    const dot = await drive(["show", "fan", "--repo", "web/app", "--dot"], { "/api/repos/workflows": list });
    expect(dot.lines[0]).toStartWith('digraph "fan" {');
    const missing = await drive(["show", "nope", "--repo", "web/app"], { "/api/repos/workflows": list });
    expect(missing.failed).toBe("no workflow called nope in the workflows for web/app");
  });

  test("list --repo prints the backend's entries; a bad word is the usage", async () => {
    const got = await drive(["list", "--repo", "app"], { "/api/repos/workflows": [{ ok: true, workflow: fan() }] });
    expect(got.lines).toEqual(["workflows for app\n  fan  user     4 steps as a graph, Ship manual"]);
    expect((await drive(["draw"])).failed).toStartWith("usage: canopy workflow show");
    expect((await drive(["list", "--repo"])).failed).toBe("--repo needs a repo id or a path");
  });
});

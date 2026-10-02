import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkflow, loadWorkflows } from "./workflows";
import { parseWorkflow } from "./workflow";
import { readFile } from "node:fs/promises";

let cfg = "";
let repo = "";
const savedCfg = process.env["CANOPY_CONFIG_DIR"];

beforeAll(async () => {
  cfg = await mkdtemp(join(tmpdir(), "canopy-wf-cfg-"));
  repo = await mkdtemp(join(tmpdir(), "canopy-wf-repo-"));
  process.env["CANOPY_CONFIG_DIR"] = cfg;
  await mkdir(join(cfg, "workflows"), { recursive: true });
  await mkdir(join(repo, ".canopy", "workflows"), { recursive: true });
  await writeFile(
    join(cfg, "workflows", "review.md"),
    `---\nblurb: my own review\n---\n\n## Look\n\nRead the diff.\n`,
  );
  await writeFile(
    join(cfg, "workflows", "broken.md"),
    `---\nname: broken\n---\n\n## Do\n\nx\n`,
  );
  await writeFile(
    join(repo, ".canopy", "workflows", "tidy.md"),
    `---\nblurb: tidy this repo\n---\n\n## Tidy\n\nTidy.\n`,
  );
});

afterAll(async () => {
  if (savedCfg === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = savedCfg;
  await rm(cfg, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("loadWorkflows", () => {
  test("bundled, then user, then repo, later winning by name; broken files stay listed", async () => {
    const list = await loadWorkflows({ path: repo });
    const names = list.map((e) => (e.ok ? e.workflow.name : e.name));
    expect(names).toEqual(["commit", "push", "ship", "deploy", "review", "clarify", "broken", "tidy"]);
    const review = findWorkflow(list, "review");
    expect(review?.source).toBe("user");
    expect(review?.blurb).toBe("my own review");
    expect(findWorkflow(list, "commit")?.source).toBe("bundled");
    expect(findWorkflow(list, "tidy")?.source).toBe("repo");
    const broken = list.find((e) => !e.ok);
    expect(broken && !broken.ok ? broken.error : "").toContain("blurb");
    expect(findWorkflow(list, "broken")).toBeUndefined();
  });

  test("a remote repo gets no repo-level files", async () => {
    const list = await loadWorkflows({ path: `ssh://box${repo}`, host: "box" });
    expect(list.some((e) => e.ok && e.workflow.name === "tidy")).toBe(false);
    expect(findWorkflow(list, "review")?.source).toBe("user");
  });

  test("every bundled workflow parses and has the expected shape", async () => {
    const list = await loadWorkflows({ path: "/nonexistent" });
    const ship = findWorkflow(list, "ship");
    expect(ship?.steps.map((s) => s.name)).toEqual(["Gates", "Commit", "Push"]);
    expect(ship?.steps[0]?.check).toContain("package.json");
    expect(ship?.when).toBe("dirty-or-unpushed");
    expect(findWorkflow(list, "commit")?.when).toBe("dirty");
    expect(findWorkflow(list, "commit")?.expectsChange).toBe(true);
    expect(findWorkflow(list, "push")?.when).toBe("unpushed");
    expect(findWorkflow(list, "deploy")?.when).toBe("any");
    expect(findWorkflow(list, "review")?.steps[0]?.tools).not.toContain("Bash(git commit:*)");
  });
});

describe("the bundled clarify", () => {
  test("the bundled clarify is the incubator's own: unlisted, budgeted, one step", async () => {
    const clarify = findWorkflow(await loadWorkflows({ path: "", host: "none" }), "clarify");
    expect(clarify?.listed).toBe(false);
    expect(clarify?.budget).toEqual({ runs: 2, hours: 0.34 });
    expect(clarify?.steps.map((s) => s.name)).toEqual(["Clarify"]);
    expect(clarify?.steps[0]?.tools).toEqual(expect.arrayContaining(["Edit", "Write", "WebFetch", "Bash(git status:*)"]));
  });

  test("its check passes a readable questions.json or none, refuses the rest, and gets one retry", async () => {
    const step = findWorkflow(await loadWorkflows({ path: "", host: "none" }), "clarify")?.steps[0];
    expect(step?.retries).toBe(1);
    const check = step?.check ?? "";
    expect(check).not.toBe("");
    const dir = await mkdtemp(join(tmpdir(), "canopy-clarify-check-"));
    try {
      await mkdir(join(dir, ".canopy"));
      const run = async (body: string | null): Promise<number> => {
        const file = join(dir, ".canopy", "questions.json");
        await rm(file, { force: true });
        if (body !== null) await writeFile(file, body);
        const p = Bun.spawn(["sh", "-c", check], { cwd: dir, stdout: "ignore", stderr: "ignore" });
        return await p.exited;
      };
      expect(await run(null)).toBe(0);
      expect(await run("[]")).toBe(0);
      expect(await run('[{"question":"which?","options":["a","b"]}]')).toBe(0);
      expect(await run('{"questions":[{"question":"which?"}]}')).toBe(0);
      expect(await run("not json")).toBe(1);
      expect(await run('[{"header":"no text"}]')).toBe(1);
      expect(await run('{"a":1}')).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the documented example", () => {
  test("docs/workflows/example-update-deps.md parses, with three steps", async () => {
    const file = join(import.meta.dir, "../../docs/workflows/example-update-deps.md");
    const e = parseWorkflow(await readFile(file, "utf8"), { name: "example-update-deps", source: "user", file });
    expect(e.ok ? "" : e.error).toBe("");
    if (!e.ok) return;
    expect(e.workflow.steps.map((s) => s.name)).toEqual(["Update", "Gates", "Commit"]);
  });
});

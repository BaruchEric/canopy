import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkflow, loadWorkflows } from "./workflows";

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
    expect(names).toEqual(["commit", "push", "ship", "deploy", "review", "broken", "tidy"]);
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
    expect(ship?.steps[0]?.check).toContain("bun run typecheck");
    expect(ship?.when).toBe("dirty-or-unpushed");
    expect(findWorkflow(list, "commit")?.when).toBe("dirty");
    expect(findWorkflow(list, "commit")?.expectsChange).toBe(true);
    expect(findWorkflow(list, "push")?.when).toBe("unpushed");
    expect(findWorkflow(list, "deploy")?.when).toBe("any");
    expect(findWorkflow(list, "review")?.steps[0]?.tools).not.toContain("Bash(git commit:*)");
  });
});

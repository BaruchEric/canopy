import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinCheck } from "./builtincheck";
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
    expect(names).toEqual(["commit", "push", "ship", "deploy", "review", "clarify", "scout", "build-new", "broken", "tidy"]);
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
    expect(check).toBe("@questions");
    const dir = await mkdtemp(join(tmpdir(), "canopy-clarify-check-"));
    try {
      await mkdir(join(dir, ".canopy"));
      const run = async (body: string | null): Promise<number> => {
        const file = join(dir, ".canopy", "questions.json");
        await rm(file, { force: true });
        if (body !== null) await writeFile(file, body);
        return (await builtinCheck(check, dir)).exit;
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

describe("the bundled scout", () => {
  test("unlisted, budgeted, research then a judged eval that rewinds to research", async () => {
    const scout = findWorkflow(await loadWorkflows({ path: "", host: "none" }), "scout");
    expect(scout?.listed).toBe(false);
    expect(scout?.budget).toEqual({ runs: 8, hours: 1 });
    expect(scout?.steps.map((s) => s.name)).toEqual(["Research", "Eval"]);
    const [research, evalStep] = scout?.steps ?? [];
    expect(research?.check).toBe("@pick-check");
    expect(research?.retries).toBe(2);
    expect(evalStep?.gate).toBe("judge");
    expect(evalStep?.back).toBe("Research");
    expect(evalStep?.retries).toBe(2);
    expect(evalStep?.evidence).toEqual([".canopy/intent.md", ".canopy/research.md", ".canopy/pick.json", ".canopy/eval.md"]);
  });

  test("no step may read the whole disk, call gh api, clone, push or touch vercel", async () => {
    const scout = findWorkflow(await loadWorkflows({ path: "", host: "none" }), "scout");
    const tools = (scout?.steps ?? []).flatMap((s) => s.tools);
    expect(tools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
    expect(tools.some((t) => t.startsWith("Bash("))).toBe(false);
    for (const banned of ["Read", "Glob", "Grep", "Bash(gh api:*)", "Bash(git clone:*)", "Bash(git push:*)"]) expect(tools).not.toContain(banned);
    expect(tools.some((t) => /vercel|gh repo create|gh repo fork/.test(t))).toBe(false);
  });
});

describe("the bundled build-new", () => {
  const load = async () => findWorkflow(await loadWorkflows({ path: "", host: "none" }), "build-new");

  test("scaffold, test, then a judged accept that rewinds to scaffold", async () => {
    const wf = await load();
    expect(wf?.listed).toBe(false);
    expect(wf?.budget).toEqual({ runs: 30, hours: 6 });
    expect(wf?.steps.map((s) => s.name)).toEqual(["Scaffold", "Test", "Accept"]);
    const accept = wf?.steps[2];
    expect(accept?.gate).toBe("judge");
    expect(accept?.back).toBe("Scaffold");
    expect(accept?.evidence).toEqual([".canopy/intent.md", ".canopy/pick.json", ".canopy/smoke.md", ".canopy/accept.md", "README.md"]);
  });

  test("no step holds push, gh, vercel or a whole-disk read", async () => {
    const tools = ((await load())?.steps ?? []).flatMap((s) => s.tools);
    expect(tools).toEqual(expect.arrayContaining(["Bash(git commit:*)", "Bash(bun run:*)", "Bash(bun add:*)", "Bash(curl:*)"]));
    for (const banned of ["Read", "Bash(git push:*)", "Bash(gh api:*)"]) expect(tools).not.toContain(banned);
    expect(tools.some((t) => /vercel|^Bash\(gh /.test(t))).toBe(false);
  });

  test("scaffold's check refuses a gitignore gap, a missing script, an uncommitted lock and a dirty tree", async () => {
    const check = (await load())?.steps[0]?.check ?? "";
    const dir = await mkdtemp(join(tmpdir(), "canopy-build-check-"));
    const sh = async (cmd: string): Promise<{ code: number; out: string }> => {
      const p = Bun.spawn(["sh", "-c", cmd], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out: o + e };
    };
    try {
      await sh("git init -q && git config user.email t@t && git config user.name t && mkdir .canopy && echo x > .canopy/brief.md");
      await writeFile(join(dir, ".gitignore"), "node_modules\n");
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "true", build: "true" } }));
      expect((await sh(check)).out).toContain(".gitignore must cover .vercel");
      await writeFile(join(dir, ".gitignore"), "node_modules\ndist\n.vercel\n.env*\n");
      // bun deletes an empty lockfile, so give it one offline dependency to lock
      await mkdir(join(dir, "dep"));
      await writeFile(join(dir, "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "true", build: "true" }, dependencies: { dep: "file:./dep" } }));
      await sh("bun install >/dev/null 2>&1");
      expect((await sh(check)).out).toContain("bun.lock is not committed");
      await sh("git add -A && git commit -qm init");
      expect((await sh(check)).code).toBe(0);
      await writeFile(join(dir, "stray.ts"), "export {};\n");
      const dirty = await sh(check);
      expect(dirty.code).toBe(1);
      expect(dirty.out).toContain("the working tree is not clean");
      await rm(join(dir, "stray.ts"));
      // .canopy/ is canopy's: what it holds uncommitted never fails the check
      await writeFile(join(dir, ".canopy", "questions.json"), "[]");
      expect((await sh(check)).code).toBe(0);
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { build: "true" } }));
      await sh("git commit -qam nodev");
      expect((await sh(check)).out).toContain("package.json needs a dev script");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("test's check wants a 2xx status in smoke.md", async () => {
    const check = (await load())?.steps[1]?.check ?? "";
    expect(check).toContain("^status: 2");
  });
});

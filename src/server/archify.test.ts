import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHIFY_VERSION } from "../core/archify";
import { exec } from "../core/exec";
import { ARCHIFY_IGNORE, ARCHIFY_PLUGIN, ARCHIFY_SKILL, ArchifyError, archifyEnv, diagramPage, hasOrigin, keepOutOfGit, listDiagrams, removeDiagram } from "./archify";
import { floorplanNode } from "./floorplan";

// A checkout with one diagram drawn by canopy's own copy of Archify from
// the skill's own example, in place of the model's candidate: the real
// finalize, its real receipts, no claude. ARCHIFY_CHROME points nowhere so
// the browser check is skipped the same way on a Mac with Chrome and in a
// container without it, as on the mini.
let root = "";
const FOLDER = "architecture-web-app-20261121-090000";
const git = (...args: string[]) => exec(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root });

async function finalize(folder: string, extra: Record<string, string> = {}) {
  const dir = join(root, ".archify", folder);
  mkdirSync(dir, { recursive: true });
  cpSync(join(ARCHIFY_SKILL, "examples", "web-app.architecture.json"), join(dir, "candidate.json"));
  const node = floorplanNode();
  return exec([node, join(ARCHIFY_SKILL, "bin", "archify.mjs"), "finalize", "architecture", `.archify/${folder}/candidate.json`, `.archify/${folder}/web-app.html`, "--quality", "showcase", "--json"], {
    cwd: root,
    timeoutMs: 120_000,
    env: { ...archifyEnv(node), ARCHIFY_CHROME: "/nonexistent/chrome", ...extra },
  });
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "canopy-archify-")));
  writeFileSync(join(root, "README.md"), "# shop\n");
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-qm", "init");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the vendored copy's versions agree, and the plugin is where the run loads it", () => {
  const plugin = JSON.parse(readFileSync(join(ARCHIFY_PLUGIN, ".claude-plugin", "plugin.json"), "utf8")) as { name: string; version: string };
  const pkg = JSON.parse(readFileSync(join(ARCHIFY_SKILL, "package.json"), "utf8")) as { version: string };
  const release = JSON.parse(readFileSync(join(ARCHIFY_SKILL, "skill-release.json"), "utf8")) as { version: string };
  expect(plugin.name).toBe("archify");
  expect(plugin.version).toBe(ARCHIFY_VERSION);
  expect(pkg.version).toBe(ARCHIFY_VERSION);
  expect(release.version).toBe(ARCHIFY_VERSION);
  expect(readFileSync(join(ARCHIFY_PLUGIN, "VENDOR.md"), "utf8")).toContain(`at **${ARCHIFY_VERSION}**, commit `);
  expect(existsSync(join(ARCHIFY_SKILL, "SKILL.md"))).toBe(true);
  expect(existsSync(join(ARCHIFY_SKILL, "LICENSE"))).toBe(true);
});

test("a run's env turns Archify's update check off and puts node first", () => {
  const env = archifyEnv("/opt/x/bin/node");
  expect(env["ARCHIFY_UPDATE_CHECK_DISABLED"]).toBe("1");
  expect(env["PATH"]?.split(":")[0]).toBe("/opt/x/bin");
});

describe("a checkout's diagrams, through the real finalize", () => {
  test("no .archify is no diagrams", async () => {
    expect(await listDiagrams(root)).toEqual([]);
    expect(() => diagramPage(root, FOLDER)).toThrow(ArchifyError);
  });

  test("keepOutOfGit writes the folder's own .gitignore, so a run leaves git status clean", async () => {
    await keepOutOfGit(root);
    expect(readFileSync(join(root, ".archify", ".gitignore"), "utf8")).toBe(ARCHIFY_IGNORE);
    const r = await finalize(FOLDER);
    // exit 2: delivered and checked, the browser check skipped for want of Chrome
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as { gates: Record<string, string> }).gates).toMatchObject({ deliver: "pass", check: "pass", "browser-check": "skipped" });
    expect((await git("status", "--porcelain")).stdout.trim()).toBe("");
  }, 120_000);

  test("the list reads the page, its title and finalize's verdict", async () => {
    const [d, ...rest] = await listDiagrams(root);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ id: FOLDER, file: "web-app.html", title: "Sample Web App Diagram", type: "architecture", checks: "browser-skipped" });
    expect(d?.bytes).toBeGreaterThan(100_000);
    expect(d?.tracked).toBeUndefined();
    const page = diagramPage(root, FOLDER);
    expect(page.file).toBe("web-app.html");
    expect(readFileSync(page.path, "utf8")).toContain(`<meta name="generator" content="archify ${ARCHIFY_VERSION}">`);
  });

  test("a folder with no receipt still lists, typed by its name; one with no page does not", async () => {
    mkdirSync(join(root, ".archify", "sequence-login-20261121-090100"), { recursive: true });
    writeFileSync(join(root, ".archify", "sequence-login-20261121-090100", "login.html"), "<title>Login</title>");
    mkdirSync(join(root, ".archify", "workflow-empty-20261121-090200"), { recursive: true });
    const list = await listDiagrams(root);
    const login = list.find((d) => d.id === "sequence-login-20261121-090100");
    expect(login).toMatchObject({ title: "Login", type: "sequence", checks: null });
    expect(list.some((d) => d.id === "workflow-empty-20261121-090200")).toBe(false);
    expect(list[0]?.id).toBe("sequence-login-20261121-090100");
  });

  test("links and odd names are never followed or listed", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "canopy-archify-out-")));
    try {
      writeFileSync(join(outside, "secret.html"), "<title>secret</title>");
      symlinkSync(outside, join(root, ".archify", "tree-linked-20261121-090300"));
      mkdirSync(join(root, ".archify", "class-links-20261121-090400"));
      symlinkSync(join(outside, "secret.html"), join(root, ".archify", "class-links-20261121-090400", "page.html"));
      mkdirSync(join(root, ".archify", "odd name"));
      writeFileSync(join(root, ".archify", "odd name", "x.html"), "<title>x</title>");
      const ids = (await listDiagrams(root)).map((d) => d.id);
      expect(ids).not.toContain("tree-linked-20261121-090300");
      expect(ids).not.toContain("class-links-20261121-090400");
      expect(ids).not.toContain("odd name");
      for (const id of ["tree-linked-20261121-090300", "class-links-20261121-090400", "../..", "a/b", ""]) expect(() => diagramPage(root, id)).toThrow(ArchifyError);
      await expect(removeDiagram(root, "tree-linked-20261121-090300")).rejects.toThrow(ArchifyError);
      expect(existsSync(join(outside, "secret.html"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a remove takes the folder; a folder the repo tracks is refused", async () => {
    await removeDiagram(root, "sequence-login-20261121-090100");
    expect(existsSync(join(root, ".archify", "sequence-login-20261121-090100"))).toBe(false);
    await git("add", "-f", `.archify/${FOLDER}/candidate.json`);
    await git("commit", "-qm", "commit a diagram");
    expect((await listDiagrams(root)).find((d) => d.id === FOLDER)?.tracked).toBe(true);
    await expect(removeDiagram(root, FOLDER)).rejects.toThrow("remove it with git");
    expect(existsSync(join(root, ".archify", FOLDER))).toBe(true);
  });
});

describe("keepOutOfGit leaves a repo's own choice alone", () => {
  test("a repo that tracks .archify gets no .gitignore", async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "canopy-archify-tracked-")));
    try {
      mkdirSync(join(other, ".archify", "x"), { recursive: true });
      writeFileSync(join(other, ".archify", "x", "candidate.json"), "{}");
      const g = (...args: string[]) => exec(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: other });
      await g("init", "-q");
      await g("add", "-A");
      await g("commit", "-qm", "init");
      await keepOutOfGit(other);
      expect(existsSync(join(other, ".archify", ".gitignore"))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a checkout's origin remote is seen, and its absence", async () => {
    expect(await hasOrigin(root)).toBe(false);
    await git("remote", "add", "origin", "https://github.com/example/shop.git");
    try {
      expect(await hasOrigin(root)).toBe(true);
    } finally {
      await git("remote", "remove", "origin");
    }
  });

  test("an .archify that is a link or a file is refused", async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "canopy-archify-link-")));
    try {
      await exec(["git", "init", "-q"], { cwd: other });
      symlinkSync(tmpdir(), join(other, ".archify"));
      await expect(keepOutOfGit(other)).rejects.toThrow("is a link");
      rmSync(join(other, ".archify"));
      writeFileSync(join(other, ".archify"), "x");
      await expect(keepOutOfGit(other)).rejects.toThrow("is a file");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

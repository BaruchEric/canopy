import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_MENTIONS, enabledPlugins, firstLine, frontmatter, mentionsOf, parseScan, scanMentions, sortMentions } from "./mentions";

describe("frontmatter", () => {
  test("plain, quoted and folded values", () => {
    expect(frontmatter('---\nname: "cli-anything-ripe"\ndescription: Drive ripe\n---\n# body')).toEqual({ name: "cli-anything-ripe", description: "Drive ripe" });
    expect(frontmatter("---\nname: app-video\ndescription: >-\n  Turns one of Eric's apps into\n  a video\nallowed-tools: Bash\n---\n")).toEqual({ name: "app-video", description: "Turns one of Eric's apps into a video" });
    expect(frontmatter("---\ndescription: |\n  one\n  two\n---\n")).toEqual({ name: null, description: "one two" });
  });
  test("no frontmatter, or one that never closes", () => {
    expect(frontmatter("# just a command\n")).toEqual({ name: null, description: null });
    expect(frontmatter("---\ndescription: open\n")).toEqual({ name: null, description: "open" });
  });
});

describe("firstLine", () => {
  test("the first line of text past the frontmatter, headings skipped, long ones cut", () => {
    expect(firstLine("---\nmodel: haiku\n---\n\n# Commit\n\nLet's commit the changes.\n")).toBe("Let's commit the changes.");
    expect(firstLine("Reply with PINEAPPLE.\n")).toBe("Reply with PINEAPPLE.");
    expect(firstLine("x".repeat(200))).toHaveLength(120);
    expect(firstLine("---\nopen\n")).toBe("");
  });
});

describe("parseScan and mentionsOf", () => {
  const out = [
    "command\nuser\ncommit\n---\ndescription: Commit it\n---\nbody",
    "command\nuser\nfrontend/component\nMake a component.",
    "skill\nuser\nripe\n---\nname: cli-anything-ripe\ndescription: Drive ripe\n---\n",
    "skill\nproject\nredeploy\n---\nname: redeploy\ndescription: Redeploy the mini\n---\n",
    "skill\ncodex-user\nbuzz\n---\ndescription: Buzz\n---\n",
    "command\nplugin:vercel\ndeploy\n---\ndescription: Deploy\n---\n",
    "skill\nplugin:superpowers\nbrainstorming\n---\nname: brainstorming\ndescription: Think first\n---\n",
    "plugins\n-\n-\n{}",
    "garbage",
    "",
  ].join("\0");
  test("one record per NUL-ended block, three header lines then the head", () => {
    const records = parseScan(out);
    expect(records).toHaveLength(8);
    expect(records[0]).toEqual({ kind: "command", from: "user", name: "commit", head: "---\ndescription: Commit it\n---\nbody" });
    expect(records[7]).toEqual({ kind: "plugins", from: "-", name: "-", head: "{}" });
  });
  test("names, sources, aliases and descriptions as the agents show them", () => {
    const words = mentionsOf(parseScan(out));
    expect(words).toEqual([
      { name: "commit", kind: "command", harness: "claude", from: "user", description: "Commit it" },
      { name: "component", kind: "command", harness: "claude", from: "user:frontend", description: "Make a component." },
      { name: "ripe", kind: "skill", harness: "claude", from: "user", description: "Drive ripe", alias: "cli-anything-ripe" },
      { name: "redeploy", kind: "skill", harness: "claude", from: "project", description: "Redeploy the mini" },
      { name: "buzz", kind: "skill", harness: "codex", from: "user", description: "Buzz" },
      { name: "vercel:deploy", kind: "command", harness: "claude", from: "plugin:vercel", description: "Deploy" },
      { name: "superpowers:brainstorming", kind: "skill", harness: "claude", from: "plugin:superpowers", description: "Think first" },
    ]);
  });
  test("sorts the repo's own first, then the user's, the CLI's, the plugins'", () => {
    const names = sortMentions([...mentionsOf(parseScan(out)), ...BUILTIN_MENTIONS]).map((w) => `${w.from} ${w.name}`);
    expect(names.slice(0, 2)).toEqual(["project redeploy", "user buzz"]);
    expect(names.indexOf("builtin compact")).toBeLessThan(names.indexOf("plugin:superpowers superpowers:brainstorming"));
    expect(names.indexOf("user ripe")).toBeLessThan(names.indexOf("builtin clear"));
  });
  test("one row per name for an agent: the repo's over the user's, each agent's own", () => {
    const twice = parseScan(["skill\nuser\ndesk\n---\ndescription: Mail\n---\n", "command\nuser\ndesk\nMail", "skill\nproject\ndesk\n---\ndescription: This repo's\n---\n", "skill\ncodex-user\ndesk\n---\ndescription: Codex's\n---\n"].join("\0"));
    const rows = sortMentions(mentionsOf(twice)).map((w) => `${w.harness} ${w.from} ${w.name}: ${w.description}`);
    expect(rows).toEqual(["claude project desk: This repo's", "codex user desk: Codex's"]);
  });
});

describe("enabledPlugins", () => {
  const manifest = JSON.stringify({
    version: 2,
    plugins: {
      "vercel@official": [{ scope: "user", installPath: "/p/vercel/1" }],
      "telegram@official": [{ scope: "user", installPath: "/p/telegram/1" }],
      "ctx@ctx": [{ scope: "user", installPath: "/p/ctx/1" }],
      "broken@x": [{ scope: "user" }],
    },
    enabledPlugins: { "ctx@ctx": false },
  });
  test("the settings switch wins, then the manifest's, else on", () => {
    expect(enabledPlugins(manifest, JSON.stringify({ enabledPlugins: { "telegram@official": false, "ctx@ctx": true } }))).toEqual([
      { name: "vercel", path: "/p/vercel/1" },
      { name: "ctx", path: "/p/ctx/1" },
    ]);
    expect(enabledPlugins(manifest, "")).toEqual([
      { name: "vercel", path: "/p/vercel/1" },
      { name: "telegram", path: "/p/telegram/1" },
    ]);
    expect(enabledPlugins("not json", "{")).toEqual([]);
  });
});

describe("scanMentions", () => {
  let scratch: string;
  let home: string;
  let repo: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "canopy-mentions-"));
    home = join(scratch, "home");
    repo = join(scratch, "repo");
    const plugin = join(scratch, "plugins", "vercel");
    const off = join(scratch, "plugins", "telegram");
    const linked = join(scratch, "elsewhere", "ripe");
    for (const d of [
      join(home, ".claude", "commands", "frontend"),
      join(home, ".claude", "skills", "desk"),
      join(home, ".codex", "skills", "buzz"),
      join(repo, ".claude", "skills", "redeploy"),
      join(repo, ".claude", "skills", "empty"),
      join(plugin, "commands"),
      join(plugin, "skills", "eve"),
      join(off, "skills", "chat"),
      linked,
    ]) {
      await mkdir(d, { recursive: true });
    }
    await writeFile(join(home, ".claude", "commands", "commit.md"), "---\ndescription: Commit it\n---\nCommit.\n");
    await writeFile(join(home, ".claude", "commands", "frontend", "component.md"), "Make a component.\n");
    await writeFile(join(home, ".claude", "skills", "desk", "SKILL.md"), "---\nname: desk\ndescription: >-\n  Triage the\n  mail\n---\n");
    await writeFile(join(linked, "SKILL.md"), '---\nname: "cli-anything-ripe"\ndescription: Drive ripe\n---\n');
    await symlink(linked, join(home, ".claude", "skills", "ripe"));
    await writeFile(join(home, ".codex", "skills", "buzz", "SKILL.md"), "---\ndescription: Buzz\n---\n");
    await writeFile(join(repo, ".claude", "skills", "redeploy", "SKILL.md"), "---\nname: redeploy\ndescription: Redeploy the mini\n---\n");
    await writeFile(join(plugin, "commands", "deploy.md"), "---\ndescription: Deploy\n---\n");
    await writeFile(join(plugin, "skills", "eve", "SKILL.md"), "---\nname: eve\ndescription: Eve\n---\n");
    await writeFile(join(off, "skills", "chat", "SKILL.md"), "---\nname: chat\ndescription: Off\n---\n");
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "vercel@official": [{ installPath: plugin }], "telegram@official": [{ installPath: off }] } }),
    );
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "telegram@official": false } }));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("reads the user's, the repo's, the enabled plugins' and the CLI's, through links", async () => {
    const words = await scanMentions(repo, home);
    const by = Object.fromEntries(words.map((w) => [`${w.harness} ${w.name}`, w]));
    expect(by["claude commit"]).toMatchObject({ kind: "command", from: "user", description: "Commit it" });
    expect(by["claude component"]).toMatchObject({ kind: "command", from: "user:frontend", description: "Make a component." });
    expect(by["claude desk"]).toMatchObject({ kind: "skill", from: "user", description: "Triage the mail" });
    expect(by["claude ripe"]).toMatchObject({ kind: "skill", from: "user", alias: "cli-anything-ripe" });
    expect(by["claude redeploy"]).toMatchObject({ kind: "skill", from: "project" });
    expect(by["codex buzz"]).toMatchObject({ kind: "skill", from: "user", description: "Buzz" });
    expect(by["claude vercel:deploy"]).toMatchObject({ kind: "command", from: "plugin:vercel" });
    expect(by["claude vercel:eve"]).toMatchObject({ kind: "skill", from: "plugin:vercel" });
    expect(by["claude compact"]).toMatchObject({ kind: "builtin" });
    expect(by["claude telegram:chat"]).toBeUndefined();
    expect(by["claude empty"]).toBeUndefined();
    expect(words[0]?.name).toBe("redeploy");
  });

  test("a repo that is not there", async () => {
    await expect(scanMentions(join(scratch, "nope"), home)).rejects.toMatchObject({ status: 404 });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./exec";
import { commitSeed, makeSeed, readSeed, seedOps, seedWorkPath, writeSeed } from "./seed";
import { setSeedBusy, setSeedRoots } from "./seedgit";

let dir: string;
/** the sprout every seed here is made for */
const SP = "sp_0123456789ab";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-seed-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const log = async (path: string) => (await git(path, ["log", "--format=%an <%ae>|%s"])).stdout.trim().split("\n");

/** an upstream repo with one commit by "u", holding the given files */
async function upstream(name: string, files: Record<string, string>, links: Record<string, string> = {}): Promise<string> {
  const up = join(dir, name);
  await mkdir(up);
  await git(up, ["init", "-q", "-b", "main"]);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(up, rel, ".."), { recursive: true });
    await writeFile(join(up, rel), text);
  }
  for (const [rel, target] of Object.entries(links)) await symlink(target, join(up, rel));
  // -f: the user's global ignore may name .mcp.json or settings.local.json
  await git(up, ["add", "-f", "--", ...Object.keys(files), ...Object.keys(links)]);
  await git(up, ["-c", "user.name=u", "-c", "user.email=u@x", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "first"]);
  return up;
}

describe("makeSeed", () => {
  test("a new idea is a fresh repo on main with the files in one canopy commit", async () => {
    const path = join(dir, "_incubator", "idea");
    await makeSeed(path, { ".canopy/brief.md": "# Idea\n", ".canopy/inputs.md": "# Inputs\n" }, undefined, { self: "mini", id: SP });
    expect(await readFile(join(path, ".canopy", "brief.md"), "utf8")).toBe("# Idea\n");
    expect((await git(path, ["branch", "--show-current"])).stdout.trim()).toBe("main");
    expect(await log(path)).toEqual(["canopy <canopy@mini>|seed: a new project from the incubator"]);
  });
  test("a folder that is there already is refused", async () => {
    const path = join(dir, "taken");
    await mkdir(path);
    await expect(makeSeed(path, {}, undefined, { self: "mini", id: SP })).rejects.toThrow("is there already");
  });
  test("a local path is never cloned", async () => {
    await expect(makeSeed(join(dir, "c1"), {}, "/etc", { self: "mini", id: SP })).rejects.toThrow("not a network git url");
  });
  test("a clone keeps its history, calls its remote upstream, and gets the files on top", async () => {
    const up = await upstream("upstream", { "README.md": "hi\n" });
    const path = join(dir, "_incubator", "cloned");
    await makeSeed(path, { ".canopy/brief.md": "# C\n" }, up, { self: "mini", id: SP, originOk: () => true });
    expect((await git(path, ["remote"])).stdout.trim()).toBe("upstream");
    expect(await log(path)).toEqual(["canopy <canopy@mini>|seed: a new project from the incubator", "u <u@x>|first"]);
  });
  test("a clone loses the project's claude and mcp settings in a commit of its own, before anything runs", async () => {
    const up = await upstream("risky", {
      "README.md": "hi\n",
      ".claude/settings.json": '{"hooks":{}}\n',
      ".claude/settings.local.json": '{"permissions":{"allow":["Bash"]}}\n',
      ".claude/commands/x.md": "a command\n",
      ".mcp.json": '{"mcpServers":{}}\n',
    });
    const path = join(dir, "_incubator", "risky");
    await makeSeed(path, { ".canopy/brief.md": "# R\n" }, up, { self: "mini", id: SP, originOk: () => true });
    expect(existsSync(join(path, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(path, ".claude", "settings.local.json"))).toBe(false);
    expect(existsSync(join(path, ".mcp.json"))).toBe(false);
    expect(await readFile(join(path, ".claude", "commands", "x.md"), "utf8")).toBe("a command\n");
    expect(await readFile(join(path, ".canopy", "brief.md"), "utf8")).toBe("# R\n");
    const lines = await log(path);
    expect(lines[0]).toBe("canopy <canopy@mini>|seed: drop the cloned project's agent settings");
    expect(lines.slice(1)).toEqual(["canopy <canopy@mini>|seed: a new project from the incubator", "u <u@x>|first"]);
    const removed = (await git(path, ["show", "--name-status", "--format=", "HEAD"])).stdout.trim().split("\n").sort();
    expect(removed).toEqual(["D\t.claude/settings.json", "D\t.claude/settings.local.json", "D\t.mcp.json"]);
    expect((await git(path, ["status", "--porcelain"])).stdout).toBe("");
  });
  test("settings tracked under other letter cases go too, and the removal is committed", async () => {
    const up = await upstream("cased", {
      "README.md": "hi\n",
      ".Claude/settings.json": '{"hooks":{}}\n',
      ".Claude/commands/x.md": "a command\n",
      ".MCP.json": '{"mcpServers":{}}\n',
    });
    const path = join(dir, "_incubator", "cased");
    await makeSeed(path, {}, up, { self: "mini", id: SP, originOk: () => true });
    expect((await log(path))[0]).toBe("canopy <canopy@mini>|seed: drop the cloned project's agent settings");
    const tracked = (await git(path, ["ls-files"])).stdout.trim().split("\n").sort();
    expect(tracked).toEqual([".Claude/commands/x.md", "README.md"]);
    expect(existsSync(join(path, ".Claude", "settings.json"))).toBe(false);
    expect(existsSync(join(path, ".MCP.json"))).toBe(false);
    expect((await git(path, ["status", "--porcelain"])).stdout).toBe("");
  });
  test("a clone whose .claude is a symlink loses the link itself", async () => {
    const up = await upstream("linked-claude", { "README.md": "hi\n", "conf/settings.json": '{"hooks":{}}\n' }, { ".claude": "conf" });
    const path = join(dir, "_incubator", "linked-claude");
    await makeSeed(path, {}, up, { self: "mini", id: SP, originOk: () => true });
    expect(existsSync(join(path, ".claude"))).toBe(false);
    expect((await log(path))[0]).toBe("canopy <canopy@mini>|seed: drop the cloned project's agent settings");
    expect((await git(path, ["status", "--porcelain"])).stdout).toBe("");
  });
  test("a clone that carries its own .canopy symlink is refused, and the clean-up takes the link, not what it points at", async () => {
    const outside = join(dir, "clone-target");
    await mkdir(outside);
    await writeFile(join(outside, "brief.md"), "theirs\n");
    const up = await upstream("canopy-link", { "README.md": "hi\n" }, { ".canopy": outside });
    const path = join(dir, "_incubator", "canopy-link");
    await expect(makeSeed(path, { ".canopy/brief.md": "# L\n" }, up, { self: "mini", id: SP, originOk: () => true })).rejects.toThrow("symlink");
    expect(existsSync(path)).toBe(false);
    expect(await readdir(outside)).toEqual(["brief.md"]);
    expect(await readFile(join(outside, "brief.md"), "utf8")).toBe("theirs\n");
  });
  test("a clone that fails leaves no folder behind", async () => {
    const path = join(dir, "_incubator", "nothing");
    await expect(makeSeed(path, {}, join(dir, "no-such-repo"), { self: "mini", id: SP, originOk: () => true })).rejects.toThrow("git clone failed");
    expect(existsSync(path)).toBe(false);
  });
});

describe("makeSeed builds aside", () => {
  test("a half-made seed an earlier attempt left is cleared, and the seed is made", async () => {
    const path = join(dir, "_incubator", "leftover");
    const work = seedWorkPath(path, SP);
    // outside the seeds folder, which the stages container mounts, on the same disk
    expect(work).toBe(join(dir, ".canopy-making", `leftover.${SP}`));
    // what a restart in the middle of a clone leaves: a .git and some files, no canopy commit
    await mkdir(join(work, ".git"), { recursive: true });
    await writeFile(join(work, "half.txt"), "half\n");
    await makeSeed(path, { ".canopy/brief.md": "# L\n" }, undefined, { self: "mini", id: SP });
    expect(existsSync(work)).toBe(false);
    expect(existsSync(join(path, "half.txt"))).toBe(false);
    expect(await log(path)).toEqual(["canopy <canopy@mini>|seed: a new project from the incubator"]);
  });
  test("the seed folder appears only once the clone is whole and its settings are gone", async () => {
    const up = await upstream("whole", { "README.md": "hi\n", ".claude/settings.json": '{"hooks":{}}\n' });
    const path = join(dir, "_incubator", "whole");
    const seen: string[] = [];
    let watching = true;
    const watch = (async () => {
      while (watching) {
        if (existsSync(path)) seen.push(existsSync(join(path, ".claude")) ? "settings" : existsSync(join(path, ".canopy", "brief.md")) ? "whole" : "partial");
        await Bun.sleep(1);
      }
    })();
    await makeSeed(path, { ".canopy/brief.md": "# W\n" }, up, { self: "mini", id: SP, originOk: () => true });
    watching = false;
    await watch;
    expect(seen.every((x) => x === "whole")).toBe(true);
    expect((await log(path))[0]).toBe("canopy <canopy@mini>|seed: drop the cloned project's agent settings");
    expect(existsSync(seedWorkPath(path, SP))).toBe(false);
  });
  test("an attempt for another sprout on the same slug leaves this one's work folder alone", async () => {
    const path = join(dir, "_incubator", "shared-slug");
    const other = "sp_00000000000a";
    expect(seedWorkPath(path, other)).not.toBe(seedWorkPath(path, SP));
    // a dismissed sprout's clone still under way, as a new intake on the slug starts
    const theirs = seedWorkPath(path, other);
    await mkdir(join(theirs, ".git"), { recursive: true });
    await writeFile(join(theirs, "cloning.txt"), "mid-clone\n");
    await makeSeed(path, { ".canopy/brief.md": "# S\n" }, undefined, { self: "mini", id: SP });
    expect(await readFile(join(theirs, "cloning.txt"), "utf8")).toBe("mid-clone\n");
    expect(await log(path)).toEqual(["canopy <canopy@mini>|seed: a new project from the incubator"]);
  });
  test("an id that is not a sprout's is refused before anything is made", async () => {
    const path = join(dir, "_incubator", "bad-id");
    await expect(makeSeed(path, {}, undefined, { self: "mini", id: "../x" })).rejects.toThrow("not a sprout id");
    expect(existsSync(path)).toBe(false);
  });
  test("a clone refused after it landed leaves neither the seed nor the folder it was built in", async () => {
    const outside = join(dir, "aside-target");
    await mkdir(outside);
    const up = await upstream("aside-link", { "README.md": "hi\n" }, { ".canopy": outside });
    const path = join(dir, "_incubator", "aside-link");
    await expect(makeSeed(path, { ".canopy/brief.md": "# A\n" }, up, { self: "mini", id: SP, originOk: () => true })).rejects.toThrow("symlink");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(seedWorkPath(path, SP))).toBe(false);
  });
});

describe("a stranger's clone", () => {
  test("canopy's commits pass an ignored .canopy and a hook that would refuse, and run no hook at all", async () => {
    const up = await upstream("hooked", { "README.md": "hi\n", ".gitignore": ".*\n" });
    const path = join(dir, "_incubator", "hooked");
    await makeSeed(path, { ".canopy/brief.md": "# H\n" }, up, { self: "mini", id: SP, originOk: () => true });
    // hooks a clone could not carry, planted as the agent could
    const marker = join(dir, "hook-ran");
    await writeFile(join(path, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(join(path, ".git", "hooks", "post-commit"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await writeFile(join(path, ".canopy", "intent.md"), "want\n");
    expect(await commitSeed(path, [".canopy/intent.md"], "clarify: H", "mini")).toBe(true);
    expect((await log(path))[0]).toBe("canopy <canopy@mini>|clarify: H");
    expect(existsSync(marker)).toBe(false);
    expect((await git(path, ["ls-files", ".canopy"])).stdout.trim().split("\n").sort()).toEqual([".canopy/brief.md", ".canopy/intent.md"]);
  });
  test("canopy's git calls never run an fsmonitor the seed's own config names", async () => {
    const path = join(dir, "_incubator", "fsmon");
    await makeSeed(path, { ".canopy/brief.md": "# F\n" }, undefined, { self: "mini", id: SP });
    // planted as the agent could: a hook script git would run to refresh the index
    const marker = join(dir, "fsmonitor-ran");
    const script = join(dir, "fsmonitor.sh");
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    await git(path, ["config", "core.fsmonitor", script]);
    // proof the planted hook is live for a plain git call
    await git(path, ["status", "--porcelain"]);
    expect(existsSync(marker)).toBe(true);
    await rm(marker);
    await writeFile(join(path, ".canopy", "intent.md"), "want\n");
    expect(await commitSeed(path, [".canopy/intent.md"], "clarify: F", "mini")).toBe(true);
    expect((await log(path))[0]).toBe("canopy <canopy@mini>|clarify: F");
    expect(existsSync(marker)).toBe(false);
  });
  test("a clone that fails names no token in its error", async () => {
    const path = join(dir, "_incubator", "refused");
    const err = await makeSeed(path, {}, "https://x:tok3n@127.0.0.1:1/r.git", { self: "mini", id: SP, originOk: () => true, cloneTimeoutMs: 20_000 }).catch((e: unknown) => e);
    expect(String(err)).toContain("git clone failed");
    expect(String(err)).not.toContain("tok3n");
    expect(existsSync(path)).toBe(false);
  });
  test("a token in the clone url never lands in the seed's git config", async () => {
    const up = await upstream("private", { "README.md": "hi\n" });
    const withToken = "https://x:tok3n@example.invalid/private.git";
    const path = join(dir, "_incubator", "private");
    const before = { ...process.env };
    // git fetches the bare path for the url with the token in it
    process.env["GIT_CONFIG_COUNT"] = "1";
    process.env["GIT_CONFIG_KEY_0"] = `url.${up}.insteadOf`;
    process.env["GIT_CONFIG_VALUE_0"] = withToken;
    try {
      await makeSeed(path, {}, withToken, { self: "mini", id: SP, originOk: () => true });
    } finally {
      for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
    expect((await git(path, ["remote", "get-url", "upstream"])).stdout.trim()).toBe("https://example.invalid/private.git");
    expect(await readFile(join(path, ".git", "config"), "utf8")).not.toContain("tok3n");
  });
  test("no file under the seeds folder holds the clone url's token at any point, the clone's own folder included", async () => {
    const up = await upstream("private2", { "README.md": "hi\n" });
    const withToken = "https://x:tok3n@example.invalid/private2.git";
    const seeds = join(dir, "_incubator");
    const path = join(seeds, "private2");
    // the folder the clone writes the url into is not one a stage can read
    expect(seedWorkPath(path, SP).startsWith(`${seeds}/`)).toBe(false);
    /** every file under the seeds folder that holds the token, objects aside */
    const holding = async (at: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(at, { withFileTypes: true }).catch(() => [])) {
        const full = join(at, e.name);
        if (e.isDirectory()) {
          if (e.name !== "objects") out.push(...(await holding(full)));
        } else if (e.isFile() && (await readFile(full, "utf8").catch(() => "")).includes("tok3n")) out.push(full);
      }
      return out;
    };
    const seen = new Set<string>();
    let watching = true;
    const watch = (async () => {
      while (watching) {
        for (const f of await holding(seeds)) seen.add(f);
        await Bun.sleep(0);
      }
    })();
    const before = { ...process.env };
    process.env["GIT_CONFIG_COUNT"] = "1";
    process.env["GIT_CONFIG_KEY_0"] = `url.${up}.insteadOf`;
    process.env["GIT_CONFIG_VALUE_0"] = withToken;
    try {
      await makeSeed(path, {}, withToken, { self: "mini", id: SP, originOk: () => true });
    } finally {
      watching = false;
      await watch;
      for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
    expect([...seen]).toEqual([]);
    expect(await holding(seeds)).toEqual([]);
  });
});

describe("canopy's own commit while a stage is alive", () => {
  test("waits for the seeds to go quiet rather than fail", async () => {
    const seeds = join(dir, "_incubator");
    const path = join(seeds, "quietly");
    await makeSeed(path, { ".canopy/brief.md": "# Q\n" }, undefined, { self: "mini", id: SP });
    await writeFile(join(path, ".canopy", "intent.md"), "want\n");
    let busy = true;
    setSeedRoots([seeds]);
    setSeedBusy(() => busy);
    let over = false;
    try {
      const committing = seedOps("mini").commit(path, [".canopy/intent.md"], "clarify: Q").then(
        () => "committed",
        (e: unknown) => String(e),
      );
      void committing.then(() => (over = true));
      await Bun.sleep(600);
      expect(over).toBe(false);
      busy = false;
      expect(await committing).toBe("committed");
    } finally {
      setSeedBusy(() => false);
      setSeedRoots([]);
    }
    expect((await log(path))[0]).toBe("canopy <canopy@mini>|clarify: Q");
  });
});

describe("commitSeed", () => {
  test("only the named files, and nothing when they did not change", async () => {
    const path = join(dir, "_incubator", "idea");
    await writeFile(join(path, ".canopy", "intent.md"), "want\n");
    await writeFile(join(path, "stray.txt"), "not mine\n");
    expect(await commitSeed(path, [".canopy/intent.md", ".canopy/missing.md"], "clarify: Idea", "mini")).toBe(true);
    expect((await log(path))[0]).toBe("canopy <canopy@mini>|clarify: Idea");
    expect((await git(path, ["status", "--porcelain"])).stdout).toContain("?? stray.txt");
    expect(await commitSeed(path, [".canopy/intent.md"], "again", "mini")).toBe(false);
  });
});

describe("readSeed and writeSeed", () => {
  test("a plain file reads; a missing one is null", async () => {
    const path = join(dir, "_incubator", "idea");
    expect(await readSeed(path, ".canopy/intent.md")).toBe("want\n");
    expect(await readSeed(path, ".canopy/nothing.md")).toBeNull();
    expect(await readSeed(path, "nowhere/nothing.md")).toBeNull();
  });
  test("a symlink is refused both ways, and so is a file too big to be the agent's words", async () => {
    const path = join(dir, "_incubator", "idea");
    await writeFile(join(dir, "secret"), "key\n");
    await symlink(join(dir, "secret"), join(path, ".canopy", "questions.json"));
    await expect(readSeed(path, ".canopy/questions.json")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/questions.json", "[]")).rejects.toThrow("symlink");
    expect(await readFile(join(dir, "secret"), "utf8")).toBe("key\n");
    await writeFile(join(path, ".canopy", "big.md"), "x".repeat(256 * 1024 + 1));
    await expect(readSeed(path, ".canopy/big.md")).rejects.toThrow("over 256 KB");
  });
  test("writeSeed makes the folder it needs", async () => {
    const path = join(dir, "_incubator", "idea");
    await writeSeed(path, ".canopy/deep/x.md", "x");
    expect(await readFile(join(path, ".canopy", "deep", "x.md"), "utf8")).toBe("x");
  });
  test("a .canopy folder swapped for a symlink out of the seed is refused both ways, and nothing lands outside", async () => {
    const path = join(dir, "_incubator", "swapped");
    await makeSeed(path, { ".canopy/intent.md": "mine\n" }, undefined, { self: "mini", id: SP });
    const outside = join(dir, "dot-ssh");
    await mkdir(outside);
    await writeFile(join(outside, "intent.md"), "private key\n");
    await rename(join(path, ".canopy"), join(path, "was-canopy"));
    await symlink(outside, join(path, ".canopy"));
    await expect(readSeed(path, ".canopy/intent.md")).rejects.toThrow("symlink");
    await expect(readSeed(path, ".canopy/nothing.md")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/new.md", "x")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/intent.md", "x")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/deep/x.md", "x")).rejects.toThrow("symlink");
    expect((await readdir(outside)).sort()).toEqual(["intent.md"]);
    expect(await readFile(join(outside, "intent.md"), "utf8")).toBe("private key\n");
  });
  test("a deeper folder that is a symlink is refused too", async () => {
    const path = join(dir, "_incubator", "swapped");
    const outside = join(dir, "elsewhere");
    await mkdir(outside);
    await rm(join(path, ".canopy"));
    await mkdir(join(path, ".canopy"));
    await symlink(outside, join(path, ".canopy", "deep"));
    await expect(readSeed(path, ".canopy/deep/x.md")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/deep/x.md", "x")).rejects.toThrow("symlink");
    await expect(writeSeed(path, ".canopy/deep/more/x.md", "x")).rejects.toThrow("symlink");
    expect(await readdir(outside)).toEqual([]);
  });
  test("a path that climbs out of the seed or starts at the root is refused", async () => {
    const path = join(dir, "_incubator", "idea");
    await expect(readSeed(path, "../cloned/.canopy/brief.md")).rejects.toThrow("inside the seed");
    await expect(readSeed(path, "/etc/hosts")).rejects.toThrow("inside the seed");
    await expect(writeSeed(path, ".canopy/../../escape.md", "x")).rejects.toThrow("inside the seed");
    await expect(writeSeed(path, "", "x")).rejects.toThrow("inside the seed");
    expect(existsSync(join(dir, "_incubator", "escape.md"))).toBe(false);
  });
  test("a hard link to a file outside the seed is refused both ways, and committed by neither", async () => {
    const path = join(dir, "_incubator", "idea");
    const outside = join(dir, "hard-secret");
    await writeFile(outside, "key\n");
    await link(outside, join(path, ".canopy", "linked.md"));
    await expect(readSeed(path, ".canopy/linked.md")).rejects.toThrow("hard link");
    await expect(writeSeed(path, ".canopy/linked.md", "x")).rejects.toThrow("hard link");
    await expect(commitSeed(path, [".canopy/linked.md"], "leak", "mini")).rejects.toThrow("hard link");
    expect(await readFile(outside, "utf8")).toBe("key\n");
  });
  test("writeSeed replaces a longer file whole", async () => {
    const path = join(dir, "_incubator", "idea");
    await writeSeed(path, ".canopy/short.md", "a long first version\n");
    await writeSeed(path, ".canopy/short.md", "short\n");
    expect(await readSeed(path, ".canopy/short.md")).toBe("short\n");
  });
  test("a seed that is itself a symlink is refused", async () => {
    const link = join(dir, "_incubator", "alias");
    await symlink(join(dir, "_incubator", "idea"), link);
    await expect(readSeed(link, ".canopy/intent.md")).rejects.toThrow("symlink");
    await expect(writeSeed(link, ".canopy/y.md", "y")).rejects.toThrow("symlink");
  });
});

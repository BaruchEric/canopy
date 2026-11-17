import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../scripts/mac-update");

let dir = "";
let home = "";
let origin = "";
let checkout = "";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@localhost",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@localhost",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-c", "init.defaultBranch=main", ...args], { cwd, env: { ...GIT_ENV, HOME: home, PATH: process.env["PATH"] ?? "" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

/** a commit on origin's main that writes each file */
async function commitOnOrigin(files: Record<string, string>): Promise<string> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(origin, name, ".."), { recursive: true });
    await writeFile(join(origin, name), text);
  }
  await git(origin, "add", "-A");
  await git(origin, "commit", "-qm", `change ${Object.keys(files).join(" ")}`);
  return git(origin, "rev-parse", "HEAD");
}

const run = async (request: string, extra: Record<string, string> = {}) => {
  const p = Bun.spawn(["sh", SCRIPT], {
    env: { ...GIT_ENV, HOME: home, PATH: process.env["PATH"] ?? "", CANOPY_MAC_ROOT: checkout, CANOPY_MAC_WAIT: "2", SSH_ORIGINAL_COMMAND: request, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
};

/** what the fakes were asked to do, in order */
const calls = async () => ((await readFile(join(home, "calls"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean));
const serve = (sha: string) => writeFile(join(home, "running"), sha);

// The fakes sit in ~/.bun/bin, the first place on the PATH the script sets,
// so a real bun in /usr/local/bin never answers. curl answers /api/about
// with the commit in ~/running; launchctl's restart makes the server run
// the checkout's HEAD; bun's build writes dist/web/index.html.
const FAKES: Record<string, string> = {
  bun: `#!/bin/sh
echo "bun $*" >> "$HOME/calls"
if [ "$1 $2" = "run build" ]; then
  [ ! -f "$HOME/fail-build" ] || { echo "the build broke"; exit 1; }
  mkdir -p dist/web && : > dist/web/index.html
fi
`,
  curl: `#!/bin/sh
[ -s "$HOME/running" ] || exit 7
printf '{"version":"0.2.0","commit":"%s","dirty":false}' "$(cat "$HOME/running")"
`,
  launchctl: `#!/bin/sh
echo "launchctl $*" >> "$HOME/calls"
[ -f "$HOME/stays-down" ] || git -C "$CANOPY_MAC_ROOT" rev-parse HEAD > "$HOME/running"
`,
};

describe("scripts/mac-update", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "canopy-macupdate-"));
    home = join(dir, "home");
    origin = join(dir, "origin");
    checkout = join(dir, "checkout");
    await mkdir(join(home, ".bun", "bin"), { recursive: true });
    for (const [name, body] of Object.entries(FAKES)) {
      await writeFile(join(home, ".bun", "bin", name), body);
      await chmod(join(home, ".bun", "bin", name), 0o755);
    }
    await mkdir(origin);
    await git(origin, "init", "-q");
    await commitOnOrigin({ "package.json": "{}\n", "bun.lock": "lock 1\n", "src/server.ts": "one\n", "ui/page.tsx": "one\n", ".gitignore": "dist/\n" });
    await git(dir, "clone", "-q", origin, checkout);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a request other than status or update runs nothing", async () => {
    for (const request of ["rm -rf /", "update; reboot", "status now", "update abc1234 more", ""]) {
      const r = await run(request);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/refused|commit hash/);
    }
    expect(await calls()).toEqual([]);
  });

  test("status names the checkout and what the server runs", async () => {
    const head = await git(checkout, "rev-parse", "HEAD");
    await serve(head);
    const r = await run("status");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`checkout  ${head.slice(0, 7)}`);
    expect(r.stdout).toContain(`running   ${head.slice(0, 7)}`);
    await rm(join(home, "running"));
    expect((await run("status")).stdout).toContain("nothing answers on :7850");
  });

  test("a page-only change is pulled and built, and the server keeps running", async () => {
    const old = await git(checkout, "rev-parse", "HEAD");
    await serve(old);
    const next = await commitOnOrigin({ "ui/page.tsx": "two\n", "docs/notes.md": "two\n" });
    const r = await run(`update ${next}`);
    expect(r.code).toBe(0);
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(next);
    expect(r.stdout).toContain(`pulled    ${old.slice(0, 7)}..${next.slice(0, 7)}`);
    expect(r.stdout).toContain("no restart");
    expect(await calls()).toEqual(["bun run build"]);
  });

  test("a server change restarts the launchd agent and waits for the new commit", async () => {
    await serve(await git(checkout, "rev-parse", "HEAD"));
    const next = await commitOnOrigin({ "src/server.ts": "two\n" });
    const r = await run("update");
    expect(r.code).toBe(0);
    expect(await calls()).toEqual(["bun run build", expect.stringMatching(/^launchctl kickstart -k gui\/\d+\/ca\.beric\.canopy-server$/)]);
    expect(r.stdout).toContain(`restarted on ${next.slice(0, 7)} (its code changed since`);
    expect(r.stdout).toContain("locked until canopy secrets unlock");
  });

  test("a server behind an earlier page-only pull restarts only when its code is behind too", async () => {
    const first = await git(checkout, "rev-parse", "HEAD");
    await serve(first);
    await commitOnOrigin({ "src/server.ts": "two\n" });
    await git(checkout, "pull", "-q", "--ff-only");
    await mkdir(join(checkout, "dist", "web"), { recursive: true });
    await writeFile(join(checkout, "dist", "web", "index.html"), "");
    // the checkout moved past the server by hand and was built; nothing new on origin
    const r = await run("update");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already at");
    expect(await calls()).toEqual([expect.stringMatching(/^launchctl kickstart/)]);
  });

  test("a test file alone is no reason to restart", async () => {
    await serve(await git(checkout, "rev-parse", "HEAD"));
    await commitOnOrigin({ "src/server.test.ts": "one\n" });
    const r = await run("update");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no restart");
  });

  test("a new lockfile installs before the build", async () => {
    await serve(await git(checkout, "rev-parse", "HEAD"));
    await commitOnOrigin({ "bun.lock": "lock 2\n" });
    const r = await run("update");
    expect(r.code).toBe(0);
    expect((await calls()).slice(0, 2)).toEqual(["bun install --frozen-lockfile", "bun run build"]);
  });

  test("a server that does not answer is started", async () => {
    const r = await run("update");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("nothing answered on :7850");
    expect(await calls()).toContainEqual(expect.stringMatching(/^launchctl kickstart/));
  });

  test("a server that does not come back is an error, not a success", async () => {
    await writeFile(join(home, "stays-down"), "");
    const r = await run("update");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("did not answer");
  });

  test("an expected commit other than origin's main is refused before anything moves", async () => {
    const head = await git(checkout, "rev-parse", "HEAD");
    await commitOnOrigin({ "src/server.ts": "two\n" });
    const r = await run(`update ${head}`);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("push first");
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(head);
    expect(await calls()).toEqual([]);
  });

  test("a checkout with uncommitted changes, on another branch, or ahead of origin is left alone", async () => {
    await commitOnOrigin({ "src/server.ts": "two\n" });
    await writeFile(join(checkout, "src/server.ts"), "mine\n");
    expect((await run("update")).stderr).toContain("uncommitted changes");
    await git(checkout, "checkout", "-q", "--", "src/server.ts");

    await git(checkout, "checkout", "-qb", "side");
    expect((await run("update")).stderr).toContain("on side, not main");
    await git(checkout, "checkout", "-q", "main");

    await writeFile(join(checkout, "ui/page.tsx"), "local\n");
    await git(checkout, "commit", "-qam", "local only");
    const r = await run("update");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("commits origin's main lacks");
    expect(await calls()).toEqual([]);
  });

  test("a failed build stops before any restart", async () => {
    await serve(await git(checkout, "rev-parse", "HEAD"));
    await writeFile(join(home, "fail-build"), "");
    await commitOnOrigin({ "src/server.ts": "two\n" });
    const r = await run("update");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("the build broke");
    expect(r.stderr).toContain("the server still runs what it ran");
    expect(await calls()).toEqual(["bun run build"]);
  });

  test("the lock leaves with the run, and a second run waits on no stale lock", async () => {
    await serve(await git(checkout, "rev-parse", "HEAD"));
    expect((await run("update")).code).toBe(0);
    expect(existsSync(join(home, ".cache", "canopy-mac-update.lock"))).toBe(false);
    await mkdir(join(home, ".cache", "canopy-mac-update.lock"), { recursive: true });
    const r = await run("update");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("another update is running");
  });
});

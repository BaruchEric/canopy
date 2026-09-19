import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { buildsRoot, githubRemote, Launcher, LauncherError, thisPlatform, unpack, type LaunchRepo } from "./launcher";
import { DEFAULT_LAUNCH, type BuildChange, type Job } from "./types";

let scratch: string;
let repoPath: string;
let repo: LaunchRepo;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-launcher-"));
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  repoPath = join(scratch, "repo");
  await exec(["git", "init", "-q", repoPath]);
  await exec(["git", "-C", repoPath, "remote", "add", "origin", "git@github.com:someone/thing.git"]);
  repo = { id: "thing", name: "thing", path: repoPath };
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A launcher whose hooks are recorded, and a way to wait for a job's end. */
function harness() {
  const jobs: Job[] = [];
  const changes: { what: BuildChange; build: string }[] = [];
  const waiters = new Map<string, (j: Job) => void>();
  const launcher = new Launcher({
    onJob: (job) => {
      jobs.push(structuredClone(job));
      if (job.status !== "working") waiters.get(job.id)?.(job);
    },
    onJobGone: () => {},
    onBuilds: (_repo, what, build) => changes.push({ what, build }),
  });
  const ended = (job: Job) =>
    job.status !== "working"
      ? Promise.resolve(job)
      : new Promise<Job>((r) => waiters.set(job.id, r));
  return { launcher, jobs, changes, ended };
}

describe("thisPlatform and where builds live", () => {
  test("names the os and arch this test runs on", () => {
    const p = thisPlatform();
    expect(["darwin", "linux", "win32", "other"]).toContain(p.os);
    expect(["arm64", "x64", "other"]).toContain(p.arch);
  });
  test("builds root is under the config dir", () => {
    expect(buildsRoot()).toBe(join(scratch, "config", "builds"));
  });
  test("the GitHub remote and its slug", async () => {
    expect(await githubRemote(repo)).toEqual({ remote: "origin", slug: "someone/thing" });
    const other = join(scratch, "other");
    await exec(["git", "init", "-q", other]);
    expect(await githubRemote({ id: "o", name: "o", path: other })).toBeNull();
  });
});

describe("builds and the local checkout", () => {
  test("nothing yet, and no local entry without a run or build line", async () => {
    const { launcher } = harness();
    expect(await launcher.builds(repo, DEFAULT_LAUNCH)).toEqual([]);
  });

  test("a build line makes a local entry; building runs it in the repo", async () => {
    const { launcher, jobs, changes, ended } = harness();
    const settings = { ...DEFAULT_LAUNCH, build: "echo building && echo made > built.txt" };
    const list = await launcher.builds(repo, settings);
    expect(list.map((b) => b.key)).toEqual(["local"]);
    expect(list[0]?.what).toBeNull();

    const job = await launcher.build(repo, { kind: "local" }, settings);
    expect(job.kind).toBe("build");
    const done = await ended(job);
    expect(done.status).toBe("done");
    expect(done.lines).toContain("building");
    expect((await readFile(join(repoPath, "built.txt"), "utf8")).trim()).toBe("made");
    expect(jobs[0]?.status).toBe("working");
    expect(changes).toEqual([{ what: "built", build: "local" }]);

    const after = await launcher.builds(repo, settings);
    expect(after[0]?.at).toBeGreaterThan(0);
  });

  test("a failing build line fails the job with its exit code", async () => {
    const { launcher, ended } = harness();
    const job = await launcher.build(repo, { kind: "local" }, { ...DEFAULT_LAUNCH, build: "echo nope >&2; exit 3" });
    const done = await ended(job);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("build exited 3");
    expect(done.lines).toContain("nope");
  });

  test("build refuses without a build line, and a release ref", async () => {
    const { launcher } = harness();
    await expect(launcher.build(repo, { kind: "local" }, DEFAULT_LAUNCH)).rejects.toBeInstanceOf(LauncherError);
    await expect(launcher.build(repo, { kind: "release", tag: "v1" }, DEFAULT_LAUNCH)).rejects.toThrow("installed, not built");
    await expect(
      launcher.build({ ...repo, host: "box" }, { kind: "local" }, { ...DEFAULT_LAUNCH, build: "x" }),
    ).rejects.toThrow("this machine only");
  });

  test("launching runs the run line, counts it, and can be stopped", async () => {
    const { launcher, changes } = harness();
    const settings = { ...DEFAULT_LAUNCH, run: "sleep 30" };
    const b = await launcher.launch(repo, "local", settings);
    expect(b.running).toBe(true);
    expect(b.launches).toBe(1);
    expect(b.lastLaunch).toBeGreaterThan(0);
    expect(changes.at(-1)).toEqual({ what: "launched", build: "local" });
    await expect(launcher.launch(repo, "local", settings)).rejects.toThrow("already running");
    expect(launcher.stopLaunch(repo, "local")).toBe(true);
    await settle(200);
    expect(changes.at(-1)).toEqual({ what: "exited", build: "local" });
    const after = await launcher.builds(repo, settings);
    expect(after.find((x) => x.key === "local")?.running).toBe(false);
    expect(launcher.stopLaunch(repo, "local")).toBe(false);
  });

  test.skipIf(process.platform !== "darwin")("an app bundle is watched through open -W and quit by path", async () => {
    const { launcher, changes } = harness();
    const dir = join(scratch, "config", "builds", "someone", "thing", "release", "v0.1");
    const app = join(dir, "Stub.app");
    await exec(["mkdir", "-p", join(app, "Contents", "MacOS")]);
    await Bun.write(
      join(app, "Contents", "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>' +
        "<key>CFBundleExecutable</key><string>Stub</string>" +
        "<key>CFBundleIdentifier</key><string>ca.beric.canopy.stub</string>" +
        "<key>CFBundlePackageType</key><string>APPL</string>" +
        "<key>LSBackgroundOnly</key><true/>" +
        "</dict></plist>\n",
    );
    await Bun.write(join(app, "Contents", "MacOS", "Stub"), "#!/bin/sh\nsleep 60\n");
    await exec(["chmod", "+x", join(app, "Contents", "MacOS", "Stub")]);
    await Bun.write(
      join(scratch, "config", "builds", "someone", "thing", "state.json"),
      JSON.stringify({ builds: { "release:v0.1": { at: 1, asset: "Stub.zip", target: { kind: "app", name: "Stub.app" } } }, launches: {} }),
    );
    const b = await launcher.launch(repo, "release:v0.1", DEFAULT_LAUNCH);
    expect(b.running).toBe(true);
    expect(b.launches).toBe(1);
    await settle(1500);
    expect((await launcher.builds(repo, DEFAULT_LAUNCH)).find((x) => x.key === "release:v0.1")?.running).toBe(true);
    expect(launcher.stopLaunch(repo, "release:v0.1")).toBe(true);
    for (let i = 0; i < 40 && changes.at(-1)?.what !== "exited"; i++) await settle(100);
    expect(changes.at(-1)).toEqual({ what: "exited", build: "release:v0.1" });
    expect((await exec(["pgrep", "-f", join(app, "Contents", "MacOS", "Stub")])).code).toBe(1);
  }, 15_000);

  test("launch refuses without a run line, and an unknown build", async () => {
    const { launcher } = harness();
    await expect(launcher.launch(repo, "local", { ...DEFAULT_LAUNCH, build: "x" })).rejects.toThrow("run line");
    await expect(launcher.launch(repo, "release:v9", DEFAULT_LAUNCH)).rejects.toThrow("no build");
    await expect(launcher.launch(repo, "junk", DEFAULT_LAUNCH)).rejects.toThrow("not a build");
  });

  test("the checkout itself cannot be removed", async () => {
    const { launcher } = harness();
    await expect(launcher.remove(repo, "local")).rejects.toThrow("not canopy's to remove");
  });

  test("a stopped job ends stopped", async () => {
    const { launcher, ended } = harness();
    const job = await launcher.build(repo, { kind: "local" }, { ...DEFAULT_LAUNCH, build: "sleep 30" });
    await settle(100);
    const stopped = launcher.stop(job.id);
    expect(stopped.status).toBe("stopped");
    expect((await ended(job)).status).toBe("stopped");
    expect(launcher.list().map((j) => j.id)).toContain(job.id);
    launcher.dismiss(job.id);
    expect(launcher.list()).toEqual([]);
  });
});

describe("unpack: the shapes a release comes in", () => {
  const mac = process.platform === "darwin";
  const said: string[] = [];
  const say = (l: string) => said.push(l);

  /** a stub app bundle at `at`, with the one file macOS needs to call it one */
  async function stubApp(at: string) {
    await exec(["mkdir", "-p", join(at, "Contents", "MacOS")]);
    await Bun.write(join(at, "Contents", "Info.plist"), "<plist/>\n");
    await Bun.write(join(at, "Contents", "MacOS", "Stub"), "#!/bin/sh\necho stub\n");
    await exec(["chmod", "+x", join(at, "Contents", "MacOS", "Stub")]);
  }

  test.skipIf(!mac)("a zip holding an app bundle, with Finder's __MACOSX beside it", async () => {
    const src = join(scratch, "zip-src");
    await stubApp(join(src, "Stub.app"));
    await exec(["mkdir", "-p", join(src, "__MACOSX")]);
    await Bun.write(join(src, "__MACOSX", "._Stub.app"), "x");
    const dir = join(scratch, "zip-dir");
    await exec(["mkdir", "-p", dir]);
    const r = await exec(["ditto", "-c", "-k", src, join(dir, "Stub-1.0-macos.zip")]);
    expect(r.code).toBe(0);
    const target = await unpack(dir, "Stub-1.0-macos.zip", say);
    expect(target).toEqual({ kind: "app", name: "Stub.app" });
    const left = (await exec(["ls", dir])).stdout.trim().split("\n");
    expect(left).toEqual(["Stub.app"]);
    expect((await exec(["test", "-x", join(dir, "Stub.app", "Contents", "MacOS", "Stub")])).code).toBe(0);
  });

  test.skipIf(!mac)("a disk image: the app is copied out and the image dropped", async () => {
    const src = join(scratch, "dmg-src");
    await stubApp(join(src, "Stub.app"));
    await Bun.write(join(src, "README.txt"), "drag to Applications\n");
    const dir = join(scratch, "dmg-dir");
    await exec(["mkdir", "-p", dir]);
    const r = await exec(["hdiutil", "create", "-quiet", "-srcfolder", src, "-volname", "Stub", "-fs", "HFS+", join(dir, "Stub.dmg")], { timeoutMs: 60_000 });
    expect(r.code).toBe(0);
    const target = await unpack(dir, "Stub.dmg", say);
    expect(target).toEqual({ kind: "app", name: "Stub.app" });
    const left = (await exec(["ls", dir])).stdout.trim().split("\n");
    expect(left).toEqual(["Stub.app"]);
    expect(said).toContain("mounting the disk image");
    expect(said).toContain("copying Stub.app");
  }, 60_000);

  test("a tarball wrapping one folder is lifted; the binary is made executable", async () => {
    const src = join(scratch, "tar-src", "tool-1.0");
    await exec(["mkdir", "-p", src]);
    await Bun.write(join(src, "tool"), "#!/bin/sh\necho tool\n");
    await Bun.write(join(src, "LICENSE"), "mit\n");
    const dir = join(scratch, "tar-dir");
    await exec(["mkdir", "-p", dir]);
    expect((await exec(["tar", "-czf", join(dir, "tool-1.0-linux-x64.tar.gz"), "-C", join(scratch, "tar-src"), "tool-1.0"])).code).toBe(0);
    const target = await unpack(dir, "tool-1.0-linux-x64.tar.gz", say);
    expect(target).toEqual({ kind: "bin", name: "tool" });
    expect((await exec(["ls", dir])).stdout.trim().split("\n").sort()).toEqual(["LICENSE", "tool"]);
    expect((await exec(["test", "-x", join(dir, "tool")])).code).toBe(0);
  });

  test("a bare file is kept and made executable", async () => {
    const dir = join(scratch, "bin-dir");
    await exec(["mkdir", "-p", dir]);
    await Bun.write(join(dir, "tool-macos-arm64"), "#!/bin/sh\necho tool\n");
    expect(await unpack(dir, "tool-macos-arm64", say)).toEqual({ kind: "bin", name: "tool-macos-arm64" });
    expect((await exec(["test", "-x", join(dir, "tool-macos-arm64")])).code).toBe(0);
  });

  test("a package is left for open", async () => {
    const dir = join(scratch, "pkg-dir");
    await exec(["mkdir", "-p", dir]);
    await Bun.write(join(dir, "Tool.pkg"), "not really\n");
    expect(await unpack(dir, "Tool.pkg", say)).toEqual({ kind: "open", name: "Tool.pkg" });
  });
});

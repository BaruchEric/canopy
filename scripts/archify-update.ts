/**
 * bun run archify:update [--ref TAG|BRANCH|COMMIT] [--no-test]
 * bun scripts/archify-update.ts --check
 *
 * Pulls a newer Archify into lib/archify (FR-071). canopy's panel lists it as
 * the task archify-update.
 *
 * Upstream's whole history is about 1.7 GB, so it fetches only two commits,
 * one deep and without file contents (--filter=blob:none), then checks out
 * just `archify/`, which brings about 10 MB: the pinned release, as the base,
 * and the newest release (or --ref). It goes through upstream's `archify/`
 * one file at a time onto lib/archify/skills/archify, leaving out
 * `examples/*.html`: a file canopy never changed becomes upstream's new one,
 * and a file canopy edited, of which there are none today, gets a three-way
 * merge with `git merge-file`, the pinned release as the base. Then it moves
 * the version in VENDOR.md's pin, ARCHIFY_VERSION and the plugin manifest,
 * says when the license files changed, lists the web addresses the release
 * adds and its changelog's headlines, and runs Archify's `doctor` and
 * canopy's Archify tests. It commits nothing; the diff is left for review.
 * It refuses to start while lib/archify or src/core/archify.ts hold
 * uncommitted changes, so a `git checkout` of those two and a `git clean`
 * of lib/archify undo a run.
 *
 * --check only asks upstream for its tags and says in one line whether a
 * newer release is out, exiting 1 when one is. canopy's own health check
 * `archify` (.canopy/health.json) runs it every six hours, by the script's
 * path, since `bun run` echoes the command on stderr and a command check
 * shows its last line.
 *
 * Exit: 0 when updated or already current, 1 when a merge conflicted or a
 * check failed (with --check, when a newer release is out), 2 when it could
 * not run. --root and --upstream point it at another checkout and another
 * source; the tests use them.
 * Bun: spawns git, node and bun.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { ARCHIFY_SKILL_PATH, ARCHIFY_SOURCE, ARCHIFY_UPSTREAM, LICENSE_FILES, isLeftOut, packageVersion, writePluginVersion } from "../src/core/archifyvendor";
import {
  addressesIn,
  changelogHeadlines,
  compareVersions,
  isText,
  newAddresses,
  newestRelease,
  planFile,
  readPin,
  releaseTagNames,
  sameBytes,
  writePin,
  writeVersionConst,
  type FileStep,
} from "../src/core/floorplanvendor";

const say = (line = ""): void => void process.stdout.write(`${line}\n`);

class Stop extends Error {}

interface Args {
  root: string;
  upstream: string;
  ref: string | null;
  test: boolean;
  check: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { root: join(import.meta.dir, ".."), upstream: ARCHIFY_UPSTREAM, ref: null, test: true, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (!v) throw new Stop(`${a} needs a value`);
      return v;
    };
    if (a === "--ref") out.ref = value();
    else if (a === "--root") out.root = value();
    else if (a === "--upstream") out.upstream = value();
    else if (a === "--no-test") out.test = false;
    else if (a === "--check") out.check = true;
    else throw new Stop(`unknown argument ${a}; usage: bun run archify:update [--ref TAG|BRANCH|COMMIT] [--no-test] | --check`);
  }
  return out;
}

function run(cmd: string[], cwd?: string, timeout?: number): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", ...(timeout ? { timeout } : {}) });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

const lastLine = (r: { code: number; err: string }): string => r.err.trim().split("\n").pop() || `exited ${r.code}`;

function must(cmd: string[], cwd?: string, timeout?: number): string {
  const r = run(cmd, cwd, timeout);
  if (r.code !== 0) throw new Stop(`${cmd.slice(0, 3).join(" ")} failed: ${lastLine(r)}`);
  return r.out;
}

/** every file under `dir`, relative to it; none when it is not there */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    if (statSync(abs).isDirectory()) for (const name of readdirSync(abs)) walk(rel ? join(rel, name) : name);
    else out.push(rel);
  };
  if (existsSync(dir)) walk("");
  return out;
}

/** the files canopy keeps from a snapshot of upstream's `archify/` */
const keptFiles = (dir: string): string[] => filesUnder(dir).filter((f) => !isLeftOut(f));

const read = (path: string): Uint8Array | null => (existsSync(path) ? new Uint8Array(readFileSync(path)) : null);

function textAddresses(dir: string, files: readonly string[]): string[] {
  return files.flatMap((f) => {
    const bytes = read(join(dir, f));
    return bytes && isText(bytes) ? addressesIn(new TextDecoder().decode(bytes)) : [];
  });
}

const WORDS: Record<Exclude<FileStep, "same">, string> = {
  add: "added",
  take: "updated",
  remove: "removed",
  keep: "kept canopy's edit (upstream left it alone)",
  merge: "merged canopy's edit into upstream's change",
  conflict: "CONFLICT",
};

/** One line on whether upstream has a release newer than `have`; 1 when it has. */
function check(upstream: string, have: string): number {
  const r = run(["git", "ls-remote", "--tags", "--refs", upstream], undefined, 20_000);
  if (r.code !== 0) throw new Stop(`could not ask ${upstream} for its releases: ${lastLine(r)}`);
  const newest = newestRelease(releaseTagNames(r.out));
  if (!newest) throw new Stop(`${upstream} has no release tags`);
  if (compareVersions(newest.version, have) > 0) {
    say(`Archify ${newest.version} is out and canopy has ${have}: run the task archify-update (bun run archify:update)`);
    return 1;
  }
  say(`canopy has Archify ${have}, the newest release`);
  return 0;
}

/** A shallow, contentless fetch of one ref into `repo`; its commit, or null. */
function fetchCommit(repo: string, ref: string): string | null {
  const r = run(["git", "-C", repo, "fetch", "--quiet", "--no-tags", "--depth", "1", "--filter=blob:none", "origin", ref], undefined, 300_000);
  if (r.code !== 0) return null;
  const c = run(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]);
  return c.code === 0 ? c.out.trim() : null;
}

/** upstream's `archify/` at `commit`, checked out into `dir`; the blobs come in one batch */
function snapshot(repo: string, commit: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  must(["git", "-C", repo, `--work-tree=${dir}`, "checkout", "--quiet", commit, "--", ARCHIFY_SOURCE], undefined, 300_000);
}

function main(args: Args): number {
  const lib = join(args.root, "lib/archify");
  const skill = join(lib, ARCHIFY_SKILL_PATH);
  const vendorPath = join(lib, "VENDOR.md");
  const pluginPath = join(lib, ".claude-plugin/plugin.json");
  const constPath = join(args.root, "src/core/archify.ts");
  const vendorMd = readFileSync(vendorPath, "utf8");
  const pin = readPin(vendorMd);
  if (!pin) throw new Stop("lib/archify/VENDOR.md has no line naming the release and commit");
  if (args.check) return check(args.upstream, pin.version);

  const dirty = must(["git", "-C", args.root, "status", "--porcelain", "--", "lib/archify", "src/core/archify.ts"]).trim();
  if (dirty) throw new Stop(`lib/archify or src/core/archify.ts has uncommitted changes; commit or drop them first:\n${dirty}`);

  const tmp = mkdtempSync(join(tmpdir(), "archify-update-"));
  try {
    const repo = join(tmp, "upstream");
    must(["git", "init", "--quiet", repo]);
    must(["git", "-C", repo, "remote", "add", "origin", args.upstream]);
    say(`fetching ${args.upstream}…`);

    let target: string | null;
    let label: string;
    if (args.ref) {
      label = args.ref;
      target = fetchCommit(repo, args.ref);
      if (!target) throw new Stop(`upstream has no tag, branch or commit called ${args.ref}`);
    } else {
      const tags = run(["git", "ls-remote", "--tags", "--refs", args.upstream], undefined, 60_000);
      if (tags.code !== 0) throw new Stop(`could not ask ${args.upstream} for its releases: ${lastLine(tags)}`);
      const newest = newestRelease(releaseTagNames(tags.out));
      if (!newest) throw new Stop("upstream has no release tags; name one with --ref");
      label = newest.tag;
      target = fetchCommit(repo, `refs/tags/${newest.tag}`);
      if (!target) throw new Stop(`could not fetch ${newest.tag} from ${args.upstream}`);
    }
    if (target === pin.commit) {
      say(`canopy has Archify ${pin.version} (${pin.commit.slice(0, 8)}), which is ${label}; nothing to pull`);
      return 0;
    }
    // the base: the pinned release's tag, or else the pinned commit itself
    const base = fetchCommit(repo, `refs/tags/v${pin.version}`) === pin.commit || fetchCommit(repo, pin.commit) === pin.commit ? pin.commit : null;
    if (!base) throw new Stop(`upstream no longer has the pinned commit ${pin.commit}, so canopy's edits have no base to merge from; follow VENDOR.md by hand`);

    const before = join(tmp, "before");
    const after = join(tmp, "after");
    snapshot(repo, base, before);
    snapshot(repo, target, after);
    const from = join(before, ARCHIFY_SOURCE);
    const to = join(after, ARCHIFY_SOURCE);
    const pkg = read(join(to, "package.json"));
    const version = pkg ? packageVersion(new TextDecoder().decode(pkg)) : null;
    if (!version) throw new Stop(`${label} has no x.y.z version in ${ARCHIFY_SOURCE}/package.json`);

    const back = compareVersions(version, pin.version) < 0;
    say(`Archify ${pin.version} (${pin.commit.slice(0, 8)}) → ${version} (${target.slice(0, 8)}, ${label})${back ? ", an older release" : ""}`);

    const ours = must(["git", "-C", args.root, "ls-files", "--", `lib/archify/${ARCHIFY_SKILL_PATH}`])
      .split("\n")
      .filter(Boolean)
      .map((f) => relative(`lib/archify/${ARCHIFY_SKILL_PATH}`, f));
    const paths = [...new Set([...keptFiles(from), ...keptFiles(to), ...ours])].sort();
    const done: { path: string; step: Exclude<FileStep, "same">; note?: string }[] = [];
    for (const path of paths) {
      const theirsPath = join(to, path);
      const basePath = join(from, path);
      const dest = join(skill, path);
      const step = planFile(read(basePath), read(dest), read(theirsPath));
      if (step === "same") continue;
      if (step === "add" || step === "take") {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(theirsPath));
      } else if (step === "remove") rmSync(dest);
      else if (step === "merge") {
        const merged = run(["git", "merge-file", "-p", "-L", "canopy", "-L", `archify ${pin.version}`, "-L", `archify ${version}`, dest, basePath, theirsPath]);
        if (merged.code < 0 || merged.code > 127) throw new Stop(`git merge-file failed on ${path}: ${merged.err.trim()}`);
        writeFileSync(dest, merged.out);
        if (merged.code > 0) {
          done.push({ path, step: "conflict", note: `${merged.code} conflict${merged.code === 1 ? "" : "s"} marked in the file` });
          continue;
        }
      } else if (step === "conflict") {
        const gone = !existsSync(theirsPath);
        const why = !existsSync(basePath) ? "both sides added it" : gone ? "upstream removed it and canopy edits it" : "canopy removed it and upstream changed it";
        done.push({ path, step, note: `${why}; canopy's side is left as it was` });
        continue;
      }
      done.push({ path, step });
    }

    writeFileSync(vendorPath, writePin(vendorMd, { version, commit: target, date: must(["git", "-C", repo, "log", "-1", "--format=%cs", target]).trim() }));
    writeFileSync(constPath, writeVersionConst(readFileSync(constPath, "utf8"), version, "ARCHIFY_VERSION"));
    writeFileSync(pluginPath, writePluginVersion(readFileSync(pluginPath, "utf8"), version));

    say();
    say(done.length ? "files:" : `no file under lib/archify/${ARCHIFY_SKILL_PATH} changed`);
    for (const d of done) say(`  ${WORDS[d.step]}  ${ARCHIFY_SKILL_PATH}/${d.path}${d.note ? `  (${d.note})` : ""}`);
    say(`  moved the version in VENDOR.md's pin, ARCHIFY_VERSION and .claude-plugin/plugin.json to ${version}`);

    const licenses = LICENSE_FILES.filter((f) => !sameBytes(read(join(from, f)), read(join(to, f))));
    if (licenses.length) {
      say();
      say(`the license files changed (${licenses.join(", ")}): read them, then set the license in .claude-plugin/plugin.json, VENDOR.md's first line and src/core/archify.ts's header, and keep any NOTICE (VENDOR.md, "Moving to a new release")`);
    }

    const fresh = newAddresses(textAddresses(from, keptFiles(from)), textAddresses(to, keptFiles(to)));
    say();
    if (fresh.length) {
      say("web addresses this release adds; check a diagram run asks none of them (VENDOR.md, step 3):");
      for (const a of fresh) say(`  ${a}`);
    } else say("this release adds no web address to the kept files");

    const changelog = run(["git", "-C", repo, "show", `${target}:CHANGELOG.md`], undefined, 120_000);
    const lines = changelog.code === 0 ? changelogHeadlines(changelog.out, back ? version : pin.version, back ? pin.version : version) : [];
    if (lines.length) {
      say();
      say("what changed upstream (CHANGELOG.md):");
      for (const l of lines) say(`  ${l}`);
    }

    let failed = done.some((d) => d.step === "conflict");
    if (args.test) {
      say();
      say("running Archify's doctor…");
      const doctor = run(["node", join(skill, "bin/archify.mjs"), "doctor"], args.root, 120_000);
      if (doctor.code === 0) say("  doctor passed");
      else {
        say(`  doctor exited ${doctor.code}: ${`${doctor.out}\n${doctor.err}`.trim().split("\n").slice(-3).join(" / ")}`);
        failed = true;
      }
      say("running canopy's Archify tests…");
      // the diagnosis tests too: they run the new release's code-analysis prepare (FR-075)
      const t = run(
        ["bun", "test", "src/core/archify.test.ts", "src/core/archifyvendor.test.ts", "src/server/archify.test.ts", "src/server/archify-route.test.ts", "src/core/diagnosis.test.ts", "src/server/diagnosis.test.ts", "src/server/diagnosis-route.test.ts"],
        args.root,
      );
      const tail = `${t.out}\n${t.err}`.trim().split("\n").filter((l) => /^\s*\d+ (pass|fail)$|^\(fail\)/.test(l));
      for (const l of tail) say(`  ${l.trim()}`);
      if (t.code !== 0) failed = true;
    }

    say();
    if (failed) say("not done: resolve the conflicts or failures above. `git checkout -- lib/archify src/core/archify.ts` and `git clean -fd lib/archify` drop this run.");
    say("left for a person: read the diff (`git diff --stat lib/archify`), check SKILL.md's steps against archifyTask in src/core/archify.ts and the CLI's path against archifyTools (VENDOR.md, step 3), then commit and deploy. Diagrams drawn before keep working: each page stands alone.");
    return failed ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  process.exit(main(parseArgs(process.argv.slice(2))));
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  process.stderr.write(`archify:update: ${e.message}\n`);
  process.exit(2);
}

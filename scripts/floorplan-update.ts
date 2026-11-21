/**
 * bun run floorplan:update [--ref TAG|BRANCH|COMMIT] [--no-test]
 * bun scripts/floorplan-update.ts --check
 *
 * Pulls a newer Floorplan into lib/floorplan and merges canopy's own edits
 * into it. canopy's panel lists it as the task floorplan-update.
 *
 * It clones upstream, takes its newest release (or --ref), and goes through
 * the paths canopy keeps (VENDOR.md, "What is here") one file at a time: a
 * file canopy never changed becomes upstream's new one, and a file canopy
 * edited (today serve.mjs) gets a three-way merge, `git merge-file` with the
 * pinned commit as the base. Then it moves the pin in VENDOR.md and
 * FLOORPLAN_VERSION, lists the web addresses the new release adds and its
 * changelog's headlines, and runs canopy's Floorplan tests. It commits
 * nothing; the diff is left for review. It refuses to start while
 * lib/floorplan or src/core/floorplan.ts hold uncommitted changes, so a
 * `git checkout` of those two undoes a run.
 *
 * --check only asks upstream for its tags and says in one line whether a
 * newer release is out, exiting 1 when one is. canopy's own health check
 * `floorplan` (.canopy/health.json) runs it every six hours; it runs the
 * script directly, since `bun run` echoes the command on stderr and a
 * command check shows its last line.
 *
 * Exit: 0 when updated or already current, 1 when a merge conflicted or the
 * tests failed (with --check, when a newer release is out), 2 when it could
 * not run. --root and --upstream point it at
 * another checkout and another source; the tests use them.
 * Bun: spawns git, tar and bun.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  FLOORPLAN_KEPT,
  FLOORPLAN_OWN,
  FLOORPLAN_UPSTREAM,
  addressesIn,
  changelogHeadlines,
  compareVersions,
  isText,
  newAddresses,
  newestRelease,
  planFile,
  readPin,
  releaseTagNames,
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
  const out: Args = { root: join(import.meta.dir, ".."), upstream: FLOORPLAN_UPSTREAM, ref: null, test: true, check: false };
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
    else throw new Stop(`unknown argument ${a}; usage: bun run floorplan:update [--ref TAG|BRANCH|COMMIT] [--no-test] | --check`);
  }
  return out;
}

function run(cmd: string[], cwd?: string, timeout?: number): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", ...(timeout ? { timeout } : {}) });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

function must(cmd: string[], cwd?: string): string {
  const r = run(cmd, cwd);
  if (r.code !== 0) throw new Stop(`${cmd.slice(0, 3).join(" ")} failed: ${r.err.trim().split("\n").pop() ?? r.code}`);
  return r.out;
}

/** every file under the kept paths in `dir`, relative to it */
function keptFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) for (const name of readdirSync(abs)) walk(join(rel, name));
    else out.push(rel);
  };
  for (const p of FLOORPLAN_KEPT) walk(p);
  return out;
}

const read = (path: string): Uint8Array | null => (existsSync(path) ? new Uint8Array(readFileSync(path)) : null);

/** the snapshot of upstream at `commit`, unpacked into `dir` */
function unpack(repo: string, commit: string, dir: string, tar: string): void {
  mkdirSync(dir, { recursive: true });
  must(["git", "-C", repo, "archive", "--format=tar", "-o", tar, commit]);
  must(["tar", "-xf", tar, "-C", dir]);
}

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
  if (r.code !== 0) throw new Stop(`could not ask ${upstream} for its releases: ${r.err.trim().split("\n").pop() || `git exited ${r.code}`}`);
  const newest = newestRelease(releaseTagNames(r.out));
  if (!newest) throw new Stop(`${upstream} has no release tags`);
  if (compareVersions(newest.version, have) > 0) {
    say(`Floorplan ${newest.version} is out and canopy has ${have}: run the task floorplan-update (bun run floorplan:update)`);
    return 1;
  }
  say(`canopy has Floorplan ${have}, the newest release`);
  return 0;
}

function main(args: Args): number {
  const lib = join(args.root, "lib/floorplan");
  const vendorPath = join(lib, "VENDOR.md");
  const constPath = join(args.root, "src/core/floorplan.ts");
  const vendorMd = readFileSync(vendorPath, "utf8");
  const pin = readPin(vendorMd);
  if (!pin) throw new Stop("lib/floorplan/VENDOR.md has no line naming the release and commit");
  if (args.check) return check(args.upstream, pin.version);

  const dirty = must(["git", "-C", args.root, "status", "--porcelain", "--", "lib/floorplan", "src/core/floorplan.ts"]).trim();
  if (dirty) throw new Stop(`lib/floorplan or src/core/floorplan.ts has uncommitted changes; commit or drop them first:\n${dirty}`);

  const tmp = mkdtempSync(join(tmpdir(), "floorplan-update-"));
  try {
    const repo = join(tmp, "upstream");
    say(`fetching ${args.upstream}…`);
    must(["git", "clone", "--quiet", "--no-checkout", args.upstream, repo]);

    let target: string;
    let label: string;
    if (args.ref) {
      const ref = args.ref;
      const hit = [ref, `origin/${ref}`].map((r) => run(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `${r}^{commit}`])).find((r) => r.code === 0);
      if (!hit) throw new Stop(`upstream has no tag, branch or commit called ${ref}`);
      target = hit.out.trim();
      label = ref;
    } else {
      const newest = newestRelease(must(["git", "-C", repo, "tag", "--list"]).split("\n"));
      if (!newest) throw new Stop("upstream has no release tags; name one with --ref");
      target = must(["git", "-C", repo, "rev-parse", `${newest.tag}^{commit}`]).trim();
      label = newest.tag;
    }
    if (run(["git", "-C", repo, "cat-file", "-e", `${pin.commit}^{commit}`]).code !== 0) {
      throw new Stop(`upstream no longer has the pinned commit ${pin.commit}, so canopy's edits have no base to merge from; follow VENDOR.md by hand`);
    }

    if (target === pin.commit) {
      say(`canopy has Floorplan ${pin.version} (${pin.commit.slice(0, 8)}), which is ${label}; nothing to pull`);
      return 0;
    }
    const tar = join(tmp, "snap.tar");
    const before = join(tmp, "before");
    const after = join(tmp, "after");
    unpack(repo, pin.commit, before, tar);
    unpack(repo, target, after, tar);
    const plugin: unknown = JSON.parse(readFileSync(join(after, ".claude-plugin/plugin.json"), "utf8"));
    const version = typeof plugin === "object" && plugin && "version" in plugin && typeof plugin.version === "string" ? plugin.version : null;
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Stop(`${label} has no x.y.z version in .claude-plugin/plugin.json`);

    const back = compareVersions(version, pin.version) < 0;
    say(`Floorplan ${pin.version} (${pin.commit.slice(0, 8)}) → ${version} (${target.slice(0, 8)}, ${label})${back ? ", an older release" : ""}`);

    const ours = new Set(
      must(["git", "-C", args.root, "ls-files", "--", "lib/floorplan"])
        .split("\n")
        .filter(Boolean)
        .map((f) => relative("lib/floorplan", f))
        .filter((f) => !(FLOORPLAN_OWN as readonly string[]).includes(f)),
    );
    const paths = [...new Set([...keptFiles(before), ...keptFiles(after), ...ours])].sort();
    const done: { path: string; step: Exclude<FileStep, "same">; note?: string }[] = [];
    for (const path of paths) {
      const base = read(join(before, path));
      const mine = read(join(lib, path));
      const theirs = read(join(after, path));
      const step = planFile(base, mine, theirs);
      const dest = join(lib, path);
      if (step === "same") continue;
      if ((step === "add" || step === "take") && theirs) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, theirs);
      } else if (step === "remove") rmSync(dest);
      else if (step === "merge") {
        const merged = run(["git", "merge-file", "-p", "-L", "canopy", "-L", `floorplan ${pin.version}`, "-L", `floorplan ${version}`, dest, join(before, path), join(after, path)]);
        if (merged.code < 0 || merged.code > 127) throw new Stop(`git merge-file failed on ${path}: ${merged.err.trim()}`);
        writeFileSync(dest, merged.out);
        if (merged.code > 0) {
          done.push({ path, step: "conflict", note: `${merged.code} conflict${merged.code === 1 ? "" : "s"} marked in the file` });
          continue;
        }
      } else if (step === "conflict") {
        const why = base === null ? "both sides added it" : theirs === null ? "upstream removed it and canopy edits it" : "canopy removed it and upstream changed it";
        done.push({ path, step, note: `${why}; canopy's side is left as it was` });
        continue;
      }
      done.push({ path, step });
    }

    writeFileSync(vendorPath, writePin(vendorMd, { version, commit: target, date: must(["git", "-C", repo, "log", "-1", "--format=%cs", target]).trim() }));
    writeFileSync(constPath, writeVersionConst(readFileSync(constPath, "utf8"), version));

    say();
    say(done.length ? "files:" : "no file under lib/floorplan changed");
    for (const d of done) say(`  ${WORDS[d.step]}  ${d.path}${d.note ? `  (${d.note})` : ""}`);
    say(`  moved the pin in lib/floorplan/VENDOR.md and FLOORPLAN_VERSION to ${version}`);

    const fresh = newAddresses(textAddresses(before, keptFiles(before)), textAddresses(after, keptFiles(after)));
    say();
    if (fresh.length) {
      say("web addresses this release adds; check none of them sends data off the machine (VENDOR.md, step 3):");
      for (const a of fresh) say(`  ${a}`);
    } else say("this release adds no web address to the kept files");

    const changelog = read(join(after, "CHANGELOG.md"));
    const lines = changelog ? changelogHeadlines(new TextDecoder().decode(changelog), back ? version : pin.version, back ? pin.version : version) : [];
    if (lines.length) {
      say();
      say("what changed upstream (CHANGELOG.md):");
      for (const l of lines) say(`  ${l}`);
    }

    let failed = done.some((d) => d.step === "conflict");
    if (args.test) {
      say();
      say("running canopy's Floorplan tests…");
      const t = run(["bun", "test", "src/core/floorplan.test.ts", "src/core/floorplanvendor.test.ts", "src/server/floorplan.test.ts", "src/server/floorplan-route.test.ts"], args.root);
      const tail = `${t.out}\n${t.err}`.trim().split("\n").filter((l) => /^\s*\d+ (pass|fail)$|^\(fail\)/.test(l));
      for (const l of tail) say(`  ${l.trim()}`);
      if (t.code !== 0) failed = true;
    }

    say();
    if (failed) say("not done: resolve the conflicts or failures above. `git checkout -- lib/floorplan src/core/floorplan.ts` drops this run.");
    say("left for a person: read the diff (`git diff lib/floorplan`), check SKILL.md's steps against floorplanTask in src/core/floorplan.ts (VENDOR.md, step 5), then commit. Maps built before need an update before canopy starts their server again.");
    return failed ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  process.exit(main(parseArgs(process.argv.slice(2))));
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  process.stderr.write(`floorplan:update: ${e.message}\n`);
  process.exit(2);
}

/**
 * bun run understand:update [--ref TAG|BRANCH|COMMIT] [--no-test]
 * bun scripts/understand-update.ts --check
 *
 * Pulls a newer Understand-Anything into lib/understand-anything and merges
 * canopy's own edits into it, as floorplan:update does for Floorplan.
 * canopy's panel lists it as the task understand-update.
 *
 * It clones upstream, takes its newest release tag (vX.Y.Z) or --ref, and
 * goes through upstream's plugin folder and LICENSE one file at a time,
 * leaving out what VENDOR.md says canopy leaves out: a file canopy never
 * changed becomes upstream's new one, and a file canopy edited (today the
 * plugin's package.json and the viewer's viewer.mjs) gets a three-way
 * merge, `git merge-file` with the pinned commit as the base. Then it moves
 * the pin in VENDOR.md and UNDERSTAND_VERSION, refreshes canopy's bun.lock
 * when a package.json moved, lists the web addresses the release adds and
 * upstream's commit subjects since the pin, and runs canopy's
 * Understand-Anything tests with the live one on, which installs and
 * builds the new copy and scans a repo with it. It commits nothing, and it
 * refuses to start while lib/understand-anything or src/core/understand.ts
 * hold uncommitted changes, so a `git checkout` of those two undoes a run.
 *
 * --check only asks upstream for its tags and says in one line whether a
 * newer release is out, exiting 1 when one is. canopy's own health check
 * `understand` (.canopy/health.json) runs it every six hours, by the
 * script's path, since `bun run` echoes the command on stderr and a command
 * check shows its last line.
 *
 * Exit: 0 when updated or already current, 1 when a merge conflicted or the
 * tests failed (with --check, when a newer release is out), 2 when it could
 * not run. --root and --upstream point it at another checkout and another
 * source; the tests use them.
 * Bun: spawns git, tar and bun.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { addressesIn, compareVersions, isText, newAddresses, newestRelease, planFile, readPin, releaseTagNames, writePin, type FileStep } from "../src/core/floorplanvendor";
import { UNDERSTAND_OWN, UNDERSTAND_PLUGIN_DIR, UNDERSTAND_UPSTREAM, localPath, upstreamPath, writeVersionConst } from "../src/core/understandvendor";

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
  const out: Args = { root: join(import.meta.dir, ".."), upstream: UNDERSTAND_UPSTREAM, ref: null, test: true, check: false };
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
    else throw new Stop(`unknown argument ${a}; usage: bun run understand:update [--ref TAG|BRANCH|COMMIT] [--no-test] | --check`);
  }
  return out;
}

function run(cmd: string[], cwd?: string, timeout?: number, env?: Record<string, string>): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", ...(timeout ? { timeout } : {}), ...(env ? { env: { ...process.env, ...env } } : {}) });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

function must(cmd: string[], cwd?: string): string {
  const r = run(cmd, cwd);
  if (r.code !== 0) throw new Stop(`${cmd.slice(0, 3).join(" ")} failed: ${r.err.trim().split("\n").pop() ?? r.code}`);
  return r.out;
}

/** every file of a snapshot canopy keeps, by its path in canopy's copy */
function keptFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) for (const name of readdirSync(abs)) walk(rel ? join(rel, name) : name);
    else {
      const local = localPath(rel);
      if (local !== null) out.push(local);
    }
  };
  walk("");
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
    const bytes = read(join(dir, upstreamPath(f)));
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
    say(`Understand-Anything ${newest.version} is out and canopy has ${have}: run the task understand-update (bun run understand:update)`);
    return 1;
  }
  say(`canopy has Understand-Anything ${have}, the newest release`);
  return 0;
}

function main(args: Args): number {
  const lib = join(args.root, "lib/understand-anything");
  const vendorPath = join(lib, "VENDOR.md");
  const constPath = join(args.root, "src/core/understand.ts");
  const vendorMd = readFileSync(vendorPath, "utf8");
  const pin = readPin(vendorMd);
  if (!pin) throw new Stop("lib/understand-anything/VENDOR.md has no line naming the release and commit");
  if (args.check) return check(args.upstream, pin.version);

  const dirty = must(["git", "-C", args.root, "status", "--porcelain", "--", "lib/understand-anything", "src/core/understand.ts"]).trim();
  if (dirty) throw new Stop(`lib/understand-anything or src/core/understand.ts has uncommitted changes; commit or drop them first:\n${dirty}`);

  const tmp = mkdtempSync(join(tmpdir(), "understand-update-"));
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
      say(`canopy has Understand-Anything ${pin.version} (${pin.commit.slice(0, 8)}), which is ${label}; nothing to pull`);
      return 0;
    }

    const tar = join(tmp, "snap.tar");
    const before = join(tmp, "before");
    const after = join(tmp, "after");
    unpack(repo, pin.commit, before, tar);
    unpack(repo, target, after, tar);
    const plugin: unknown = JSON.parse(readFileSync(join(after, UNDERSTAND_PLUGIN_DIR, ".claude-plugin/plugin.json"), "utf8"));
    const version = typeof plugin === "object" && plugin && "version" in plugin && typeof plugin.version === "string" ? plugin.version : null;
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Stop(`${label} has no x.y.z version in ${UNDERSTAND_PLUGIN_DIR}/.claude-plugin/plugin.json`);
    const back = compareVersions(version, pin.version) < 0;
    say(`Understand-Anything ${pin.version} (${pin.commit.slice(0, 8)}) → ${version} (${target.slice(0, 8)}, ${label})${back ? ", an older release" : ""}`);

    const ours = new Set(
      must(["git", "-C", args.root, "ls-files", "--", "lib/understand-anything"])
        .split("\n")
        .filter(Boolean)
        .map((f) => relative("lib/understand-anything", f))
        .filter((f) => !(UNDERSTAND_OWN as readonly string[]).includes(f)),
    );
    const paths = [...new Set([...keptFiles(before), ...keptFiles(after), ...ours])].sort();
    const done: { path: string; step: Exclude<FileStep, "same">; note?: string }[] = [];
    for (const path of paths) {
      const from = upstreamPath(path);
      const base = read(join(before, from));
      const mine = read(join(lib, path));
      const theirs = read(join(after, from));
      const step = planFile(base, mine, theirs);
      const dest = join(lib, path);
      if (step === "same") continue;
      if ((step === "add" || step === "take") && theirs) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, theirs);
      } else if (step === "remove") rmSync(dest);
      else if (step === "merge") {
        const merged = run(["git", "merge-file", "-p", "-L", "canopy", "-L", `understand-anything ${pin.version}`, "-L", `understand-anything ${version}`, dest, join(before, from), join(after, from)]);
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
    say(done.length ? "files:" : "no file under lib/understand-anything changed");
    for (const d of done) say(`  ${WORDS[d.step]}  ${d.path}${d.note ? `  (${d.note})` : ""}`);
    say(`  moved the pin in lib/understand-anything/VENDOR.md and UNDERSTAND_VERSION to ${version}`);

    let failed = done.some((d) => d.step === "conflict");
    if (!failed && done.some((d) => d.path === "package.json" || d.path.endsWith("/package.json"))) {
      const lock = run(["bun", "install", "--lockfile-only", "--ignore-scripts"], lib, 300_000);
      if (lock.code === 0) say("  refreshed bun.lock, since a package.json moved");
      else {
        failed = true;
        say(`  could not refresh bun.lock: ${lock.err.trim().split("\n").pop() ?? lock.code}`);
      }
    }

    const fresh = newAddresses(textAddresses(before, keptFiles(before)), textAddresses(after, keptFiles(after)));
    say();
    if (fresh.length) {
      say("web addresses this release adds; check none of them sends data off the machine (VENDOR.md, step 4):");
      for (const a of fresh) say(`  ${a}`);
    } else say("this release adds no web address to the kept files");

    const log = run(["git", "-C", repo, "log", "--no-merges", "--format=%s", back ? `${target}..${pin.commit}` : `${pin.commit}..${target}`, "--", UNDERSTAND_PLUGIN_DIR]).out.trim().split("\n").filter(Boolean);
    if (log.length) {
      say();
      say(`what changed upstream in the plugin (${log.length} commit${log.length === 1 ? "" : "s"}${log.length > 30 ? ", the newest 30" : ""}):`);
      for (const l of log.slice(0, 30)) say(`  - ${l}`);
    }

    if (args.test) {
      say();
      say("running canopy's Understand-Anything tests, the live one included (it installs and builds the new copy)…");
      const t = run(
        ["bun", "test", "src/core/understand.test.ts", "src/core/understandvendor.test.ts", "src/server/understand.test.ts", "src/server/understand-route.test.ts", "src/cli/understand.test.ts"],
        args.root,
        900_000,
        { CANOPY_UNDERSTAND_IT: "1" },
      );
      const tail = `${t.out}\n${t.err}`.trim().split("\n").filter((l) => /^\s*\d+ (pass|fail|skip)$|^\(fail\)/.test(l));
      for (const l of tail) say(`  ${l.trim()}`);
      if (t.code !== 0) failed = true;
    }

    say();
    if (failed) say("not done: resolve the conflicts or failures above. `git checkout -- lib/understand-anything src/core/understand.ts` drops this run.");
    say("left for a person: read the diff (`git diff lib/understand-anything`), check skills/understand/SKILL.md against understandTask in src/core/understand.ts (VENDOR.md, step 5), then commit. Each backend prepares the new copy on its next graph run or open.");
    return failed ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  process.exit(main(parseArgs(process.argv.slice(2))));
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  process.stderr.write(`understand:update: ${e.message}\n`);
  process.exit(2);
}

import { libraryCommand } from "../core/library";
import { realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, join, resolve } from "node:path";
import { exec } from "../core/exec";
import { commit, getStatus, pull, push } from "../core/git";
import { isOpenerId, openGroup, openIn, type OpenerId } from "../core/openers";
import { isSshHost } from "../core/host";
import { buildKey, isSafeTag } from "../core/launch";
import { Launcher, LauncherError, type LaunchRepo } from "../core/launcher";
import {
  currentBranch,
  gateCommand,
  initRepo,
  seedRepo,
  serveList,
  serveSeed,
  serveSeeds,
  syncAll,
  takeWip,
  trackBranch,
} from "../core/peersync";
import { DEFAULT_IGNORE, launchSource, scan, scanSource } from "../core/scan";
import {
  addSource,
  agentFor,
  launchFor,
  loadConfig,
  loadConfigReadOnly,
  removeSource,
  removeWorkspace,
  setLaunch,
  upsertWorkspace,
} from "../core/store";
import { effectivePrimary, type Job, type LaunchSettings, type SourceInput, type SpecHalf, type Sprout, type SproutDetail } from "../core/types";
import { loadSpec, repoSpecState, syncRepo } from "../core/spec";
import { parsePick, pickRefusal, SEEDS_DIR } from "../core/sprout";
import { setSeedRoots } from "../core/seedgit";
import { mirrorRefusal } from "../core/seedmirror";
import { parseNewArgs, sproutLink } from "./newargs";
import { suggestMessage } from "../core/suggest";
import { PortUnavailableError, startServer } from "../server/index";
import { helperName, localOpeners, runHelper } from "../core/helperd";
import { readBuild } from "../core/build";
import { versionLine } from "../core/version";
import { bold, dim, lichen, moss, paintLine, renderTree, sky } from "./render";
import { HELP_TEXT } from "../core/help";
import { SPEC_WORDS, specLines } from "../core/treelines";

const HELP = `${bold("canopy")}${HELP_TEXT.slice("canopy".length)}`;

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
}

function appOpt(args: string[], fallback: OpenerId): OpenerId {
  const v = opt(args, "--app") ?? fallback;
  if (!isOpenerId(v)) {
    console.error(`unknown app: ${v} (use kitty, terminal, code, finder, agent, or herdr)`);
    process.exit(1);
  }
  return v;
}

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

/** Same scan settings the server uses, so both honour config `ignore`/`maxDepth`. */
async function scanOpts(): Promise<{ maxDepth: number; ignore: string[] }> {
  const cfg = await loadConfig();
  return { maxDepth: cfg.maxDepth, ignore: [...DEFAULT_IGNORE, ...cfg.ignore] };
}


const COMMANDS = new Set([
  "new",
  "incubator",
  "library",
  "tree",
  "status",
  "ui",
  "helper",
  "commit",
  "suggest",
  "push",
  "pull",
  "open",
  "launch",
  "ws",
  "source",
  "sources",
  "peers",
  "spec",
  "help",
  "--help",
  "-h",
  "version",
  "--version",
  "-V",
]);

export async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  // Only a known verb is a command; anything else is the directory argument
  // to the default tree view (`canopy ~/dev`).
  const cmd =
    args[0] !== undefined && COMMANDS.has(args[0]) ? args.shift() : undefined;

  switch (cmd) {
    case "library": {
      const root = resolve(opt(args, "--root") ?? ".");
      process.exitCode = await libraryCommand(root, args);
      return;
    }
    case undefined:
    case "tree": {
      const root = resolve(args[0] ?? ".");
      console.log(renderTree(await scan(root, await scanOpts())));
      return;
    }
    case "status": {
      const root = resolve(args[0] ?? ".");
      console.log(
        renderTree(await scan(root, await scanOpts()), { dirtyOnly: true }),
      );
      return;
    }
    case "ui": {
      // A server something else restarts (launchd, a watcher) would open a
      // tab on every start; --no-open is for those.
      const noOpen = flag(args, "--no-open");
      const portArg = opt(args, "--port");
      if (portArg !== undefined && !/^\d+$/.test(portArg)) {
        return fail(`invalid --port: ${portArg}`);
      }
      const port = portArg === undefined ? undefined : Number(portArg);
      const root = resolve(args[0] ?? ".");
      const dir = args[0] ?? ".";
      let server: Awaited<ReturnType<typeof startServer>>;
      try {
        server = await startServer({ root, port });
      } catch (err) {
        if (!(err instanceof PortUnavailableError)) throw err;
        // Bun's own message ("Failed to start server. Is port N in use?")
        // states the problem and no way out of it. Bun also reports
        // EADDRINUSE when a low port merely needs root, so split the two here.
        const privileged = err.port < 1024 && process.getuid?.() !== 0;
        return fail(
          [
            privileged
              ? `port ${err.port} needs root — ports below 1024 are privileged.`
              : `port ${err.port} is already in use.`,
            ...(privileged
              ? []
              : [
                  `  something is listening there — it may be a canopy you already started:`,
                  `    http://127.0.0.1:${err.port}`,
                ]),
            `  pick another port:`,
            `    canopy ui ${dir} --port ${privileged ? 7850 : err.port + 10}`,
          ].join("\n"),
        );
      }
      const url = `http://127.0.0.1:${server.port}`;
      console.log(`${moss("canopy")} ${dim("→")} ${sky(url)} ${dim(`(root: ${root}, ${versionLine(readBuild())})`)}`);
      if (!noOpen) await exec(["open", url]);
      return; // keeps running — Bun.serve holds the process open
    }
    case "helper": {
      // The other half of a headless backend: this process dials it and runs
      // the desktop openers here for the browser on this machine. It keeps
      // running until stopped; a launchd or systemd user unit is the usual way.
      // Inside a canopy shell CANOPY_BACKEND is the backend's name (what the
      // agent hooks report), not an origin, so only an origin stands in for
      // --backend.
      const fromEnv = process.env["CANOPY_BACKEND"];
      const envOrigin = fromEnv && /^https?:\/\//.test(fromEnv) ? fromEnv : undefined;
      const backend = opt(args, "--backend") ?? envOrigin ?? "http://127.0.0.1:7850";
      if (!/^https?:\/\//.test(backend)) return fail(`--backend must be an http(s) origin, got ${backend}`);
      const name = opt(args, "--name") ?? helperName();
      const listed = opt(args, "--openers");
      let openers: OpenerId[];
      if (listed === undefined) openers = localOpeners();
      else {
        openers = [];
        for (const raw of listed.split(",")) {
          const v = raw.trim();
          if (v === "") continue;
          if (!isOpenerId(v)) return fail(`unknown opener in --openers: ${v}`);
          openers.push(v);
        }
      }
      const stamp = () => dim(new Date().toLocaleTimeString());
      const handle = runHelper({ backend, name, openers, log: (line) => console.log(`${stamp()} ${line}`) });
      console.log(`${moss("canopy helper")} ${dim("→")} ${sky(backend)} ${dim(`as ${name}: ${openers.join(", ") || "no openers"}`)}`);
      const bye = () => {
        handle.stop();
        process.exit(0);
      };
      process.on("SIGINT", bye);
      process.on("SIGTERM", bye);
      return; // keeps running — the socket holds the process open
    }
    case "commit": {
      // Strip flags first: otherwise `canopy commit --all <repo>` resolves
      // "--all" as the repo path.
      const all = flag(args, "--all");
      const doPush = flag(args, "--push");
      const ai = flag(args, "--ai");
      let message = opt(args, "-m") ?? opt(args, "--message");
      const repo = resolve(args[0] ?? fail("usage: canopy commit <repo>"));
      const st = await getStatus(repo);
      if (ai && !message) {
        const s = await suggestMessage(repo, st.files, agentFor(await loadConfig(), repo, "suggest"));
        message = s.message;
        console.log(`${dim(`message (${s.source}):`)} ${message}`);
      }
      if (!message) return fail("pass -m \"message\" or --ai");
      const staged = st.files.some((f) => f.index !== "." && !f.untracked);
      if (!staged && !all) {
        return fail("nothing staged — pass --all to stage everything");
      }
      console.log(await commit(repo, message, { stageAll: all }));
      if (doPush) console.log(await push(repo));
      return;
    }
    case "suggest": {
      const repo = resolve(args[0] ?? fail("usage: canopy suggest <repo>"));
      const st = await getStatus(repo);
      if (st.files.length === 0) return fail("no changes to describe");
      const s = await suggestMessage(repo, st.files, agentFor(await loadConfig(), repo, "suggest"));
      console.log(s.message);
      return;
    }
    case "push": {
      const repo = resolve(args[0] ?? fail("usage: canopy push <repo>"));
      console.log(await push(repo));
      return;
    }
    case "pull": {
      const repo = resolve(args[0] ?? fail("usage: canopy pull <repo>"));
      console.log(await pull(repo));
      return;
    }
    case "open": {
      const app = appOpt(args, "kitty");
      const repo = resolve(args[0] ?? fail("usage: canopy open <repo>"));
      // the repo's shell route from the UI applies here too
      await openIn(app, repo, agentFor(await loadConfig(), repo, "shell"));
      return;
    }
    case "launch": {
      const pr = opt(args, "--pr");
      const here = flag(args, "--here");
      const rmKey = opt(args, "--rm");
      const lines: Partial<LaunchSettings> = {};
      for (const [flagName, key] of [["--build", "build"], ["--run", "run"], ["--asset", "asset"], ["--open", "launch"]] as const) {
        const v = opt(args, flagName);
        if (v !== undefined) lines[key] = v;
      }
      const path = resolve(args.shift() ?? fail("usage: canopy launch <repo> [tag] [--pr N] [--here] [--rm build]"));
      const tag = args.shift();
      const repo: LaunchRepo = { id: path, name: path.split("/").pop() ?? path, path };
      if (Object.keys(lines).length) {
        const cfg = await loadConfig();
        await setLaunch(path, { ...launchFor(cfg, path), ...lines });
        console.log(`${moss("✓")} launch settings saved`);
        if (!tag && pr === undefined && !here && rmKey === undefined) return;
      }
      const settings = launchFor(await loadConfig(), path);
      // The job's lines go to the terminal as they come; `ended` resolves
      // with the job once it stops working.
      let seen = 0;
      let settle: ((job: Job) => void) | null = null;
      const ended = new Promise<Job>((r) => (settle = r));
      const launcher = new Launcher({
        onJob: (job) => {
          for (const line of job.lines.slice(seen)) console.log(dim(line));
          seen = job.lines.length;
          if (job.status !== "working") settle?.(job);
        },
        onJobGone: () => {},
        onBuilds: () => {},
      });
      const finish = async (job: Job) => {
        const done = await ended;
        if (done.status !== "done") return fail(`${job.title} ${done.status}${done.error ? `: ${done.error}` : ""}`);
        console.log(`${moss("✓")} ${job.title}`);
      };
      const launch = async (key: string) => {
        const b = await launcher.launch(repo, key, settings);
        console.log(`${moss("▶")} ${bold(b.label)} ${dim(b.what ?? "")} ${dim(`(${b.launches}× so far)`)}`);
      };
      try {
        if (rmKey !== undefined) {
          await launcher.remove(repo, rmKey);
          console.log(`${moss("✓")} removed ${rmKey}`);
          return;
        }
        if (pr !== undefined) {
          if (!/^\d+$/.test(pr)) return fail(`not a pull request number: ${pr}`);
          const key = buildKey({ kind: "pr", number: Number(pr) });
          await finish(await launcher.build(repo, { kind: "pr", number: Number(pr) }, settings));
          if (settings.run) await launch(key);
          else console.log(dim("no run line set; the worktree is built but not launched"));
          return;
        }
        if (here) {
          await finish(await launcher.build(repo, { kind: "local" }, settings));
          if (settings.run) await launch("local");
          return;
        }
        if (tag !== undefined) {
          if (!isSafeTag(tag)) return fail(`not a tag: ${tag}`);
          const key = buildKey({ kind: "release", tag });
          const have = (await launcher.builds(repo, settings)).some((b) => b.key === key);
          if (!have) await finish(await launcher.install(repo, tag, null, settings));
          await launch(key);
          return;
        }
        const builds = await launcher.builds(repo, settings);
        console.log(bold("builds here"));
        if (builds.length === 0) console.log(dim("  none — canopy launch <repo> <tag>, --pr N, or --here"));
        for (const b of builds) {
          const meta = [b.launches ? `${b.launches}×` : null, b.running ? sky("running") : null].filter(Boolean).join(" ");
          console.log(`  ${lichen("▸")} ${bold(b.label)} ${dim(b.what ?? "nothing launchable")} ${meta}`);
        }
        const [rels, pulls] = await Promise.all([
          launcher.releases(repo, settings).catch((e: unknown) => (e instanceof LauncherError ? e.message : String(e))),
          launcher.pulls(repo).catch((e: unknown) => (e instanceof LauncherError ? e.message : String(e))),
        ]);
        console.log(bold("releases"));
        if (typeof rels === "string") console.log(dim(`  ${rels}`));
        else if (rels.length === 0) console.log(dim("  none"));
        else {
          for (const r of rels.slice(0, 10)) {
            console.log(`  ${lichen("▸")} ${bold(r.tag)}${r.prerelease ? dim(" pre") : ""} ${dim(r.pick ?? "no asset for this machine")}`);
          }
        }
        console.log(bold("open pull requests"));
        if (typeof pulls === "string") console.log(dim(`  ${pulls}`));
        else if (pulls.length === 0) console.log(dim("  none"));
        else for (const p of pulls.slice(0, 10)) console.log(`  ${lichen("▸")} ${bold(`#${p.number}`)} ${p.title} ${dim(p.author)}`);
        return;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
    case "ws": {
      const sub = args.shift();
      if (!sub) {
        const cfg = await loadConfig();
        if (cfg.workspaces.length === 0) {
          console.log(dim("no workspaces yet — canopy ws create <name> <dirs...>"));
          return;
        }
        for (const w of cfg.workspaces) {
          console.log(`${bold(w.name)} ${dim(`(${w.repos.length})`)}`);
          for (const r of w.repos) console.log(`  ${lichen("▸")} ${r}`);
        }
        return;
      }
      if (sub === "create" || sub === "add") {
        const name = args.shift() ?? fail(`usage: canopy ws ${sub} <name> <dirs...>`);
        if (args.length === 0) return fail("list at least one repo dir");
        await upsertWorkspace(name, args.map((a) => resolve(a)));
        console.log(`${moss("✓")} workspace ${bold(name)} updated`);
        return;
      }
      if (sub === "rm") {
        const name = args.shift() ?? fail("usage: canopy ws rm <name> [dir]");
        await removeWorkspace(name, args[0] ? resolve(args[0]) : undefined);
        console.log(`${moss("✓")} removed`);
        return;
      }
      if (sub === "open") {
        const app = appOpt(args, "code");
        const name = args.shift() ?? fail("usage: canopy ws open <name>");
        const cfg = await loadConfig();
        const ws = cfg.workspaces.find((w) => w.name === name);
        if (!ws) return fail(`unknown workspace: ${name}`);
        await openGroup(app, name, ws.repos, (p) => agentFor(cfg, p), effectivePrimary(ws) ?? undefined);
        return;
      }
      return fail(`unknown ws command: ${sub}`);
    }
    case "source":
    case "sources": {
      const sub = args.shift();
      if (!sub) {
        const cfg = await loadConfig();
        if (cfg.sources.length === 0) {
          console.log(dim("no extra folders — canopy source add <dir> [--host h]"));
          return;
        }
        for (const s of cfg.sources) {
          const where = s.kind === "ssh" ? sky(`${s.host}:`) : "";
          const at = s.kind === "forgejo" ? `${sky("forgejo ")}${s.url}` : `${where}${s.path}`;
          console.log(`${bold(s.label)} ${dim(`(${s.id})`)}  ${at}`);
        }
        return;
      }
      if (sub === "add") {
        const host = opt(args, "--host");
        const label = opt(args, "--label");
        const forgejo = opt(args, "--forgejo");
        const token = opt(args, "--token");
        if (forgejo !== undefined) {
          const stored = await addSource({
            kind: "forgejo",
            url: forgejo,
            ...(token ? { tokenFile: token } : {}),
            ...(label ? { label } : {}),
          });
          console.log(
            `${moss("✓")} listing ${bold(stored.label)} ${dim(`(${stored.id})`)} from the next canopy ui`,
          );
          return;
        }
        const dir = args.shift() ?? fail("usage: canopy source add <dir> [--host h] [--label l]");
        let input: SourceInput;
        if (host !== undefined) {
          if (!isSshHost(host)) return fail(`not an ssh host alias: ${host}`);
          input = { kind: "ssh", host, path: dir, ...(label ? { label } : {}) };
        } else {
          input = { kind: "local", path: resolve(dir), ...(label ? { label } : {}) };
        }
        // Stored as given: the UI resolves and checks a path when it adds
        // one, and shows a scan error on the folder if this one is wrong.
        const stored = await addSource(input);
        console.log(`${moss("✓")} scanning ${bold(stored.label)} ${dim(`(${stored.id})`)} from the next canopy ui`);
        return;
      }
      if (sub === "rm") {
        const id = args.shift() ?? fail("usage: canopy source rm <id>");
        const left = await removeSource(id);
        console.log(`${moss("✓")} removed ${dim(`(${left.length} left)`)}`);
        return;
      }
      return fail(`unknown source command: ${sub}`);
    }
    case "peers": {
      const rootFlag = opt(args, "--root");
      const sub = args[0];
      if (sub === "gate") {
        // GIT_* is git's own env-config channel (GIT_CONFIG_PARAMETERS,
        // GIT_CONFIG_COUNT/KEY_n/VALUE_n, ...), never meant for this
        // process. Cleared before anything else runs: serveList/serveSeeds
        // call git() in-process (not through the explicit env the
        // upload-pack spawn gets below), so left in place they would
        // inherit whatever GIT_ vars this process had and let a peer who
        // can influence them set something like core.fsmonitor and have
        // git run it the moment ls-files touches the working tree.
        // GIT_PROTOCOL is kept aside first, since the upload-pack env below
        // still wants it.
        const gitProtocol = process.env["GIT_PROTOCOL"];
        for (const key of Object.keys(process.env)) {
          if (key.startsWith("GIT_")) delete process.env[key];
        }
        const rootArg = rootFlag ?? "dev";
        const home = process.env["HOME"] ?? "";
        const rootAbs = resolve(rootArg.startsWith("/") ? rootArg : join(home, rootArg));
        // Validate the command before anything else touches the config: a
        // refused command (a shell, a path outside the root) must stay
        // refused even when this machine's config is broken, not surface a
        // different failure depending on what it tried to read first.
        const cmd = gateCommand(process.env["SSH_ORIGINAL_COMMAND"] ?? "", rootAbs, home);
        if ("error" in cmd) return fail(`canopy-peer: ${cmd.error}`);
        // A seed's .git is written by agents, and upload-pack reads its
        // config, so the gate never opens one: gateCommand answers a seed
        // with canopy's mirror of it and refuses every other way in
        // (amendment 4, ruling 8). The guard's seeds roots are set as well,
        // as defense in depth for the git() calls serveList and serveSeeds
        // make in-process; neither makes one in a seed.
        const seedsAbs = join(rootAbs, SEEDS_DIR);
        let seedsReal = seedsAbs;
        try { seedsReal = await realpath(seedsAbs); } catch { /* no seeds yet */ }
        setSeedRoots(seedsReal === seedsAbs ? [seedsAbs] : [seedsAbs, seedsReal]);
        if (cmd.kind === "upload-pack" && cmd.mirror !== undefined) {
          const refused = await mirrorRefusal(rootAbs, cmd.mirror);
          if (refused) return fail(`canopy-peer: ${refused}`);
        }
        // Read-only: a peer's request must never write this machine's own
        // files, and loadConfig()'s quarantine-and-rename on bad JSON is
        // exactly such a write. A config that is present but unreadable or
        // invalid refuses every command rather than silently falling back to
        // defaults, which would serve peers nobody configured.
        const cfg = await loadConfigReadOnly();
        if (cfg === null) return fail("canopy-peer: config unreadable");
        try {
          if (cmd.kind === "upload-pack") {
            // Only what git-upload-pack itself needs, explicitly: passing
            // the whole environment through would also pass GIT_CONFIG_*
            // (git's own env-config channel), letting a peer who can
            // influence this process's environment set
            // uploadpack.packObjectsHook and have git-upload-pack run it.
            const env: Record<string, string> = {
              PATH: process.env["PATH"] ?? "",
              HOME: process.env["HOME"] ?? "",
            };
            if (gitProtocol !== undefined) env["GIT_PROTOCOL"] = gitProtocol;
            for (const name of ["LANG", "LC_ALL"] as const) {
              const v = process.env[name];
              if (v !== undefined) env[name] = v;
            }
            // a mirror is opened as itself, with no suffix probed past it
            const strict = cmd.mirror !== undefined ? ["--strict"] : [];
            const p = Bun.spawn(["git-upload-pack", ...strict, cmd.path], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
            const code = await p.exited;
            const n = p.signalCode ? osConstants.signals[p.signalCode] : undefined;
            process.exit(n !== undefined ? 128 + n : code);
          }
          if (cmd.kind === "list") console.log(JSON.stringify(await serveList(rootAbs, cfg.maxDepth)));
          if (cmd.kind === "seeds") console.log(JSON.stringify(await serveSeeds(rootAbs, cmd.id, cfg.seed)));
          if (cmd.kind === "seed") console.log(Buffer.from(await serveSeed(rootAbs, cmd.id, cmd.file, cfg.seed)).toString("base64"));
        } catch (err) {
          return fail(`canopy-peer: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      const cfg = await loadConfig();
      // Every subcommand but status and the gate itself needs the feature on
      // (or dry): status is a diagnostic ("is this configured at all?") and
      // the gate is what a peer's ssh key runs, unrelated to this machine's
      // own sync mode.
      if (cfg.peerSync === "off" && sub !== "status") {
        return fail("canopy: peer sync is off");
      }
      if (!cfg.self || cfg.peers.length === 0) {
        return fail("canopy: set self and peers in the config first (see docs/superpowers/specs/2026-09-23-peer-sync-design.md)");
      }
      const rootDir = await realpath(resolve(rootFlag ?? process.cwd()));
      const opts = { self: cfg.self, peers: cfg.peers, seed: cfg.seed, dry: cfg.peerSync !== "on", root: rootDir };
      // Repo ids under the launch root, read the same way the `tree` case
      // scans it. Only `init` and a bare `sync` need every id; the others
      // work on one repo the caller already named.
      const launchIds = async (): Promise<string[]> =>
        (await scanSource(launchSource(rootDir), { maxDepth: cfg.maxDepth, ignore: [...DEFAULT_IGNORE, ...cfg.ignore] })).map((r) => r.id);
      switch (sub) {
        case "init": {
          const ids = await launchIds();
          for (const id of ids) await initRepo(join(rootDir, id), id, cfg.peers, opts.dry);
          console.log(`${opts.dry ? "would set" : "set"} peer remotes in ${ids.length} repos`);
          return;
        }
        case "sync": {
          const only = args[1] && !args[1].startsWith("--") ? [args[1]] : await launchIds();
          const { states, seen, cloned, failed } = await syncAll(only, opts, 4);
          for (const s of seen) console.log(`${s.name}: ${s.ok ? "ok" : `offline (${s.error ?? ""})`}`);
          for (const c of cloned) console.log(`cloned ${c}`);
          for (const f of failed) console.log(`failed to clone ${f.id}: ${f.error}`);
          for (const [id, st] of states) {
            for (const m of st.moved) console.log(`${id}: ${m.branch} → ${m.to.slice(0, 8)} from ${m.peer}`);
            for (const w of st.would ?? []) console.log(`${id}: would move ${w.branch} → ${w.to.slice(0, 8)} from ${w.peer}`);
            for (const d of st.diverged) console.log(`${id}: ${d.branch} diverged from ${d.peer} (↑${d.behind} ↓${d.ahead})`);
            if (st.error) console.log(`${id}: ${st.error}`);
          }
          if (opts.dry) console.log(`peerSync is ${cfg.peerSync}: nothing was written`);
          return;
        }
        case "status": {
          console.log(`self: ${cfg.self}  sync: ${cfg.peerSync}`);
          for (const p of cfg.peers) console.log(`  ${p.name}  ${p.role}  ${p.alias}:${p.root}${p.repos ? `  (${p.repos.join(", ")})` : ""}`);
          return;
        }
        case "take": {
          const [, id, peer, branch] = args;
          if (!id || !peer) return fail("usage: canopy peers take <id> <peer> [branch]");
          const repo = join(rootDir, id);
          const resolvedBranch = branch ?? (await currentBranch(repo));
          if (!resolvedBranch) return fail("HEAD is detached; name a branch");
          const r = await takeWip(repo, peer, resolvedBranch);
          console.log(r.how === "files" ? "WIP checked out as uncommitted files" : `WIP is on branch ${r.branch}`);
          return;
        }
        case "track": {
          const [, id, peer, branch] = args;
          if (!id || !peer || !branch) return fail("usage: canopy peers track <id> <peer> <branch>");
          await trackBranch(join(rootDir, id), peer, branch);
          console.log(`${branch} now points at ${peer}/${branch}`);
          return;
        }
        case "seed": {
          const id = args[1];
          if (!id) return fail("usage: canopy peers seed <id>");
          const wrote = await seedRepo(join(rootDir, id), id, cfg.peers, cfg.seed, opts.dry);
          if (wrote.length === 0) console.log("nothing to seed");
          else console.log(`${opts.dry ? "would seed" : "seeded"} ${wrote.join(", ")}`);
          return;
        }
        default:
          return fail(`unknown peers command: ${sub}\n\nusage: canopy peers status|sync [id]|init|take|track|seed|gate`);
      }
    }
    case "spec": {
      const sub = args.shift() ?? "status";
      if (sub === "status") {
        const result = await scan(resolve(args[0] ?? "."), await scanOpts());
        const spec = await loadSpec();
        for (const line of specLines(spec.version, result.repos)) console.log(paintLine(line));
        return;
      }
      if (sub === "sync") {
        const visual = flag(args, "--visual");
        const doc = flag(args, "--doc");
        if (visual && doc) return fail("pass --visual or --doc, not both");
        const repo = resolve(args[0] ?? fail("usage: canopy spec sync <repo> [--visual | --doc]"));
        const halves: SpecHalf[] | undefined = visual ? ["doc", "visual"] : doc ? ["doc"] : undefined;
        const { written, record } = await syncRepo(repo, halves ? { halves } : {});
        console.log(`spec v${record.version} (${record.halves.join(" + ")}): ${written.length ? `wrote ${written.join(", ")}` : "already in sync"}`);
        return;
      }
      if (sub === "check") {
        const state = await repoSpecState(resolve(args[0] ?? "."));
        if (state === "in-sync") {
          console.log(SPEC_WORDS[state]);
          return;
        }
        return fail(state === undefined ? "could not read the repo's spec record" : SPEC_WORDS[state]);
      }
      return fail("usage: canopy spec status [dir] | sync <repo> [--visual | --doc] | check [repo]");
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "new": {
      const parsed = parseNewArgs(args, process.env);
      if ("error" in parsed) return fail(parsed.error);
      const form = new FormData();
      if (parsed.text) form.append("text", parsed.text);
      for (const u of parsed.urls) form.append("url", u);
      if (parsed.repo) form.append("repo", parsed.repo);
      for (const path of parsed.files) {
        const f = Bun.file(path);
        if (!(await f.exists())) return fail(`no such file: ${path}`);
        form.append("file", new File([await f.arrayBuffer()], basename(path), { type: f.type }), basename(path));
      }
      form.append("via", "cli");
      let res: Response;
      try {
        res = await fetch(`${parsed.backend}/api/incubator`, { method: "POST", body: form });
      } catch (err) {
        return fail(`${parsed.backend} did not answer: ${err instanceof Error ? err.message : String(err)}`);
      }
      const body = (await res.json().catch(() => ({}))) as Partial<Sprout> & { error?: string };
      if (!res.ok || !body.id) return fail(body.error ?? `the backend answered ${res.status}`);
      console.log(`${moss(body.id)} ${body.title ?? ""}`);
      console.log(sky(sproutLink(parsed.backend, body.id)));
      return;
    }
    case "incubator": {
      const backend = (opt(args, "--backend") ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
      if (!/^https?:\/\/[^/\s]+$/.test(backend)) return fail(`--backend must be an http(s) origin, got ${backend}`);
      const get = async <T>(path: string): Promise<T> => {
        let res: Response;
        try {
          res = await fetch(`${backend}${path}`);
        } catch (err) {
          return fail(`${backend} did not answer: ${err instanceof Error ? err.message : String(err)}`);
        }
        // The body is the server's JSON; an error body carries { error }.
        const body = (await res.json().catch(() => ({}))) as T & { error?: string };
        if (!res.ok) return fail(body.error ?? `the backend answered ${res.status}`);
        return body;
      };
      const sub = args[0] ?? "list";
      if (sub === "list") {
        const list = await get<Sprout[]>("/api/incubator");
        if (list.length === 0) console.log(dim("nothing in the incubator"));
        for (const s of list) {
          const why = s.parked ? dim(` (${s.parked})`) : s.questions?.length ? dim(` (${s.questions.length} questions waiting)`) : "";
          console.log(`${moss(s.id)}  ${s.status.padEnd(11)} ${s.title}${why}`);
        }
        return;
      }
      if (sub === "show") {
        const id = args[1];
        if (!id) return fail("usage: canopy incubator show <id>");
        const d = await get<SproutDetail>(`/api/incubator/one?id=${encodeURIComponent(id)}`);
        const s = d.sprout;
        console.log(`${bold(s.title)} ${dim(s.repoId)}`);
        console.log(`${s.status}${s.parked ? `: ${s.parked}` : ""}`);
        console.log(dim(`${s.spent.runs} runs, ${Math.round(s.spent.workMs / 60_000)} min of agent work`));
        if (d.intent) console.log(`\n${d.intent.trim()}`);
        console.log(`\n${d.inputsIndex.trim()}`);
        console.log(`\n${sky(sproutLink(backend, s.id))}`);
        return;
      }
      if (sub === "pick-check") {
        // run by scout's check in the seed: what canopy will read after scout, read now
        const pickFile = Bun.file(".canopy/pick.json");
        if (!(await pickFile.exists())) return fail(".canopy/pick.json is missing: research ends by writing it");
        const parsed = parsePick(await pickFile.text());
        if (!parsed.ok) return fail(`.canopy/pick.json: ${parsed.error}`);
        const refused = pickRefusal(parsed.pick);
        if (refused) return fail(`.canopy/pick.json: ${refused}`);
        if (!(await Bun.file(".canopy/research.md").exists())) return fail(".canopy/research.md is missing: research writes it before the pick");
        console.log(`pick ok: ${parsed.pick.kind} on ${parsed.pick.host}`);
        return;
      }
      return fail("usage: canopy incubator list | show <id> | pick-check");
    }
    case "version":
    case "--version":
    case "-V":
      console.log(`canopy ${versionLine(readBuild())}`);
      return;
    default:
      return fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

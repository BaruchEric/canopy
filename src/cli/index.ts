import { resolve } from "node:path";
import { exec } from "../core/exec";
import { commit, getStatus, pull, push } from "../core/git";
import { isOpenerId, openGroup, openIn, type OpenerId } from "../core/openers";
import { DEFAULT_IGNORE, scan } from "../core/scan";
import {
  loadConfig,
  removeWorkspace,
  upsertWorkspace,
} from "../core/store";
import { suggestMessage } from "../core/suggest";
import { startServer } from "../server/index";
import { bold, dim, lichen, moss, renderTree, sky } from "./render";

const HELP = `${bold("canopy")} — multi-repo git cockpit

usage:
  canopy [dir]                       tree of every repo under dir (default: .)
  canopy status [dir]                only repos that need attention
  canopy ui [dir] [--port N]        start the web UI and open the browser
  canopy commit <repo> -m "msg"     commit staged changes
  canopy commit <repo> --ai [--all] [--push]   AI message; --all stages everything
  canopy suggest <repo>              print an AI-suggested commit message
  canopy push <repo> | pull <repo>
  canopy open <repo> [--app kitty|terminal|code|finder]
  canopy ws                          list workspaces
  canopy ws create <name> <dirs...>  group repos into a workspace
  canopy ws add <name> <dirs...>
  canopy ws rm <name> [dir]          remove a repo, or the whole workspace
  canopy ws open <name> [--app code|kitty|terminal|finder]
`;

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
    console.error(`unknown app: ${v} (use kitty, terminal, code, or finder)`);
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
  "tree",
  "status",
  "ui",
  "commit",
  "suggest",
  "push",
  "pull",
  "open",
  "ws",
  "help",
  "--help",
  "-h",
]);

export async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  // Only a known verb is a command; anything else is the directory argument
  // to the default tree view (`canopy ~/dev`).
  const cmd =
    args[0] !== undefined && COMMANDS.has(args[0]) ? args.shift() : undefined;

  switch (cmd) {
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
      const portArg = opt(args, "--port");
      if (portArg !== undefined && !/^\d+$/.test(portArg)) {
        return fail(`invalid --port: ${portArg}`);
      }
      const port = portArg === undefined ? undefined : Number(portArg);
      const root = resolve(args[0] ?? ".");
      const server = await startServer({ root, port });
      const url = `http://127.0.0.1:${server.port}`;
      console.log(`${moss("canopy")} ${dim("→")} ${sky(url)} ${dim(`(root: ${root})`)}`);
      await exec(["open", url]);
      return; // keeps running — Bun.serve holds the process open
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
        const s = await suggestMessage(repo, st.files);
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
      const s = await suggestMessage(repo, st.files);
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
      await openIn(app, repo);
      return;
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
        await openGroup(app, name, ws.repos);
        return;
      }
      return fail(`unknown ws command: ${sub}`);
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      return fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

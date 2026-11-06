import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "./host";
import {
  attachArgs,
  captureArgs,
  hasArgs,
  historySizeArgs,
  isDuplicate,
  killArgs,
  labelArgs,
  placeArgs,
  listArgs,
  LIST_FORMAT,
  newSessionArgs,
  noServer,
  parseActivity,
  parseSessions,
  primeText,
  sessionId,
  sessionName,
  tmuxArgv,
  taskSessionArgs,
  pipeArgs,
  respawnArgs,
  interruptArgs,
  keysArgs,
  parseTaskPanes,
  taskCommand,
  setupFirst,
  BUN_SETUP,
  type TaskSetup,
  parsePane,
  textArgs,
  screenArgs,
  rangerSessionArgs,
  rangerPanesArgs,
  parseRangerPanes,
  RANGER_FORMAT,
} from "./tmux";

const ID = "0123456789abcdef0123456789abcdef";
const base = tmuxArgv("/opt/homebrew/bin/tmux", "/cfg/tmux.sock", "/app/lib/tmux.conf");

describe("session names", () => {
  test("a shell's session is its id under canopy's prefix, and back", () => {
    expect(sessionName(ID)).toBe(`canopy-${ID}`);
    expect(sessionId(`canopy-${ID}`)).toBe(ID);
  });
  test("a session canopy did not make has no shell", () => {
    expect(sessionId("main")).toBeNull();
    expect(sessionId("canopy-t1")).toBeNull();
    expect(sessionId(`other-${ID}`)).toBeNull();
  });
});

describe("argv", () => {
  test("every command runs on canopy's socket with its config", () => {
    expect(base).toEqual(["/opt/homebrew/bin/tmux", "-u", "-S", "/cfg/tmux.sock", "-f", "/app/lib/tmux.conf"]);
    expect(attachArgs(base, ID)).toEqual([...base, "attach-session", "-t", `canopy-${ID}`]);
    expect(killArgs(base, ID)).toEqual([...base, "kill-session", "-t", `canopy-${ID}`]);
    expect(listArgs(base)).toEqual([...base, "list-sessions", "-F", LIST_FORMAT]);
    expect(hasArgs(base, ID)).toEqual([...base, "has-session", "-t", `canopy-${ID}`]);
    expect(historySizeArgs(base, ID).slice(-4)).toEqual(["-p", "-t", `canopy-${ID}`, "#{history_size}"]);
    expect(captureArgs(base, ID, 500).slice(base.length)).toEqual([
      "capture-pane",
      "-p",
      "-e",
      "-J",
      "-t",
      `canopy-${ID}`,
      "-S",
      "-500",
      "-E",
      "-1",
    ]);
  });
  test("a local shell's session starts in its folder, sized, with the repo, place and path set", () => {
    const meta = { id: ID, repoId: "web-apps/ripe", path: "/Users/me/dev/web-apps/ripe", place: "panel" as const };
    const argv = newSessionArgs(base, meta, { cols: 132, rows: 40 }, ["/bin/zsh", "-l", "-i"]);
    expect(argv.slice(0, base.length)).toEqual(base);
    const rest = argv.slice(base.length);
    expect(rest.slice(0, 11)).toEqual([
      "new-session",
      "-d",
      "-s",
      `canopy-${ID}`,
      "-c",
      "/Users/me/dev/web-apps/ripe",
      "-x",
      "132",
      "-y",
      "40",
      "'/bin/zsh' '-l' '-i'",
    ]);
    // the options ride the same call, each after a separator tmux reads
    expect(rest.slice(11)).toEqual([
      ";",
      "set-option",
      "-t",
      `canopy-${ID}`,
      "@canopy_repo",
      "web-apps/ripe",
      ";",
      "set-option",
      "-t",
      `canopy-${ID}`,
      "@canopy_place",
      "panel",
      ";",
      "set-option",
      "-t",
      `canopy-${ID}`,
      "@canopy_path",
      "/Users/me/dev/web-apps/ripe",
    ]);
  });
  test("a handle and the env go into the session's environment", () => {
    const meta = {
      id: ID,
      repoId: "app",
      path: "/dev/app",
      place: "strip" as const,
      handle: "app-0123",
      env: { CANOPY_TERM: ID, CANOPY_BACKEND: "mini" },
    };
    const argv = newSessionArgs(base, meta, { cols: 80, rows: 24 }, ["/bin/bash"]);
    const at = argv.indexOf("-e");
    expect(argv.slice(at, at + 6)).toEqual(["-e", "TAILCHAN_AS=app-0123", "-e", `CANOPY_TERM=${ID}`, "-e", "CANOPY_BACKEND=mini"]);
    expect(argv[at + 6]).toBe("-x");
  });
  test("a remote shell's session is the ssh line, started here", () => {
    const meta = { id: ID, repoId: "wsl:app", path: "ssh://wsl/home/me/app", place: "strip" as const };
    const argv = newSessionArgs(base, meta, { cols: 80, rows: 24 }, ["ssh", "-t", "--", "wsl", "cd '/home/me/app' && exec \"$SHELL\" -l"]);
    expect(argv).not.toContain("-c");
    expect(argv[argv.indexOf("-y") + 2]).toBe(`'ssh' '-t' '--' 'wsl' 'cd '\\''/home/me/app'\\'' && exec "$SHELL" -l'`);
  });
});

describe("parseSessions", () => {
  test("reads canopy's sessions and skips the rest", () => {
    const out = [
      `canopy-${ID}\tweb-apps/ripe\tpanel\t1790000000\t/Users/me/dev/web-apps/ripe\t`,
      `main\t\t\t1790000001\t\t`,
      `canopy-${ID.replace(/0/g, "f")}\t\tstrip\t1790000002\t/x\t`,
      "",
    ].join("\n");
    expect(parseSessions(out)).toEqual([
      { id: ID, repoId: "web-apps/ripe", path: "/Users/me/dev/web-apps/ripe", place: "panel", createdAt: 1790000000000 },
    ]);
  });
  test("an unknown place is the strip; a bad time is now", () => {
    const before = Date.now();
    const [s] = parseSessions(`canopy-${ID}\tapp\twindow\tsoon\t/app\t`);
    expect(s?.place).toBe("strip");
    expect(s?.createdAt).toBeGreaterThanOrEqual(before);
  });
  test("nothing from nothing", () => {
    expect(parseSessions("")).toEqual([]);
  });
  test("a handle reads back when the session has one", () => {
    const [s] = parseSessions(`canopy-${ID}\tapp\tstrip\t1790000000\t/app\tapp-0123\t`);
    expect(s?.handle).toBe("app-0123");
  });
});

describe("a shell's tailchan handle", () => {
  test("rides the session's environment and an option", () => {
    const meta = { id: ID, repoId: "app", path: "/app", place: "strip" as const, handle: "app-0123" };
    const rest = newSessionArgs([], meta, { cols: 80, rows: 24 }, ["/bin/bash"]);
    expect(rest.slice(0, 8)).toEqual(["new-session", "-d", "-s", `canopy-${ID}`, "-c", "/app", "-e", "TAILCHAN_AS=app-0123"]);
    expect(rest.slice(-6)).toEqual([";", "set-option", "-t", `canopy-${ID}`, "@canopy_handle", "app-0123"]);
  });
  test("none, no -e and no option", () => {
    const rest = newSessionArgs([], { id: ID, repoId: "app", path: "/app", place: "strip" }, { cols: 80, rows: 24 }, ["/bin/bash"]);
    expect(rest).not.toContain("-e");
    expect(rest).not.toContain("@canopy_handle");
  });
});

describe("a shell's hand-given name", () => {
  test("set at the start, read back from the list", () => {
    const rest = newSessionArgs([], { id: ID, repoId: "app", path: "/app", place: "strip", label: "loot" }, { cols: 80, rows: 24 }, ["/bin/bash"]);
    expect(rest.slice(-6)).toEqual([";", "set-option", "-t", `canopy-${ID}`, "@canopy_label", "loot"]);
    const [s] = parseSessions(`canopy-${ID}\tapp\tstrip\t1790000000\t/app\t\t\tWeapons and loot`);
    expect(s?.label).toBe("Weapons and loot");
    expect(parseSessions(`canopy-${ID}\tapp\tstrip\t1790000000\t/app\t\t\t`)[0]?.label).toBeUndefined();
  });
  test("renamed later, or taken off with an empty name", () => {
    expect(labelArgs(base, ID, "maps")).toEqual([...base, "set-option", "-t", `canopy-${ID}`, "@canopy_label", "maps"]);
    expect(labelArgs(base, ID, "")).toEqual([...base, "set-option", "-u", "-t", `canopy-${ID}`, "@canopy_label"]);
  });
  test("moved to the strip or a panel later", () => {
    expect(placeArgs(base, ID, "panel")).toEqual([...base, "set-option", "-t", `canopy-${ID}`, "@canopy_place", "panel"]);
    const [s] = parseSessions(`canopy-${ID}\tapp\tpanel\t1790000000\t/app\t\t\t`);
    expect(s?.place).toBe("panel");
  });
});

describe("a pane's text for a copy", () => {
  test("the pane line says when a full-screen program is up", () => {
    expect(parsePane("2.1.285\t✳ fixing\t1\n")).toEqual({ command: "2.1.285", title: "✳ fixing", fullscreen: true });
    expect(parsePane("zsh\thost\t0")).toEqual({ command: "zsh", title: "host", fullscreen: false });
    expect(parsePane("zsh\thost")).toEqual({ command: "zsh", title: "host", fullscreen: false });
    // the pane's own pid, for the processes under it
    expect(parsePane("node\tapp\t0\t4242\n")).toEqual({ command: "node", title: "app", fullscreen: false, pid: 4242 });
    expect(parsePane("node\tapp\t0\tx")).toEqual({ command: "node", title: "app", fullscreen: false });
  });
  test("a plain shell copies its history, a full-screen one its screen alone", () => {
    expect(textArgs(base, ID, false, 50).slice(base.length)).toEqual([
      "capture-pane", "-p", "-J", "-t", sessionName(ID), "-S", "-50", "-E", "-",
    ]);
    expect(textArgs(base, ID, true).slice(base.length)).toEqual(["capture-pane", "-p", "-J", "-t", sessionName(ID)]);
    // a peek: the screen alone, colours kept, rows as the pane wraps them
    expect(screenArgs(base, ID).slice(base.length)).toEqual(["capture-pane", "-p", "-e", "-t", sessionName(ID)]);
  });
});

describe("what tmux said", () => {
  test("a duplicate session means the shell is there already", () => {
    expect(isDuplicate("duplicate session: canopy-abc")).toBe(true);
    expect(isDuplicate("can't find session")).toBe(false);
  });
  test("no server is not an error for a list", () => {
    expect(noServer("no server running on /cfg/tmux.sock")).toBe(true);
    expect(noServer("error connecting to /cfg/tmux.sock (No such file or directory)")).toBe(true);
    expect(noServer("bad option")).toBe(false);
  });
});

describe("primeText", () => {
  test("history lines become terminal lines, pushed off a screen of the client's rows", () => {
    expect(primeText("one\ntwo\n", 3)).toBe("one\r\ntwo\x1b[0m\r\n\r\n\r\n");
  });
  test("no history, nothing to send", () => {
    expect(primeText("", 24)).toBe("");
    expect(primeText("\n", 24)).toBe("");
  });
});

describe("tasks on tmux", () => {
  const base = ["tmux", "-S", "/s"];
  const meta = { id: "0123456789abcdef0123456789abcdef", repoId: "app", path: "/r/app", task: "dev" };
  const name = "canopy-0123456789abcdef0123456789abcdef";

  test("a task session holds a placeholder, carries its tags and keeps its pane when it dies", () => {
    expect(taskSessionArgs(base, meta, { cols: 120, rows: 32 })).toEqual([
      ...base, "new-session", "-d", "-s", name, "-c", "/r/app", "-x", "120", "-y", "32", "'sleep' '2147483647'",
      ";", "set-option", "-t", name, "@canopy_repo", "app",
      ";", "set-option", "-t", name, "@canopy_place", "strip",
      ";", "set-option", "-t", name, "@canopy_path", "/r/app",
      ";", "set-option", "-t", name, "@canopy_task", "dev",
      ";", "set-option", "-w", "-t", name, "remain-on-exit", "on",
    ]);
  });
  test("pipe, respawn and interrupt", () => {
    expect(pipeArgs(base, meta.id, "/c/it's.log")).toEqual([...base, "pipe-pane", "-t", name, "cat >> '/c/it'\\''s.log'"]);
    expect(respawnArgs(base, meta.id, ["sh", "-lc", "echo 'a b'"], "/r/app")).toEqual([
      ...base, "respawn-pane", "-k", "-t", name, "-c", "/r/app", "'sh' '-lc' 'echo '\\''a b'\\'''",
    ]);
    expect(respawnArgs(base, meta.id, ["ssh", "h"], null)).toEqual([...base, "respawn-pane", "-k", "-t", name, "'ssh' 'h'"]);
    expect(interruptArgs(base, meta.id)).toEqual([...base, "send-keys", "-t", name, "C-c"]);
  });
  test("the pane list keeps task panes only", () => {
    const out = [
      `${name}\tdev\tapp\t/r/app\t1\t3\t100`,
      `${name.replace("0123", "ffff")}\t\tapp\t/r/app\t0\t\t100`,
      `other\tdev\tapp\t/r/app\t0\t\t100`,
    ].join("\n");
    expect(parseTaskPanes(out)).toEqual([
      { termId: meta.id, task: "dev", repoId: "app", path: "/r/app", dead: true, code: 3, createdAt: 100_000 },
    ]);
  });
  test("a task command here cds to its folder first, elsewhere over ssh", () => {
    expect(taskCommand("/r/app", "bun run dev")).toEqual({ command: ["sh", "-c", "cd -- '/r/app' && BROWSER=none exec sh -lc 'bun run dev'"], dir: "/r/app" });
    expect(taskCommand("/r/app", "x", "ui")).toEqual({ command: ["sh", "-c", "cd -- '/r/app/ui' && BROWSER=none exec sh -lc 'x'"], dir: "/r/app/ui" });
    expect(taskCommand("ssh://mini/r/app", "x", "ui")).toEqual({
      command: ["ssh", "-t", "--", "mini", "cd '/r/app/ui' && BROWSER=none exec sh -lc 'x'"],
      dir: null,
    });
  });
  test("a setup line goes ahead of the command, checked at the checkout's root", () => {
    const { command } = taskCommand("ssh://mini/r/app", "bun run build", "ui", { line: "bun install" });
    expect(command[4]).toBe(`cd '/r/app/ui' && BROWSER=none exec sh -lc ${shellQuote(`${setupFirst("/r/app", { line: "bun install" })}\nbun run build`)}`);
    expect(setupFirst("/r/app", { line: "bun install" })).toContain("[ ! -d '/r/app'/node_modules ]; then");
    expect(setupFirst("/r/app", BUN_SETUP)).toContain("[ ! -d '/r/app'/node_modules ] && { [ -f '/r/app'/'bun.lock' ] || [ -f '/r/app'/'bun.lockb' ]; }; then");
  });
  test("a fresh checkout runs the setup line once, and a setup that fails ends the task", async () => {
    const root = await mkdtemp(join(tmpdir(), "canopy-setup-"));
    try {
      await mkdir(join(root, "ui"));
      await writeFile(join(root, "package.json"), "{}");
      const run = (cmd: string, setup: TaskSetup) => {
        const r = Bun.spawnSync(taskCommand(root, cmd, "ui", setup).command, { stdout: "pipe", stderr: "pipe" });
        return { code: r.exitCode, out: r.stdout.toString() };
      };
      // a trailing comment in the setup line must not swallow the rest
      const setup = { line: "mkdir node_modules && echo installed # from gates.json" };
      const first = run("echo built in $(basename \"$PWD\")", setup);
      expect(first.code).toBe(0);
      expect(first.out).toContain("canopy: no node_modules, so the setup line runs first");
      expect(first.out).toContain("installed");
      expect(first.out).toContain("built in ui");
      const again = run("echo built again", setup);
      expect(again.out).not.toContain("installed");
      expect(again.out).toContain("built again");
      await rm(join(root, "node_modules"), { recursive: true });
      const failed = run("echo should not run", { line: "exit 7" });
      expect(failed.code).toBe(7);
      expect(failed.out).not.toContain("should not run");
      // a setup that needs a lockfile waits for one
      const locked = { line: "mkdir node_modules && echo installed", ifAny: ["bun.lock", "bun.lockb"] };
      expect(run("echo plain", locked).out).not.toContain("installed");
      await writeFile(join(root, "bun.lockb"), "");
      expect(run("echo locked", locked).out).toContain("installed");
      // no package.json: nothing to install, the setup line never runs
      await rm(join(root, "node_modules"), { recursive: true });
      await rm(join(root, "package.json"));
      expect(run("echo plain", setup).out).not.toContain("installed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("the session list reads the task tag", () => {
    const line = `${name}\tapp\tstrip\t100\t/r/app\t\tdev`;
    expect(parseSessions(line)[0]?.task).toBe("dev");
    expect(parseSessions(`${name}\tapp\tstrip\t100\t/r/app\t\t`)[0]?.task).toBeUndefined();
  });
});

describe("the ranger's session", () => {
  const name = sessionName(ID);
  test("a placeholder kept on exit, marked as the ranger's and never as a shell or task", () => {
    expect(rangerSessionArgs(base, ID, "/home/eric/dev", { cols: 160, rows: 45 })).toEqual([
      ...base,
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      "/home/eric/dev",
      "-x",
      "160",
      "-y",
      "45",
      "'sleep' '2147483647'",
      ";",
      "set-option",
      "-t",
      name,
      "@canopy_ranger",
      "1",
      ";",
      "set-option",
      "-t",
      name,
      "@canopy_path",
      "/home/eric/dev",
      ";",
      "set-option",
      "-w",
      "-t",
      name,
      "remain-on-exit",
      "on",
    ]);
    // no repo option: the shell and task lists both pass over it
    expect(parseSessions(`${name}\t\tstrip\t100\t/home/eric/dev\t\t`)).toEqual([]);
    expect(parseTaskPanes(`${name}\t\t\t/home/eric/dev\t0\t\t100`)).toEqual([]);
  });
  test("the respawn carries its environment", () => {
    expect(respawnArgs(base, ID, ["bash", "-lic", "x"], "/d", { TAILCHAN_AS: "ranger" })).toEqual([...base, "respawn-pane", "-k", "-t", name, "-c", "/d", "-e", "TAILCHAN_AS=ranger", "'bash' '-lic' 'x'"]);
  });
  test("its list keeps the ranger's sessions with their exit and last output", () => {
    expect(rangerPanesArgs(base)).toEqual([...base, "list-sessions", "-F", RANGER_FORMAT]);
    const out = [`${name}\t1\t1\t0\t100\t160`, `${name.replace("0123", "ffff")}\t\t0\t\t100\t160`, `other\t1\t0\t\t100\t160`, `${name}\t1\t0\t\t100\t`].join("\n");
    expect(parseRangerPanes(out)).toEqual([
      { termId: ID, dead: true, code: 0, createdAt: 100_000, activityAt: 160_000 },
      { termId: ID, dead: false, code: null, createdAt: 100_000, activityAt: null },
    ]);
  });
});

test("keysArgs: named keys as they are, literal text after -l", () => {
  const base = ["tmux", "-S", "/s"];
  expect(keysArgs(base, "ab", ["Escape"])).toEqual([...base, "send-keys", "-t", sessionName("ab"), "Escape"]);
  expect(keysArgs(base, "ab", ["/exit"], true)).toEqual([...base, "send-keys", "-t", sessionName("ab"), "-l", "/exit"]);
});

describe("parseActivity", () => {
  test("parseActivity reads seconds into ms and skips junk", () => {
    expect(parseActivity("abc\t1729598400\nbad\tx\n")).toEqual(new Map([["abc", 1729598400000]]));
  });
});

describe("a task in a worktree", () => {
  test("its session carries the folder and the pane list reads it back", () => {
    const meta = { id: ID, repoId: "app", path: "/repo", task: "dev", tree: "/w/t1" };
    const args = taskSessionArgs(["tmux"], meta, { cols: 80, rows: 24 });
    expect(args.join(" ")).toContain("@canopy_worktree /w/t1");
    expect(taskSessionArgs(["tmux"], { ...meta, tree: undefined }, { cols: 80, rows: 24 }).join(" ")).not.toContain("@canopy_worktree");
    const [pane] = parseTaskPanes(`canopy-${ID}\tdev\tapp\t/repo\t0\t\t100\t/w/t1`);
    expect(pane?.tree).toBe("/w/t1");
    expect(parseTaskPanes(`canopy-${ID}\tdev\tapp\t/repo\t0\t\t100\t`)[0]?.tree).toBeUndefined();
  });
});

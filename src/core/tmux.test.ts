import { describe, expect, test } from "bun:test";
import {
  attachArgs,
  captureArgs,
  hasArgs,
  historySizeArgs,
  isDuplicate,
  killArgs,
  listArgs,
  LIST_FORMAT,
  newSessionArgs,
  noServer,
  parseSessions,
  primeText,
  sessionId,
  sessionName,
  tmuxArgv,
  taskSessionArgs,
  pipeArgs,
  respawnArgs,
  interruptArgs,
  parseTaskPanes,
  taskCommand,
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
  test("a task command here runs in its folder, elsewhere over ssh", () => {
    expect(taskCommand("/r/app", "bun run dev")).toEqual({ command: ["sh", "-lc", "bun run dev"], dir: "/r/app" });
    expect(taskCommand("/r/app", "x", "ui")).toEqual({ command: ["sh", "-lc", "x"], dir: "/r/app/ui" });
    expect(taskCommand("ssh://mini/r/app", "x", "ui")).toEqual({
      command: ["ssh", "-t", "--", "mini", "cd '/r/app/ui' && exec sh -lc 'x'"],
      dir: null,
    });
  });
  test("the session list reads the task tag", () => {
    const line = `${name}\tapp\tstrip\t100\t/r/app\t\tdev`;
    expect(parseSessions(line)[0]?.task).toBe("dev");
    expect(parseSessions(`${name}\tapp\tstrip\t100\t/r/app\t\t`)[0]?.task).toBeUndefined();
  });
});

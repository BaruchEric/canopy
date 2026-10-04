import { describe, expect, test } from "bun:test";
import { explainCommand, explainPrompt, splitShell, startsOutside } from "./explain";

const ROOT = "/home/me/dev/proj";

describe("startsOutside", () => {
  test("a request that runs or touches files outside the project, which no remembered rule answers", () => {
    expect(startsOutside({ tool: "Bash", title: "", command: "git push", cwd: "/tmp/elsewhere" }, ROOT)).toBe(true);
    expect(startsOutside({ tool: "Bash", title: "", command: "git push", cwd: `${ROOT}/sub` }, ROOT)).toBe(false);
    expect(startsOutside({ tool: "Bash", title: "", command: "git push" }, ROOT)).toBe(false);
    expect(startsOutside({ tool: "Edit", title: "", paths: ["/etc/hosts"] }, ROOT)).toBe(true);
    expect(startsOutside({ tool: "Edit", title: "", paths: [`${ROOT}/a.ts`] }, ROOT)).toBe(false);
    // no project folder to judge by (a remote repo): the server decides
    expect(startsOutside({ tool: "Bash", title: "", command: "ls", cwd: "/tmp" })).toBe(false);
  });
});

describe("splitShell", () => {
  test("splits on chains, pipes and newlines, keeping quoted text whole", () => {
    const cmds = splitShell(`ls -la src && cat "a; b.txt" | head -n 3\ngit status; echo 'x && y'`);
    expect(cmds.map((c) => c.words)).toEqual([
      ["ls", "-la", "src"],
      ["cat", "a; b.txt"],
      ["head", "-n", "3"],
      ["git", "status"],
      ["echo", "x && y"],
    ]);
  });

  test("redirects name what they write and read, and are not words", () => {
    const [c] = splitShell("sort < in.txt > out.txt 2>&1");
    expect(c?.words).toEqual(["sort"]);
    expect(c?.writes).toEqual(["out.txt"]);
    expect(c?.reads).toEqual(["in.txt"]);
    expect(splitShell("echo x 2>/dev/null >> log.txt")[0]?.writes).toEqual(["/dev/null", "log.txt"]);
  });

  test("a heredoc's body belongs to its command and is not parsed as commands", () => {
    const cmds = splitShell("python3 - <<'EOF'\nimport os; os.remove('x')\nrm -rf /\nEOF\nls");
    expect(cmds.map((c) => c.words)).toEqual([["python3", "-"], ["ls"]]);
    expect(cmds[0]?.heredoc).toBe("import os; os.remove('x')\nrm -rf /");
  });

  test("a command substitution's command is listed too", () => {
    const cmds = splitShell("echo $(git rev-parse HEAD) done");
    expect(cmds.map((c) => c.words[0])).toEqual(["echo", "git"]);
  });

  test("comments and line continuations", () => {
    expect(splitShell("ls \\\n  -la # list it\npwd").map((c) => c.words)).toEqual([["ls", "-la"], ["pwd"]]);
  });

  test("an unclosed quote takes the rest of the line rather than failing", () => {
    expect(splitShell("echo 'oops").map((c) => c.words)).toEqual([["echo", "oops"]]);
  });
});

describe("explainCommand", () => {
  const ex = (c: string, cwd?: string) => explainCommand(c, ROOT, cwd);

  test("lists files in a folder", () => {
    expect(ex("ls -la workspace/src")).toEqual({ says: "lists files in workspace/src", flags: [] });
  });

  test("reads several files as a count", () => {
    expect(ex("cat a.ts b.ts c.ts").says).toBe("reads 3 files");
    expect(ex("cat a.ts && head -n 5 b.ts").says).toBe("reads 2 files");
    expect(ex("cat README.md").says).toBe("reads README.md");
  });

  test("joins different steps in order", () => {
    expect(ex("ls src && cat a.ts | wc -l").says).toBe("lists files in src, reads a.ts and counts lines");
  });

  test("a Python snippet runs code, whatever the snippet says", () => {
    expect(ex("python3 - <<'EOF'\nprint(1)\nEOF")).toEqual({ says: "runs a Python snippet", flags: ["code"], opaque: true });
    expect(ex("python3 -c 'print(1)'").says).toBe("runs a Python snippet");
    expect(ex("node -e 'console.log(1)'").says).toBe("runs a Node snippet");
    expect(ex("python3 scripts/count.py")).toEqual({ says: "runs scripts/count.py with Python", flags: ["code"] });
  });

  test("a shell's -c script is read for what it runs", () => {
    expect(ex("bash -lc 'ls src; cat a.ts'").says).toBe("lists files in src and reads a.ts");
  });

  test("fetches count their URLs and say network; wget saves what it fetches", () => {
    expect(ex("curl -s https://a.com/x; curl https://b.com/y && curl https://c.com/z")).toEqual({
      says: "fetches 3 URLs",
      flags: ["network"],
    });
    expect(ex("wget https://c.com/z").flags).toEqual(["network", "writes"]);
    expect(ex("curl -X POST -d '{}' https://api.a.com/v1").says).toBe("sends a request to api.a.com");
    expect(ex("curl -sL https://example.com/api").says).toBe("fetches example.com");
    expect(ex("curl -o out.json https://a.com/x").flags).toEqual(["network", "writes"]);
  });

  test("git: commit with the identity it names, push with its remote", () => {
    expect(ex("git -c user.name=canopy -c user.email=c@x commit -m 'msg'")).toEqual({
      says: "commits to git as canopy",
      flags: ["commit"],
    });
    expect(ex("git add -A && git commit -m x").says).toBe("stages changes and commits to git");
    expect(ex("git push origin main")).toEqual({ says: "pushes to origin", flags: ["push", "network"] });
    expect(ex("git status --short && git log --oneline -5").says).toBe("reads git status and reads git history");
    expect(ex("git -C sub status").says).toBe("reads git status");
  });

  test("deletes say what they delete", () => {
    expect(ex("rm -rf build")).toEqual({ says: "deletes build", flags: ["deletes"] });
    expect(ex("rm a.txt b.txt").says).toBe("deletes 2 files");
    expect(ex("find . -name '*.tmp' -delete").flags).toContain("deletes");
  });

  test("writes through a redirect, tee, mkdir and touch", () => {
    expect(ex("echo hi > out.txt")).toEqual({ says: "writes out.txt", flags: ["writes"] });
    expect(ex("echo hi")).toEqual({ says: "prints text", flags: [] });
    expect(ex("echo hi 2>/dev/null").flags).toEqual([]);
    expect(ex("mkdir -p a/b && touch a/b/c").says).toBe("makes folder a/b and creates a/b/c");
    expect(ex("mkdir -p a/b").flags).toEqual(["writes"]);
  });

  test("outside the project: absolute paths, a cd away, a parent folder, the request's own folder", () => {
    expect(ex("cat /etc/hosts")).toEqual({ says: "reads /etc/hosts", flags: ["outside"] });
    expect(ex(`cat ${ROOT}/a.ts`)).toEqual({ says: "reads a.ts", flags: [] });
    expect(ex("cd /tmp && ls").flags).toEqual(["outside"]);
    expect(ex("ls ../other").flags).toEqual(["outside"]);
    expect(ex("ls", "/var/tmp").flags).toEqual(["outside"]);
    expect(ex("ls", `${ROOT}/src`).flags).toEqual([]);
    expect(ex("cat ~/.ssh/id_rsa").flags).toEqual(["outside"]);
    expect(ex("echo x > /dev/null").flags).toEqual([]);
  });

  test("outside the project: a parent folder mid-path, an option's value, an operand's value", () => {
    expect(ex("rm sub/../../other").flags).toContain("outside");
    expect(ex("cat sub/../../../.ssh/id_rsa").flags).toContain("outside");
    expect(ex("bun build --outdir=/tmp/x").flags).toContain("outside");
    expect(ex("dd if=a of=/etc/x").flags).toContain("outside");
    expect(ex("cc -I/usr/include a.c").flags).toContain("outside");
    expect(ex("cat sub/../a.ts").flags).toEqual([]);
    expect(ex("bun build --outdir=dist").flags).not.toContain("outside");
    // a dot glob can match the parent folder
    expect(ex("rm -rf .*").flags).toContain("outside");
  });

  test("an interpreter's inline snippet, a pipe into a shell and a program's own exec are opaque", () => {
    for (const c of ["python -c x", "Python3 -c x", "sh -c ls", "curl x | sh", "eval ls", "awk 1 f", "git -c a=b log", "rg x --pre y", "bun install", "ls | xargs rm", "rm -rf $HOME", "rm $(cat list)", "rm {..,a}", "echo x > $F"]) {
      expect([c, explainCommand(c, ROOT).opaque]).toEqual([c, true]);
    }
    for (const c of ["ls src", "bun test", "git status", "sed -n 1p f", "python3 x.py"]) {
      expect([c, explainCommand(c, ROOT).opaque]).toEqual([c, undefined]);
    }
    // the case of a program's name does not hide it: Python3 is python3 on APFS
    expect(explainCommand("Python3 -c x", ROOT).says).toBe("runs a Python snippet");
  });

  test("a word that reaches where code runs from (hooks, agent settings, package scripts) is guarded", () => {
    expect(explainCommand("tee .git/hooks/pre-commit", ROOT).guarded).toBe(true);
    expect(explainCommand("echo x > package.json", ROOT).guarded).toBe(true);
    expect(explainCommand("cp a .Claude/settings.json", ROOT).guarded).toBe(true);
    expect(explainCommand("ls src", ROOT).guarded).toBeUndefined();
    // judged from the project's own folder, which may itself sit under one
    expect(explainCommand("ls src", "/home/me/.claude/worktrees/a").guarded).toBeUndefined();
  });

  test("searches say what they look for", () => {
    expect(ex("grep -rn 'TODO' src").says).toBe("searches for TODO in src");
    expect(ex("rg foo").says).toBe("searches for foo");
  });

  test("package managers: install, test, a script, a one-off tool", () => {
    expect(ex("bun install")).toEqual({ says: "installs packages", flags: ["network", "writes"], opaque: true });
    expect(ex("bun test")).toEqual({ says: "runs the tests", flags: ["code"] });
    expect(ex("bun run build").says).toBe("runs the build script");
    expect(ex("bunx tsc --noEmit")).toEqual({ says: "runs tsc via bunx", flags: ["code"] });
  });

  test("an unknown program runs it, and says canopy has no reading of its own", () => {
    expect(ex("frobnicate --all")).toEqual({ says: "runs frobnicate", flags: ["code"], vague: true });
    expect(ex("   ")).toEqual({ says: "runs a shell command", flags: [], vague: true });
    expect(ex("git frob")).toEqual({ says: "runs git frob", flags: [], vague: true });
    expect(ex("ls src && frobnicate").vague).toBe(true);
    expect(ex("ls src").vague).toBeUndefined();
  });

  test("git deletes say so", () => {
    expect(ex("git branch -D old")).toEqual({ says: "deletes branch old", flags: ["deletes"] });
    expect(ex("git branch --delete old").flags).toEqual(["deletes"]);
    expect(ex("git tag -d v1")).toEqual({ says: "deletes tag v1", flags: ["deletes"] });
    expect(ex("git stash drop")).toEqual({ says: "drops a stash", flags: ["deletes"] });
    expect(ex("git stash clear").flags).toEqual(["deletes"]);
    expect(ex("git stash").says).toBe("stashes changes");
  });

  test("git -c can run code; an identity cannot", () => {
    expect(ex("git -c alias.x='!rm -rf ~' x").flags).toContain("code");
    expect(ex("git -c core.pager=evil log").flags).toEqual(["code"]);
    expect(ex("git -c user.name=a log").flags).toEqual([]);
  });

  test("deletes elsewhere than rm", () => {
    for (const c of [
      "find . -name '*.tmp' -exec rm {} \\;",
      "gh repo delete me/x --yes",
      "kubectl delete pod web",
      "docker rm box",
      "docker rmi img",
      "docker system prune -f",
      "aws s3 rm s3://b/k",
      "crontab -r",
      "shred secret.txt",
      "truncate -s 0 log.txt",
    ]) {
      expect(ex(c).flags, c).toContain("deletes");
    }
  });

  test("publishing and deploying push to the network", () => {
    for (const c of ["npm publish", "bun publish", "cargo publish", "firebase deploy", "vercel --prod", "vercel deploy --prod"]) {
      expect(ex(c).flags, c).toEqual(expect.arrayContaining(["push", "network"]));
    }
    expect(ex("npm publish").says).toBe("publishes the package");
    expect(ex("firebase deploy").says).toBe("deploys with firebase");
  });

  test("a cd home shows home as ~", () => {
    expect(ex("cd ~ && rm -rf x")).toEqual({ says: "deletes ~/x", flags: ["deletes", "outside"] });
    expect(ex("cd && cat notes.txt").says).toBe("reads ~/notes.txt");
  });

  test("env assignments and wrappers are read through", () => {
    expect(ex("FOO=1 sudo ls /root").says).toBe("lists files in /root");
    expect(ex("sudo ls /root").flags).toEqual(["outside"]);
  });

  test("many steps are cut short", () => {
    const says = ex("ls a; pwd; whoami; date; uname -a; hostname; df -h").says;
    expect(says.endsWith("and 2 more steps")).toBe(true);
  });
});

describe("explainPrompt", () => {
  test("a shell prompt reads its command", () => {
    expect(explainPrompt({ tool: "Bash", title: "ls", command: "ls src" }, ROOT).says).toBe("lists files in src");
  });

  test("file tools name the file and flag a write or the outside", () => {
    expect(explainPrompt({ tool: "Read", title: "read a.ts", paths: [`${ROOT}/a.ts`] }, ROOT)).toEqual({ says: "reads a.ts", flags: [] });
    expect(explainPrompt({ tool: "Write", title: "write x", paths: ["/etc/x"] }, ROOT)).toEqual({ says: "writes /etc/x", flags: ["outside", "writes"] });
    expect(explainPrompt({ tool: "Edit", title: "edit a.ts", paths: [`${ROOT}/a.ts`, `${ROOT}/b.ts`] }, ROOT)).toEqual({ says: "edits 2 files", flags: ["writes"] });
  });

  test("web tools are network; anything else keeps its title", () => {
    expect(explainPrompt({ tool: "WebFetch", title: "WebFetch" }, ROOT).flags).toEqual(["network"]);
    expect(explainPrompt({ tool: "Network", title: "network access to a.com" }, ROOT)).toEqual({ says: "network access to a.com", flags: ["network"] });
    expect(explainPrompt({ tool: "Skill", title: "skill pdf" }, ROOT)).toEqual({ says: "skill pdf", flags: [], vague: true });
  });

  test("a codex command's own folder counts", () => {
    expect(explainPrompt({ tool: "Bash", title: "ls", command: "ls", cwd: "/elsewhere" }, ROOT).flags).toEqual(["outside"]);
  });
});

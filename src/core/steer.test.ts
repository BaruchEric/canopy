import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choiceOnScreen, STEER_MAX, steerWords } from "./steer";
import { pasteArgs, sayBuffer, sayInto, sessionName, setBufferArgs } from "./tmux";

const ID = "0123456789abcdef0123456789abcdef";

describe("a choice on a terminal agent's screen", () => {
  test("Claude Code's permission, with the cursor on an option, is a choice, boxed or not", () => {
    const lines = [
      "⏺ Bash(git push origin main)",
      "",
      " Bash command",
      "   git push origin main",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for git push",
      "   3. No, and tell Claude what to do differently (esc)",
    ];
    expect(choiceOnScreen(lines.join("\n"))).toBe(true);
    const boxed = ["╭────────╮", ...lines.map((l) => `│${l.padEnd(56)}│`), "╰────────╯"];
    expect(choiceOnScreen(boxed.join("\n"))).toBe(true);
  });

  test("Codex's approval and Claude Code's folder trust are choices, colours and all", () => {
    expect(choiceOnScreen("  Would you like to run the following command?\n\x1b[36m› 1. Yes, proceed (y)\x1b[0m\n  2. No, and tell Codex what to do differently (esc)\n")).toBe(true);
    expect(choiceOnScreen(" Do you trust the files in this folder?\n\n Enter to confirm · Esc to exit\n")).toBe(true);
  });

  test("an agent at work, or waiting at its prompt, shows none, numbered lists included", () => {
    expect(choiceOnScreen("⏺ The plan:\n  1. Read the config\n  2. Fix the test\n\n✻ Working… (12s · esc to interrupt)\n")).toBe(false);
    expect(choiceOnScreen("╭────────────╮\n│ >          │\n╰────────────╯\n  ? for shortcuts\n")).toBe(false);
    expect(choiceOnScreen("")).toBe(false);
  });

  test("a choice scrolled far up the pane is gone, only the last lines count", () => {
    const old = "❯ 1. Yes\n" + Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    expect(choiceOnScreen(old)).toBe(false);
  });
});

describe("the words a person sends", () => {
  test("are trimmed, and refused when empty or too long", () => {
    expect(steerWords("  go on  ")).toEqual({ ok: true, words: "go on" });
    expect(steerWords(" \n ")).toEqual({ ok: false, error: "say something first" });
    expect(steerWords("x".repeat(STEER_MAX + 1))).toEqual({ ok: false, error: `a message is at most ${STEER_MAX} characters` });
    expect(steerWords("x".repeat(STEER_MAX)).ok).toBe(true);
  });
});

describe("typing into a pane", () => {
  const base = ["tmux", "-S", "/s"];

  test("the words go to a buffer of the shell's own, then one bracketed paste that drops it", () => {
    expect(sayBuffer(ID)).toBe(`canopy-say-${ID}`);
    expect(setBufferArgs(base, "b", "-n looks like a flag")).toEqual(["tmux", "-S", "/s", "set-buffer", "-b", "b", "--", "-n looks like a flag"]);
    expect(pasteArgs(base, ID, "b")).toEqual(["tmux", "-S", "/s", "paste-buffer", "-p", "-d", "-b", "b", "-t", sessionName(ID)]);
  });

  const tmux = Bun.which("tmux");
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test.skipIf(!tmux)("a real pane gets the words and the Enter that sends them, quotes and all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cs-"));
    dirs.push(dir);
    const real = [tmux ?? "tmux", "-S", join(dir, "s"), "-f", "/dev/null"];
    const words = `it's "quoted" $HOME; -flag`;
    try {
      expect(Bun.spawnSync([...real, "new-session", "-d", "-s", sessionName(ID), "-x", "120", "-y", "20", "cat"]).exitCode).toBe(0);
      expect(await sayInto(real, ID, words)).toBe(true);
      let screen = "";
      for (let i = 0; i < 50 && !screen.split("\n").filter((l) => l === words).length; i++) {
        await Bun.sleep(40);
        screen = Bun.spawnSync([...real, "capture-pane", "-p", "-t", sessionName(ID)]).stdout.toString();
      }
      // the terminal's echo of the line, then cat's copy of it once Enter sent it
      expect(screen.split("\n").filter((l) => l === words).length).toBe(2);
      // the paste took its buffer with it
      expect(Bun.spawnSync([...real, "show-buffer", "-b", sayBuffer(ID)]).exitCode).not.toBe(0);
    } finally {
      Bun.spawnSync([...real, "kill-server"]);
    }
  });

  test.skipIf(!tmux)("a shell that is gone says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cs-"));
    dirs.push(dir);
    const real = [tmux ?? "tmux", "-S", join(dir, "s"), "-f", "/dev/null"];
    expect(await sayInto(real, ID, "hello")).toBe(false);
  });
});

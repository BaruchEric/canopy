import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choiceOnScreen, codexAgentListOnScreen, STEER_MAX, steerWords } from "./steer";
import { loadBufferArgs, pasteArgs, sayBuffer, sayInto, sayTo, sessionName, typedAsEmpty } from "./tmux";

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

  // Claude Code 2.1.325 echoes a prompt sent or queued as `❯ ` and its text,
  // the glyph its dialogs' cursor uses (`>` where the terminal has no Unicode)
  const sent = ["❯ 1. fix the failing test", "  2. push", "", "⏺ Running the tests first.", "", "✻ Working… (esc to interrupt)", ""];
  const rule = "─".repeat(40);

  test("a numbered prompt sent above an empty input box is no choice, the box bare, boxed or showing its placeholder", () => {
    expect(choiceOnScreen([...sent, rule, "❯ ", rule, "  ? for shortcuts"].join("\n"))).toBe(false);
    expect(choiceOnScreen([...sent.map((l) => l.replace("❯", ">")), rule, ">", rule].join("\n"))).toBe(false);
    expect(choiceOnScreen([...sent, "╭────────────╮", "│ >          │", "╰────────────╯"].join("\n"))).toBe(false);
    expect(choiceOnScreen([...sent, rule, `❯ Try "how does <filepath> work?"`, rule].join("\n"))).toBe(false);
    // Codex's echo, with its prompt's placeholder under it
    expect(choiceOnScreen(["› 1. fix the failing test", "  2. push", "", "• Working (3s • esc to interrupt)", "", "› Ask Codex to do anything", "  gpt-6.1-sol default · ~/dev/demo"].join("\n"))).toBe(false);
  });

  test("a dialog in the input box's place is a choice, with a numbered prompt sent above it", () => {
    const dialog = ["⏺ Bash(git push origin main)", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No, and tell Claude what to do differently (esc)"];
    expect(choiceOnScreen([...sent, ...dialog].join("\n"))).toBe(true);
  });
});

describe("Codex's agent list on a shell's screen", () => {
  // as codex 0.169 draws it at a phone's 46 columns, colours and all
  const list = [
    "\x1b[1m  Agent command center\x1b[0m  Group: Project  g",
    "   All 4   Needs you 0   Working 0        ›",
    "  ──────────────────────────────────────────",
    "      Tasks",
    "  ~/dev/demo  2",
    "  › ○ Untitled task",
    "    ○ Respond to greeting",
    "  ↓",
    "",
    "  ? help  esc back  ↑/↓ move  enter open  n…",
  ];

  test("is seen by its title on top or its keys at the bottom", () => {
    expect(codexAgentListOnScreen(list.join("\n"))).toBe(true);
    // a short pane that lost the title still has the keys
    expect(codexAgentListOnScreen(list.slice(3).join("\n"))).toBe(true);
    // its help over the list keeps the title
    expect(codexAgentListOnScreen([list[0], "  Task shortcuts", "  Navigate  Tasks  View", "  esc back"].join("\n"))).toBe(true);
  });

  test("is not Codex's prompt, its trust question, or a transcript that names it", () => {
    const prompt = ["  >_ OpenAI Codex (v0.169.0)", "› Ask Codex to do anything", "  gpt-6.1-sol default · ~/dev/demo", "  ← for agents      ⚠ 5 warnings · f2 to view"];
    expect(codexAgentListOnScreen(prompt.join("\n"))).toBe(false);
    expect(codexAgentListOnScreen("  Trust this folder?\n› 1. Trust and continue\n  2. Back to Agent Command Center\n  enter continue · esc back\n")).toBe(false);
    expect(codexAgentListOnScreen("⏺ The fix:\n  Codex's Agent command center eats letters.\n\n✻ Working… (3s · esc to interrupt)\n")).toBe(false);
    expect(codexAgentListOnScreen("")).toBe(false);
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

  test("the words go to a buffer of the steer's own, read from stdin, then one bracketed paste that drops it", () => {
    expect(sayBuffer(ID, "t1")).toBe(`canopy-say-${ID}-t1`);
    expect(loadBufferArgs(base, "b")).toEqual(["tmux", "-S", "/s", "load-buffer", "-b", "b", "-"]);
    expect(pasteArgs(base, ID, "b")).toEqual(["tmux", "-S", "/s", "paste-buffer", "-p", "-d", "-b", "b", "-t", sessionName(ID)]);
  });

  test("once the words are typed, the box line that shows them reads as an empty box", () => {
    const sent = ["❯ 1. read the config", "", "⏺ Done."];
    const box = (l: string) => [...sent, "────", l, "────", "  ? for shortcuts"].join("\n");
    // words that start "1. " in the box, and a sent prompt above it, are no choice
    expect(choiceOnScreen(box("❯ 1. run the tests"))).toBe(true);
    expect(choiceOnScreen(typedAsEmpty(box("❯ 1. run the tests"), "1. run the tests\n2. push"))).toBe(false);
    expect(choiceOnScreen(typedAsEmpty(box("❯ [Pasted text #1 +40 lines]"), "1. a long one"))).toBe(false);
    expect(choiceOnScreen(typedAsEmpty(["› [Pasted Content 9000 chars]", "  gpt-6.1 · ~/dev"].join("\n"), "1. x"))).toBe(false);
    // a dialog in the box's place still counts
    const dialog = [...sent, " Do you want to proceed?", " ❯ 1. Yes", "   2. No"].join("\n");
    expect(choiceOnScreen(typedAsEmpty(dialog, "go on"))).toBe(true);
    // a screen without the words is read as it is
    expect(typedAsEmpty(dialog, "something else")).toBe(dialog);
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
    // as argv, tmux took a trailing ';' for its separator and a '\;' lost its backslash
    const words = `it's "quoted" $HOME \\; -flag;`;
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
      expect(Bun.spawnSync([...real, "list-buffers", "-F", "#{buffer_name}"]).stdout.toString()).not.toContain("canopy-say-");
    } finally {
      Bun.spawnSync([...real, "kill-server"]);
    }
  });

  const screenOf = (real: string[]): string => Bun.spawnSync([...real, "capture-pane", "-p", "-t", sessionName(ID)]).stdout.toString();
  async function waitScreen(real: string[], until: (s: string) => boolean): Promise<string> {
    let screen = screenOf(real);
    for (let i = 0; i < 75 && !until(screen); i++) {
      await Bun.sleep(40);
      screen = screenOf(real);
    }
    return screen;
  }

  /** a pane whose program reads raw bytes into a file once `pre` (sh) has run,
   *  ready when it has said so */
  async function rawPane(pre = "") {
    const dir = await mkdtemp(join(tmpdir(), "cs-"));
    dirs.push(dir);
    const real = [tmux ?? "tmux", "-S", join(dir, "s"), "-f", "/dev/null"];
    const out = join(dir, "out");
    const prog = `stty raw -echo; printf ready; ${pre} exec cat > '${out}'`;
    expect(Bun.spawnSync([...real, "new-session", "-d", "-s", sessionName(ID), "-x", "120", "-y", "20", "sh", "-c", prog]).exitCode).toBe(0);
    await waitScreen(real, (s) => s.includes("ready"));
    const read = async (until: (s: string) => boolean): Promise<string> => {
      let got = "";
      for (let i = 0; i < 75 && !until(got); i++) {
        await Bun.sleep(40);
        got = await Bun.file(out).text().catch(() => "");
      }
      return got;
    };
    return { real, read };
  }

  test.skipIf(!tmux)("words over tmux's 16 KB command limit go whole", async () => {
    const { real, read } = await rawPane();
    // 6,000 characters of three bytes each: 18 KB, under STEER_MAX
    const words = "界".repeat(6_000);
    try {
      expect(await sayInto(real, ID, words)).toBe(true);
      expect(await read((s) => s.endsWith("\r"))).toBe(`${words}\r`);
    } finally {
      Bun.spawnSync([...real, "kill-server"]);
    }
  });

  test.skipIf(!tmux)("two steers at once into one shell go one after the other, each whole", async () => {
    const { real, read } = await rawPane();
    try {
      const [a, b] = await Promise.all([sayInto(real, ID, "first words"), sayInto(real, ID, "second words")]);
      expect([a, b]).toEqual([true, true]);
      expect(await read((s) => s.split("\r").length > 2)).toBe("first words\rsecond words\r");
    } finally {
      Bun.spawnSync([...real, "kill-server"]);
    }
  });

  test.skipIf(!tmux)("a choice that comes up while the words go in gets no Enter", async () => {
    // the program draws a permission as soon as the paste's first byte reaches it
    const { real, read } = await rawPane(`dd bs=1 count=1 >/dev/null 2>&1; printf '\\r\\n Do you want to proceed?\\r\\n > 1. Yes\\r\\n   2. No\\r\\n';`);
    try {
      expect(await sayTo(real, ID, "go on")).toBe("choice");
      await Bun.sleep(200);
      // the rest of the paste reached it, and no Enter after it
      expect(await read((s) => s === "o on")).toBe("o on");
    } finally {
      Bun.spawnSync([...real, "kill-server"]);
    }
  });

  test.skipIf(!tmux)("words that start like an option, typed after a prompt, still go", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cs-"));
    dirs.push(dir);
    const real = [tmux ?? "tmux", "-S", join(dir, "s"), "-f", "/dev/null"];
    const words = "1. run the tests";
    try {
      expect(Bun.spawnSync([...real, "new-session", "-d", "-s", sessionName(ID), "-x", "120", "-y", "20", "sh", "-c", "printf '> '; exec cat"]).exitCode).toBe(0);
      await waitScreen(real, (s) => s.startsWith(">"));
      expect(await sayTo(real, ID, words)).toBe("sent");
      const screen = await waitScreen(real, (s) => s.includes(`\n${words}`));
      expect(screen.split("\n").slice(0, 2)).toEqual([`> ${words}`, words]);
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

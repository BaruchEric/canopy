import { describe, expect, test } from "bun:test";
import {
  RANGER_DEFAULTS,
  freshDue,
  isQuiet,
  normalizeRanger,
  parseWake,
  patchRanger,
  rangerArgv,
  rangerBrief,
  rangerExtra,
  rangerHandle,
  rangerHello,
  readWake,
  TRUST_RE,
  wakeLine,
} from "./ranger";
import { DEFAULT_AGENT, type RangerWake } from "./types";

const at = (iso: string): number => new Date(`${iso}Z`).getTime();

describe("settings", () => {
  test("normalize keeps what reads and defaults the rest", () => {
    expect(normalizeRanger(undefined)).toEqual(RANGER_DEFAULTS);
    expect(normalizeRanger({ on: true, profile: "review", handle: "ranger-mac", telegram: true, fresh: { daily: null, maxMb: 40 } })).toEqual({
      on: true,
      profile: "review",
      handle: "ranger-mac",
      telegram: true,
      fresh: { daily: null, maxMb: 40 },
    });
    expect(normalizeRanger({ on: "yes", profile: "Bad Name", handle: "@x", fresh: { daily: "4am", maxMb: -1 } })).toEqual(RANGER_DEFAULTS);
  });

  test("a patch changes only what it names, and refuses what does not read", () => {
    const on = patchRanger(RANGER_DEFAULTS, { on: true, fresh: { maxMb: null } });
    expect(on).toEqual({ ...RANGER_DEFAULTS, on: true, fresh: { daily: "04:00", maxMb: null } });
    expect(patchRanger(RANGER_DEFAULTS, { handle: "ranger" })).toMatchObject({ handle: null });
    expect(typeof patchRanger(RANGER_DEFAULTS, { on: 1 })).toBe("string");
    expect(typeof patchRanger(RANGER_DEFAULTS, { handle: "Not OK" })).toBe("string");
    expect(typeof patchRanger(RANGER_DEFAULTS, { fresh: { daily: "25:00" } })).toBe("string");
    expect(typeof patchRanger(RANGER_DEFAULTS, [])).toBe("string");
    expect(rangerHandle(RANGER_DEFAULTS)).toBe("ranger");
    expect(rangerHandle({ ...RANGER_DEFAULTS, handle: "ranger-mac" })).toBe("ranger-mac");
  });
});

describe("rangerArgv", () => {
  const base = { session: "35adf21d-777e-428a-aec9-639404e23258", briefFile: "/config/ranger/brief.md", telegram: false };

  test("a new conversation, never yolo, with its name and brief", () => {
    const argv = rangerArgv({ ...base, settings: { ...DEFAULT_AGENT, model: "opus", effort: "high" }, first: true });
    expect(argv).toEqual(["claude", "--model", "opus", "--effort", "high", "--name", "ranger", "--append-system-prompt-file", "/config/ranger/brief.md", "--session-id", base.session]);
    expect(argv).not.toContain("--dangerously-skip-permissions");
  });

  test("a resume, and Telegram when it owns the bot", () => {
    const argv = rangerArgv({ ...base, settings: DEFAULT_AGENT, first: false, telegram: true });
    expect(argv.slice(-2)).toEqual(["--resume", base.session]);
    expect(argv).toContain("--channels");
    expect(argv[argv.indexOf("--channels") + 1]).toBe("plugin:telegram@claude-plugins-official");
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "")).toEqual({ enabledPlugins: { "telegram@claude-plugins-official": true } });
  });

  test("the opening prompt goes last, and never reads as a subcommand", () => {
    const argv = rangerArgv({ ...base, settings: DEFAULT_AGENT, first: false, hello: rangerHello("resume") });
    expect(argv.at(-1)).toStartWith("[canopy] canopy started you again");
    expect(argv.slice(-3, -1)).toEqual(["--resume", base.session]);
    expect(rangerHello("new")).toContain("first conversation");
    expect(rangerHello("fresh")).toContain("brief names the last one");
  });

  test("extra flags lose whatever skips permissions or fights canopy's own", () => {
    expect(rangerExtra("--verbose --dangerously-skip-permissions --permission-mode bypassPermissions --resume abc -c --add-dir /x")).toEqual(["--verbose", "--add-dir", "/x"]);
    expect(rangerExtra("--permission-mode acceptEdits --permission-mode=bypassPermissions --session-id=1 --name x")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(rangerExtra("--settings '{\"a\":1}' --channels plugin:x -p")).toEqual([]);
  });
});

describe("rangerBrief", () => {
  const vars = { backend: "mini", handle: "ranger", root: "/home/eric/dev", previous: null, telegram: false };

  test("fills the slots and keeps a block only when its var is set", () => {
    const t = "You are {{handle}} on {{backend}} in {{root}}.\n\n{{#previous}}Before: {{previous}}{{/previous}}\n\n{{#telegram}}Telegram too.{{/telegram}}\n{{nope}}";
    expect(rangerBrief(t, vars)).toBe("You are ranger on mini in /home/eric/dev.\n\n{{nope}}");
    expect(rangerBrief(t, { ...vars, previous: "/t/a.jsonl", telegram: true })).toBe("You are ranger on mini in /home/eric/dev.\n\nBefore: /t/a.jsonl\n\nTelegram too.\n{{nope}}");
  });
});

describe("fresh conversations", () => {
  const fresh = { daily: "04:00", maxMb: 25 };

  test("due once the daily hour has passed since the conversation began", () => {
    expect(freshDue({ now: at("2026-10-10T08:00"), fresh, sessionAt: at("2026-10-10T03:00"), bytes: 10 })).toBe("daily");
    expect(freshDue({ now: at("2026-10-10T08:00"), fresh, sessionAt: at("2026-10-10T05:00"), bytes: 10 })).toBeNull();
    expect(freshDue({ now: at("2026-10-10T03:00"), fresh, sessionAt: at("2026-10-09T05:00"), bytes: 10 })).toBeNull();
    expect(freshDue({ now: at("2026-10-10T08:00"), fresh: { daily: null, maxMb: 25 }, sessionAt: at("2026-10-01T00:00"), bytes: 10 })).toBeNull();
  });

  test("due once the transcript passes its size", () => {
    expect(freshDue({ now: at("2026-10-10T08:00"), fresh, sessionAt: at("2026-10-10T05:00"), bytes: 26 * 1024 * 1024 })).toBe("size");
    expect(freshDue({ now: at("2026-10-10T08:00"), fresh: { daily: null, maxMb: null }, sessionAt: undefined, bytes: 1e12 })).toBeNull();
  });

  test("quiet: an idle card, and nothing out of or into the pane for a while", () => {
    const now = at("2026-10-10T08:00");
    const long = now - 11 * 60_000;
    expect(isQuiet({ now, card: "idle", lastOutput: long, lastInput: long })).toBe(true);
    expect(isQuiet({ now, card: undefined, lastOutput: long, lastInput: undefined })).toBe(true);
    expect(isQuiet({ now, card: "waiting", lastOutput: long, lastInput: long })).toBe(false);
    expect(isQuiet({ now, card: "idle", lastOutput: now - 60_000, lastInput: long })).toBe(false);
    expect(isQuiet({ now, card: "idle", lastOutput: long, lastInput: now - 60_000 })).toBe(false);
  });

  test("the trust dialog is recognised", () => {
    expect(TRUST_RE.test(" ❯ No, exit\n   Yes, I trust this folder")).toBe(true);
    expect(TRUST_RE.test("❯ Try \"how does <filepath> work?\"")).toBe(false);
  });
});

describe("wakes", () => {
  const now = at("2026-10-10T08:30");

  test("one of a time, a cron line or a run", () => {
    expect(readWake({ prompt: "check the deploy", when: "in 30m" }, "ranger", "0000000a", now)).toEqual({ id: "0000000a", by: "ranger", prompt: "check the deploy", created: now, at: now + 1_800_000, next: now + 1_800_000 });
    expect(readWake({ prompt: "morning", cron: "0 8 * * *" }, "eric", "0000000b", now)).toMatchObject({ cron: "0 8 * * *", next: at("2026-10-11T08:00") });
    expect(readWake({ prompt: "look", run: "r-12" }, "ranger", "0000000c", now)).toMatchObject({ run: "r-12" });
    expect(readWake({ prompt: "x", at: now + 5 }, "ranger", "0000000d", now)).toMatchObject({ at: now + 5 });
  });

  test("refuses a wake with none, two, a bad time or no prompt", () => {
    for (const bad of [{ prompt: "x" }, { prompt: "x", cron: "0 8 * * *", run: "r" }, { prompt: "x", cron: "nope" }, { prompt: "x", when: "someday" }, { prompt: "", when: "in 5m" }, { prompt: "x", at: now - 1 }, { prompt: "x", run: "has space" }, null]) {
      expect(typeof readWake(bad, "eric", "0000000e", now)).toBe("string");
    }
  });

  test("read back off disk, or dropped", () => {
    const w: RangerWake = { id: "0000000f", by: "eric", prompt: "morning", created: now, cron: "0 8 * * *", next: now + 1 };
    expect(parseWake(JSON.parse(JSON.stringify(w)))).toEqual(w);
    expect(parseWake({ ...w, id: "nothex!!" })).toBeNull();
    expect(parseWake({ ...w, cron: undefined, run: undefined })).toBeNull();
    expect(parseWake({ ...w, cron: undefined, at: 5 })).toMatchObject({ at: 5, next: now + 1 });
  });

  test("the line the ranger reads names what woke it", () => {
    expect(wakeLine({ id: "0000000a", by: "eric", prompt: "morning", created: 0, cron: "0 8 * * *" })).toBe("[cron 0000000a] morning");
    expect(wakeLine({ id: "0000000b", by: "ranger", prompt: "check it", created: 0, at: 1 })).toBe("[wake 0000000b] check it");
    expect(wakeLine({ id: "0000000c", by: "ranger", prompt: "read the result", created: 0, run: "r1" }, { status: "done", repo: "canopy" })).toBe("[wake 0000000c] run r1 in canopy ended done. read the result");
    expect(wakeLine({ id: "0000000c", by: "ranger", prompt: "read it", created: 0, run: "r1" }, null)).toContain("is gone");
  });
});

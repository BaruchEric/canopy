import { describe, expect, test } from "bun:test";
import { Awake, awakeCommand, ownCard, workingCount, type AwakeChild } from "./awake";
import type { AgentCard, AwakeInfo } from "./types";

/** a stand-in hold: records its argv, ends when killed or told to */
function fakeSpawn() {
  const spawned: { argv: string[]; killed: boolean; end: (code: number) => void }[] = [];
  const spawn = (argv: string[]): AwakeChild => {
    let end!: (code: number) => void;
    const exited = new Promise<number>((r) => (end = r));
    const rec = { argv, killed: false, end };
    spawned.push(rec);
    return {
      exited,
      kill: () => {
        rec.killed = true;
        end(143);
      },
      stderr: () => "Failed to inhibit: Access denied\n",
    };
  };
  return { spawned, spawn };
}

const mac = (extra: Partial<ConstructorParameters<typeof Awake>[1]> = {}) => {
  const f = fakeSpawn();
  const seen: AwakeInfo[] = [];
  const awake = new Awake("off", { platform: "darwin", pid: 42, which: (b) => `/usr/bin/${b}`, container: () => false, spawn: f.spawn, onChange: (i) => seen.push(i), ...extra });
  return { awake, seen, ...f };
};

const card = (over: Partial<AgentCard> & { backend?: string } = {}): AgentCard => {
  const { backend, ...rest } = over;
  return {
    id: "claude:s1",
    handle: "h",
    node: "m3max",
    harness: "claude",
    session: "s1",
    origin: "hook",
    cwd: "/r",
    repo: null,
    branch: null,
    model: null,
    mode: null,
    state: "working",
    waiting: null,
    caps: [],
    offers: [],
    notifyIdle: false,
    where: { os: "darwin", container: false, pid: 1, term: null, canopy: backend ? { backend } : null },
    transcript: null,
    startedAt: 0,
    seenAt: 0,
    endedAt: null,
    ...rest,
  } as AgentCard;
};

describe("awakeCommand", () => {
  test("caffeinate on a Mac, systemd-inhibit over tail on Linux, both tied to the pid", () => {
    expect(awakeCommand("darwin", 7)).toEqual(["caffeinate", "-i", "-w", "7"]);
    const linux = awakeCommand("linux", 7);
    expect(linux?.[0]).toBe("systemd-inhibit");
    expect(linux).toContain("--what=idle:sleep");
    expect(linux?.slice(-4)).toEqual(["tail", "--pid=7", "-f", "/dev/null"]);
    expect(awakeCommand("win32", 7)).toBeNull();
  });
});

describe("Awake", () => {
  test("nothing spawns before start, whatever the mode", () => {
    const { awake, spawned } = mac();
    awake.setMode("always");
    expect(spawned).toHaveLength(0);
    expect(awake.status()).toMatchObject({ mode: "always", holding: false, available: true });
    awake.start();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.argv).toEqual(["caffeinate", "-i", "-w", "42"]);
    expect(awake.status().holding).toBe(true);
  });

  test("working holds only while an agent works, and off lets go", () => {
    const { awake, spawned } = mac();
    awake.start();
    awake.setMode("working");
    expect(spawned).toHaveLength(0);
    awake.setWorking(2);
    expect(spawned).toHaveLength(1);
    awake.setWorking(1);
    expect(spawned).toHaveLength(1);
    awake.setWorking(0);
    expect(spawned[0]?.killed).toBe(true);
    expect(awake.status().holding).toBe(false);
    awake.setMode("always");
    expect(spawned).toHaveLength(2);
    awake.setMode("off");
    expect(spawned[1]?.killed).toBe(true);
  });

  test("tells a change once, not every recount", () => {
    const { awake, seen } = mac();
    awake.start();
    const before = seen.length;
    awake.setMode("working");
    awake.setMode("working");
    expect(seen.length).toBe(before + 1);
  });

  test("a hold that ends on its own says why and is not holding", async () => {
    const { awake, spawned, seen } = mac({ platform: "linux" });
    awake.setMode("always");
    awake.start();
    spawned[0]?.end(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(awake.status()).toMatchObject({ holding: false, why: "systemd-inhibit exited (1): Failed to inhibit: Access denied" });
    expect(seen.at(-1)?.holding).toBe(false);
  });

  test("a killed hold is a release, not an end of its own", async () => {
    const { awake } = mac();
    awake.setMode("always");
    awake.start();
    awake.setMode("off");
    await Promise.resolve();
    expect(awake.status().why).toBeNull();
  });

  test("unavailable in a container, on another platform, or without the binary", () => {
    for (const [deps, why] of [
      [{ container: () => true }, "running in a container"],
      [{ platform: "win32" }, "no way to hold a win32 machine awake"],
      [{ which: () => null }, "caffeinate is not installed"],
    ] as const) {
      const { awake, spawned } = mac(deps);
      awake.setMode("always");
      awake.start();
      expect(spawned).toHaveLength(0);
      expect(awake.status().available).toBe(false);
      expect(awake.status().why).toContain(why);
    }
  });

  test("stop lets go and holds nothing after", () => {
    const { awake, spawned } = mac();
    awake.setMode("always");
    awake.start();
    awake.stop();
    expect(spawned[0]?.killed).toBe(true);
    awake.setMode("always");
    awake.setWorking(3);
    expect(spawned).toHaveLength(1);
  });
});

describe("whose agents count", () => {
  test("a card under this backend, on its node, or named as it or its host", () => {
    const canopy = card({ id: "a", node: "m3max", backend: "mac" });
    const cards = [canopy];
    expect(ownCard(canopy, "mac", "Erics-MacBook.local", cards)).toBe(true);
    // a hooked claude in kitty on the same node, learned from the canopy card
    expect(ownCard(card({ id: "b", node: "M3Max" }), "mac", "Erics-MacBook.local", cards)).toBe(true);
    expect(ownCard(card({ id: "c", node: "mac" }), "mac", "x", [])).toBe(true);
    expect(ownCard(card({ id: "d", node: "erics-macbook" }), "mac", "Erics-MacBook.local", [])).toBe(true);
  });

  test("a Claude on the mini never holds the Mac", () => {
    const mini = card({ id: "m", node: "macmini-2018", backend: "mini" });
    const cards = [card({ id: "a", node: "m3max", backend: "mac" }), mini];
    expect(ownCard(mini, "mac", "Erics-MacBook.local", cards)).toBe(false);
    expect(ownCard(card({ node: "macmini-2018" }), "mac", "Erics-MacBook.local", cards)).toBe(false);
  });

  test("working runs here plus own working cards; idle and ended ones do not", () => {
    const cards = [
      card({ id: "a", node: "mac" }),
      card({ id: "b", node: "mac", state: "idle" }),
      card({ id: "c", node: "mac", endedAt: 5 }),
      card({ id: "d", node: "mini" }),
    ];
    expect(workingCount([{ status: "working" }, { status: "done" }], cards, "mac", "host")).toBe(2);
  });
});

/** Keep awake: canopy holds the machine out of idle sleep, always or while
 *  an agent here works, through a child the OS already trusts for that
 *  (caffeinate on a Mac, systemd-inhibit on Linux). The child watches
 *  canopy's own pid, so a crash or a kill -9 never leaves a hold behind. */

import { inContainer } from "./agentscan";
import type { AgentCard, AwakeInfo, AwakeMode } from "./types";

/** The argv that holds this machine awake until `pid` exits, or null on a
 *  platform canopy has no way to do it on. */
export function awakeCommand(platform: string, pid: number): string[] | null {
  if (platform === "darwin") return ["caffeinate", "-i", "-w", String(pid)];
  if (platform === "linux") {
    return [
      "systemd-inhibit",
      "--what=idle:sleep",
      "--who=canopy",
      "--why=an agent is working",
      "--mode=block",
      "tail",
      `--pid=${pid}`,
      "-f",
      "/dev/null",
    ];
  }
  return null;
}

/** Whether a registry card is an agent on this machine. The registry spans
 *  the tailnet, and a Claude working on the mini must not hold the Mac
 *  awake. A card a canopy shell or run here wrote names this backend; any
 *  other card counts when its node is one those cards ran on, or is named
 *  as this backend or this host is (the backend never learns its own
 *  tailnet name, the same guess the UI's readerOf makes). */
export function ownCard(card: AgentCard, backend: string, host: string, cards: readonly AgentCard[]): boolean {
  if (card.where.canopy?.backend === backend) return true;
  const node = card.node.toLowerCase();
  if (!node) return false;
  const short = host.toLowerCase().split(".")[0] ?? "";
  if (node === backend.toLowerCase() || (short && node === short)) return true;
  return cards.some((c) => c.where.canopy?.backend === backend && c.node.toLowerCase() === node);
}

/** How many agents work on this machine right now: this backend's runs and
 *  the registry's own cards in `working`. */
export function workingCount(runs: readonly { status: string }[], cards: readonly AgentCard[], backend: string, host: string): number {
  const mine = cards.filter((c) => c.state === "working" && c.endedAt === null && ownCard(c, backend, host, cards));
  return runs.filter((r) => r.status === "working").length + mine.length;
}

/** what a spawned hold looks like to the class: enough to end it and hear it end */
export interface AwakeChild {
  exited: Promise<number>;
  kill(): void;
  /** the end of what it printed to stderr, for a hold that ended on its own */
  stderr?: () => string;
}

export interface AwakeDeps {
  spawn?: (argv: string[]) => AwakeChild;
  which?: (bin: string) => string | null;
  platform?: string;
  container?: () => boolean;
  pid?: number;
  /** told every time `status()` changes */
  onChange?: (info: AwakeInfo) => void;
}

function spawnHold(argv: string[]): AwakeChild {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  let err = "";
  void (async () => {
    for await (const bytes of child.stderr) err = (err + new TextDecoder().decode(bytes)).slice(-2000);
  })().catch(() => {});
  return { exited: child.exited, kill: () => child.kill(), stderr: () => err };
}

/** One hold per server, the way the Library keeps its worker: a child that
 *  lives while the mode and the agents want it. Nothing spawns before
 *  `start()`, so a test server records a mode and holds nothing. */
export class Awake {
  private child: AwakeChild | null = null;
  private started = false;
  private stopped = false;
  private working = 0;
  /** why the last hold ended on its own; cleared by the next one */
  private ended: string | null = null;
  private last = "";
  private reason: { available: boolean; why: string | null } | null = null;

  constructor(
    private mode: AwakeMode,
    private deps: AwakeDeps = {},
  ) {}

  private get argv(): string[] | null {
    return awakeCommand(this.deps.platform ?? process.platform, this.deps.pid ?? process.pid);
  }

  /** whether this machine can hold itself awake, asked once */
  private availability(): { available: boolean; why: string | null } {
    if (this.reason) return this.reason;
    const argv = this.argv;
    const bin = argv?.[0];
    const which = this.deps.which ?? ((b: string) => Bun.which(b));
    this.reason = (this.deps.container ?? (() => inContainer()))()
      ? { available: false, why: "running in a container, which cannot hold its host awake" }
      : !argv || !bin
        ? { available: false, why: `no way to hold a ${this.deps.platform ?? process.platform} machine awake` }
        : !which(bin)
          ? { available: false, why: `${bin} is not installed` }
          : { available: true, why: null };
    return this.reason;
  }

  status(): AwakeInfo {
    const { available, why } = this.availability();
    return { mode: this.mode, holding: this.child !== null, available, why: why ?? this.ended, working: this.working };
  }

  start(): void {
    this.started = true;
    this.reconcile();
  }

  stop(): void {
    this.stopped = true;
    this.release();
  }

  setMode(mode: AwakeMode): void {
    this.mode = mode;
    this.reconcile();
  }

  /** how many agents work on this machine now; a change only matters in `working` */
  setWorking(n: number): void {
    if (n === this.working) return;
    this.working = n;
    this.reconcile();
  }

  private wanted(): boolean {
    if (!this.started || this.stopped || !this.availability().available) return false;
    return this.mode === "always" || (this.mode === "working" && this.working > 0);
  }

  private reconcile(): void {
    const want = this.wanted();
    if (want && !this.child) this.hold();
    else if (!want && this.child) this.release();
    this.tell();
  }

  private hold(): void {
    const argv = this.argv;
    if (!argv) return;
    let child: AwakeChild;
    try {
      child = (this.deps.spawn ?? spawnHold)(argv);
    } catch (err) {
      this.ended = `${argv[0]} did not start: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    this.child = child;
    this.ended = null;
    void child.exited.then((code) => {
      // a release kills it and has already let go; only an end of its own counts
      if (this.child !== child) return;
      this.child = null;
      const said = child.stderr?.().trim().split("\n").filter(Boolean).pop();
      this.ended = `${argv[0]} exited (${code})${said ? `: ${said}` : ""}`;
      this.tell();
    });
  }

  private release(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
  }

  /** the change, once: the runner says something many times a second */
  private tell(): void {
    const info = this.status();
    const key = JSON.stringify(info);
    if (key === this.last) return;
    this.last = key;
    this.deps.onChange?.(info);
  }
}

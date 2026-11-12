/**
 * Pulses: what this backend reads in the transcripts of its own live
 * agents (core/agentstatus `pulseOf`): the background work each one left
 * running, a long tool call, and whether a working one has stalled. Only
 * the machine an agent runs on holds its transcript, so every backend
 * reads its own cards (core/awake `ownCard`) and the page merges what
 * each says by card id.
 *
 * It reads every `PULSE_EVERY` while it has a card to read, and a moment
 * after the registry moves, so a turn that just ended says background or
 * idle within a second or two. A reading picks up where the last one
 * stopped (core/activity), so a quiet transcript costs a stat. A `pulse`
 * event carries only the pulses that changed and the cards it stopped
 * reading; `GET /api/agents/pulse` answers them all.
 */
import { pulseOf, pulsed, samePulse } from "../core/agentstatus";
import type { AgentActivity, AgentCard, AgentPulse, Harness, ServerEvent } from "../core/types";

/** ms between readings while a card is live */
export const PULSE_EVERY = 15_000;
/** how long after a registry change the next reading waits, so a burst of
 *  changes is one reading */
const NUDGE_MS = 1_500;

export type PulseReading = Pick<AgentActivity, "background" | "tool" | "writtenAt">;

export interface PulseDeps {
  /** the registry's cards, every one the broker holds */
  cards: () => AgentCard[];
  /** whether a card runs on this machine */
  own: (card: AgentCard, cards: readonly AgentCard[]) => boolean;
  /** a session's transcript read on this machine, null when it is not here */
  read: (harness: Harness, session: string, cwd: string) => Promise<PulseReading | null>;
  broadcast: (ev: ServerEvent) => void;
  /** ms between readings, 0 for none (tests call `tick`) */
  every?: number;
  now?: () => number;
}

export class PulseHub {
  private held = new Map<string, AgentPulse>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private nudged: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: PulseDeps) {}

  start(): void {
    const every = this.deps.every ?? PULSE_EVERY;
    if (this.timer || every <= 0) return;
    this.timer = setInterval(() => void this.tick(), every);
    void this.tick();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.nudged) clearTimeout(this.nudged);
    this.timer = null;
    this.nudged = null;
  }

  /** every pulse held */
  list(): AgentPulse[] {
    return [...this.held.values()];
  }

  /** reads again in a moment: the registry moved */
  nudge(): void {
    if (this.nudged || !this.timer) return;
    this.nudged = setTimeout(() => {
      this.nudged = null;
      void this.tick();
    }, NUDGE_MS);
  }

  /** One reading of every own live card, and an event for what changed.
   *  A reading asked for while one runs follows it once. */
  tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.readAll().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.tick();
      }
    });
    return this.running;
  }

  private async readAll(): Promise<void> {
    const cards = this.deps.cards();
    const next = new Map<string, AgentPulse>();
    for (const c of cards) {
      if (!pulsed(c) || c.session === null || c.harness === "other" || !this.deps.own(c, cards)) continue;
      const read = await this.deps.read(c.harness, c.session, c.cwd).catch(() => null);
      if (read) next.set(c.id, pulseOf(c, read, this.deps.now?.() ?? Date.now()));
    }
    const changed = [...next.values()].filter((p) => !samePulse(this.held.get(p.id), p));
    const gone = [...this.held.keys()].filter((id) => !next.has(id));
    this.held = next;
    if (changed.length || gone.length) this.deps.broadcast({ type: "pulse", pulses: changed, ...(gone.length ? { gone } : {}) });
  }
}

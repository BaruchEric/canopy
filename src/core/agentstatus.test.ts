import { describe, expect, test } from "bun:test";
import {
  STALL_MS,
  TOOL_SHOWN,
  TOOL_STALL_MS,
  agentStatus,
  backgroundWord,
  cardAsks,
  cardIdle,
  isLiveStatus,
  pulseOf,
  pulsed,
  samePulse,
  statusFromState,
  statusWord,
} from "./agentstatus";
import type { AgentActivity, AgentPulse, BackgroundTask } from "./types";

const pulse = (over: Partial<AgentPulse> = {}): AgentPulse => ({ id: "a", shells: 0, monitors: 0, agents: 0, tool: null, stalledSince: null, ...over });

describe("a card's status", () => {
  test("a session at its prompt is idle; any other wait is on you", () => {
    expect(cardIdle({ state: "idle", waiting: null })).toBe(true);
    expect(cardIdle({ state: "waiting", waiting: "your turn" })).toBe(true);
    expect(cardIdle({ state: "waiting", waiting: "permission" })).toBe(false);
    expect(cardAsks({ state: "waiting", waiting: "your turn" })).toBe(false);
    expect(cardAsks({ state: "waiting", waiting: "permission: Bash" })).toBe(true);
    // a wait that names nothing is one on you, the safe side
    expect(cardAsks({ state: "waiting", waiting: null })).toBe(true);
    expect(cardAsks({ state: "working", waiting: null })).toBe(false);
  });

  test("the card's state read finer, with its pulse and its asks", () => {
    const turn = { state: "waiting" as const, waiting: "your turn" };
    expect(agentStatus(turn)).toBe("idle");
    expect(agentStatus(turn, { pulse: pulse({ shells: 1 }) })).toBe("background");
    expect(agentStatus(turn, { asking: true })).toBe("waiting");
    expect(agentStatus({ state: "waiting", waiting: "permission" }, { pulse: pulse({ shells: 2 }) })).toBe("waiting");
    expect(agentStatus({ state: "working", waiting: null })).toBe("working");
    expect(agentStatus({ state: "working", waiting: null }, { pulse: pulse({ stalledSince: 5 }) })).toBe("stalled");
    // a stall needs the card to say it works
    expect(agentStatus({ state: "idle", waiting: null }, { pulse: pulse({ stalledSince: 5 }) })).toBe("idle");
    expect(agentStatus({ state: "ended", waiting: null }, { asking: true })).toBe("ended");
    expect(agentStatus({ state: "lost", waiting: "permission" })).toBe("lost");
    expect(statusFromState("waiting", "your turn")).toBe("idle");
    expect(statusFromState("waiting", undefined)).toBe("waiting");
    expect(isLiveStatus("background")).toBe(true);
    expect(isLiveStatus("ended")).toBe(false);
  });

  test("in a few words", () => {
    expect(statusWord({ state: "waiting", waiting: "permission" })).toBe("waiting on you: permission");
    expect(statusWord({ state: "idle", waiting: null }, { asking: true })).toBe("waiting on you");
    expect(statusWord({ state: "waiting", waiting: "your turn" })).toBe("idle");
    expect(statusWord({ state: "idle", waiting: null }, { pulse: pulse({ shells: 1, monitors: 1 }) })).toBe("background: 1 shell, 1 monitor");
    expect(statusWord({ state: "working", waiting: null }, { pulse: pulse({ tool: { name: "Bash", at: 1 } }) })).toBe("working: Bash");
    expect(statusWord({ state: "working", waiting: null }, { pulse: pulse({ tool: { name: "Bash", at: 1 }, stalledSince: 1 }) })).toBe("stalled in Bash");
    expect(statusWord({ state: "working", waiting: null }, { pulse: pulse({ stalledSince: 1 }) })).toBe("stalled");
    expect(backgroundWord(pulse({ shells: 2, monitors: 0, agents: 1 }))).toBe("2 shells, 1 agent");
    expect(backgroundWord(pulse())).toBe("");
  });

  test("a backend reads a pulse for a live card with a session", () => {
    expect(pulsed({ state: "idle", session: "s" })).toBe(true);
    expect(pulsed({ state: "idle", session: null })).toBe(false);
    expect(pulsed({ state: "ended", session: "s" })).toBe(false);
  });
});

describe("a pulse from a transcript's reading", () => {
  const now = 10 * 3_600_000;
  const card = { id: "a", state: "idle" as const, startedAt: now - 3_600_000 };
  const read = (over: Partial<Pick<AgentActivity, "background" | "tool" | "writtenAt">> = {}) => ({ background: [], tool: null, writtenAt: now, ...over });
  const task = (over: Partial<BackgroundTask>): BackgroundTask => ({ id: "b", kind: "shell", at: now - 60_000, until: null, ...over });

  test("counts this run's background work, a monitor until its timeout", () => {
    const p = pulseOf(
      card,
      read({
        background: [
          task({ id: "s1" }),
          task({ id: "s2", at: null }),
          // started by the process before a resume
          task({ id: "old", at: card.startedAt - 3 * 60_000 }),
          task({ id: "m1", kind: "monitor", until: now + 60_000 }),
          task({ id: "m2", kind: "monitor", until: now - 1 }),
          task({ id: "g1", kind: "agent" }),
        ],
      }),
      now,
    );
    expect(p).toEqual({ id: "a", shells: 2, monitors: 1, agents: 1, tool: null, stalledSince: null });
  });

  test("names a call once it has run a minute", () => {
    const working = { ...card, state: "working" as const };
    expect(pulseOf(working, read({ tool: { name: "Bash", at: now - 30_000 } }), now).tool).toBeNull();
    expect(pulseOf(working, read({ tool: { name: "Bash", at: now - TOOL_SHOWN } }), now).tool).toEqual({ name: "Bash", at: now - TOOL_SHOWN });
    expect(pulseOf(working, read({ tool: { name: "Bash", at: null } }), now).tool).toBeNull();
  });

  test("a working card stalls on a quiet transcript outside a call, or one call that never returns", () => {
    const working = { ...card, state: "working" as const };
    const quiet = now - STALL_MS;
    expect(pulseOf(working, read({ writtenAt: quiet + 1 }), now).stalledSince).toBeNull();
    expect(pulseOf(working, read({ writtenAt: quiet }), now).stalledSince).toBe(quiet);
    // a call in progress is no quiet, until it has run far past a shell's timeout
    expect(pulseOf(working, read({ writtenAt: quiet, tool: { name: "Bash", at: quiet } }), now).stalledSince).toBeNull();
    const long = now - TOOL_STALL_MS;
    expect(pulseOf(working, read({ writtenAt: long, tool: { name: "Bash", at: long } }), now).stalledSince).toBe(long);
    // a subagent may take as long as it takes
    expect(pulseOf(working, read({ writtenAt: long, tool: { name: "Agent", at: long } }), now).stalledSince).toBeNull();
    // an idle card never stalls
    expect(pulseOf(card, read({ writtenAt: long }), now).stalledSince).toBeNull();
  });

  test("two pulses that say the same", () => {
    expect(samePulse(undefined, pulse())).toBe(false);
    expect(samePulse(pulse(), pulse())).toBe(true);
    expect(samePulse(pulse({ tool: { name: "Bash", at: 1 } }), pulse({ tool: { name: "Bash", at: 1 } }))).toBe(true);
    expect(samePulse(pulse({ tool: { name: "Bash", at: 1 } }), pulse({ tool: { name: "Bash", at: 2 } }))).toBe(false);
    expect(samePulse(pulse({ shells: 1 }), pulse())).toBe(false);
    expect(samePulse(pulse({ stalledSince: 1 }), pulse())).toBe(false);
  });
});

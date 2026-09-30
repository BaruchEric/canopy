import { useState } from "react";
import { HARNESS } from "../../../src/core/harness";
import type { Harness } from "../../../src/core/types";
import { harnessesOf } from "../agents";
import { api } from "../api";
import { handoffPrompt, otherHarness } from "../handoff";
import { AGENT_NAME } from "../runs";
import { connOf, useStore } from "../store";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/**
 * Hands a session's work to the other harness: a new panel shell in the
 * same repo on the same backend, started with the other harness and told
 * where the first session's transcript is. The transcript is the one the
 * agent's registry card named when there is one; otherwise the shell's
 * backend looks up the newest one for its agent in the repo. Without either
 * the new agent starts on the repo alone.
 */
export async function handOff(repoId: string, from: Harness, transcript: string | null, term: string | null): Promise<void> {
  let path = transcript;
  if (!path && term) path = await api.termTranscript(term, from).then((r) => r.path, () => null);
  const prompt = handoffPrompt(from, path);
  useStore.getState().openTerm(repoId, "panel", "agent", prompt || undefined, { harness: otherHarness(from) });
}

/** "switch to codex" (or claude): greyed where the backend lacks the other
 *  harness. `onDone` runs after the shell is opened (the agents view goes
 *  to the git view, where the panel shows). */
export function HandoffButton({
  repoId,
  backend,
  from,
  transcript,
  term,
  className = "mini",
  onDone,
}: {
  repoId: string;
  backend: string;
  from: Harness;
  transcript: string | null;
  /** the shell the session runs in, qualified, for the transcript lookup */
  term: string | null;
  className?: string;
  onDone?: () => void;
}) {
  const has = useStore((s) => harnessesOf(connOf(s, backend).backend));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const to = otherHarness(from);
  const missing = !has.includes(to);
  const title = missing
    ? `${HARNESS[to].label} is not installed on ${backend}`
    : `A new shell here with ${AGENT_NAME[to]}, told where this ${AGENT_NAME[from]} session's transcript is so it can carry on`;
  const go = () => {
    setBusy(true);
    setErr(null);
    handOff(repoId, from, transcript, term)
      .then(() => onDone?.())
      .catch((e: unknown) => setErr(errText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <button type="button" className={className} disabled={missing || busy} title={err ?? title} aria-label={`Switch to ${HARNESS[to].label}`} onClick={go}>
        switch to {HARNESS[to].label}
      </button>
      {err && <span className="settings-hint error">{err}</span>}
    </>
  );
}

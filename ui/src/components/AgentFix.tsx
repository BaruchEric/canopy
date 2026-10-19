import { useState } from "react";
import { isSeedId } from "../../../src/core/sprout";
import { fixPrompt, type FixMove } from "../fixit";
import { useStore } from "../store";

/** "fix with the agent" beside a failed move: a chat on the repo, told
 *  what was pressed and what came back (`fixPrompt`). An idle chat there
 *  takes it as its next turn; a run still busy refuses, and the refusal
 *  shows beside the button. A seed's agents run through the incubator, so
 *  a seed gets none. */
export function AgentFix({ repoId, move, text }: { repoId: string; move: FixMove; text: string }) {
  const openChat = useStore((s) => s.openChat);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (isSeedId(repoId)) return null;
  const go = () => {
    setBusy(true);
    setErr(null);
    openChat(repoId, fixPrompt(move, text))
      .catch((e: unknown) => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <button
        type="button"
        className="mini note-act"
        disabled={busy}
        title="Start a chat on this repo with what failed, to find the cause, fix it and finish the move"
        onClick={go}
      >
        {busy ? "starting…" : "fix with the agent"}
      </button>
      {err && <span className="note-why">{err}</span>}
    </>
  );
}

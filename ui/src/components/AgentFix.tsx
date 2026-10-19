import { useState } from "react";
import { isSeedId } from "../../../src/core/sprout";
import { fixPrompt, type FixMove } from "../fixit";
import { useStore } from "../store";

/** what failed: a move and git's answer, or a prompt read when pressed
 *  (a failed task's, whose log is fetched then) */
type What = { move: FixMove; text: string } | { ask: () => Promise<string> };

/** "fix with the agent" beside a failed move or task (`short` words it
 *  "fix", for a task row with little room): a chat on the repo,
 *  told what was pressed and what came back (`fixPrompt`, `taskFixPrompt`).
 *  An idle chat there takes it as its next turn; a run still busy refuses,
 *  and the refusal shows beside the button. A seed's agents run through the
 *  incubator, so a seed gets none. */
export function AgentFix({ repoId, short, ...what }: { repoId: string; short?: boolean } & What) {
  const openChat = useStore((s) => s.openChat);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (isSeedId(repoId)) return null;
  const go = () => {
    setBusy(true);
    setErr(null);
    const prompt = "ask" in what ? what.ask() : Promise.resolve(fixPrompt(what.move, what.text));
    prompt
      .then((p) => openChat(repoId, p))
      .catch((e: unknown) => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <button
        type="button"
        className="mini note-act"
        disabled={busy}
        title="Fix with the agent: start a chat on this repo with what failed, to find the cause and fix it"
        onClick={go}
      >
        {busy ? "starting…" : short ? "fix" : "fix with the agent"}
      </button>
      {err && <span className="note-why">{err}</span>}
    </>
  );
}

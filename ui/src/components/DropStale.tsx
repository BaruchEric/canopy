import { useState } from "react";
import { api } from "../api";
import { offerAction, offerWords, type StaleOffer } from "../../../src/core/stalecopy";

/** The move a push refused for a stale copy offers (FR-048): drop the
 *  local commits upstream holds amends of, by moving the branch onto the
 *  upstream with `rebase --onto`, then push what is left. `onDone` gets
 *  what the server did; `onError` gets the refusal, whose words say why
 *  the branch was left as it was. */
export function DropStale({ repoId, offer, onDone, onError }: { repoId: string; offer: StaleOffer; onDone: (text: string) => void; onError: (err: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const go = () => {
    setBusy(true);
    api
      .dropStale(repoId, offer)
      .then(({ out }) => onDone(out))
      .catch(onError)
      .finally(() => setBusy(false));
  };
  return (
    <button type="button" className="mini strong note-act" disabled={busy} title={offerWords(offer)} onClick={go}>
      {busy ? "dropping…" : offerAction(offer)}
    </button>
  );
}

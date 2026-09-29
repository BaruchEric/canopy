import type { SyntheticEvent } from "react";
import { isFavorite, useStore } from "../store";

/** The ☆/★ that stars a repo in canopy. It swallows its own click, middle
 *  click and Enter, like RepoLink, so the card or row underneath does not
 *  open or get picked. Starred shows whenever; unstarred only on hover. */
export function Star({ repoId, name, onError }: { repoId: string; name: string; onError?: (msg: string) => void }) {
  const on = useStore((s) => isFavorite(s, repoId));
  const favoriteRepo = useStore((s) => s.favoriteRepo);
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  const toggle = async () => {
    try {
      await favoriteRepo(repoId, !on);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (onError) onError(msg);
      else console.error(msg);
    }
  };
  return (
    <button
      type="button"
      className={on ? "star on" : "star"}
      aria-pressed={on}
      aria-label={on ? `Unstar ${name}` : `Star ${name}`}
      title={on ? "A favorite; click to unstar" : "Star as a favorite"}
      onClick={(e) => {
        stop(e);
        void toggle();
      }}
      onAuxClick={stop}
      onKeyDown={stop}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

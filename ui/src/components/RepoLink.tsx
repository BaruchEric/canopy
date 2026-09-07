import type { SyntheticEvent } from "react";
import { linkLabel } from "../util";

/** The repo's remote, as a link out of canopy. Every way of activating a card
 *  opens the panel, so the anchor has to keep its click, its middle click and
 *  its Enter to itself. */
export function RepoLink({ url, name, labeled = false }: { url: string; name: string; labeled?: boolean }) {
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  return (
    <a
      className={labeled ? "card-link card-link-labeled" : "card-link"}
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      title={linkLabel(url)}
      aria-label={`Open ${name} at ${linkLabel(url)}`}
      onClick={stop}
      onAuxClick={stop}
      onKeyDown={stop}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M9.5 17H7.5a5 5 0 0 1 0-10h2" />
        <path d="M14.5 7h2a5 5 0 0 1 0 10h-2" />
        <path d="M8 12h8" />
      </svg>
      {labeled && <span>git remote</span>}
    </a>
  );
}

import type { SyntheticEvent } from "react";
import type { PeerState, PullCount, RemoteTip, RepoStatus } from "../../../src/core/types";
import { peerChips } from "../peers";
import { ago } from "../util";

/** The tooltip on a card's time: which change set it. The commit's subject
 *  alone when the commit is the newest thing; otherwise the edit or the
 *  remote-only commit that beat it, with the commit kept after. */
export function whenTitle(
  st: RepoStatus | null,
  edit: { path: string; at: number } | null,
): string | undefined {
  const commit = st?.lastCommit;
  const tip = st?.tip;
  const committed = commit ? `committed ${ago(commit.at)}: ${commit.subject}` : null;
  const editAt = edit?.at ?? 0;
  const tipAt = tip?.at ?? 0;
  const commitAt = commit?.at ?? 0;
  if (tip && tipAt > editAt && tipAt > commitAt) {
    return [`${tip.ref} pushed ${ago(tip.at)}: ${tip.subject}`, committed].filter(Boolean).join(" · ");
  }
  if (edit && editAt > commitAt) {
    return [`${edit.path} edited ${ago(edit.at)}`, committed].filter(Boolean).join(" · ");
  }
  return commit?.subject;
}

/** A remote-tracking branch with commits the checkout does not have: the
 *  branch's name, its commit and age in the tooltip. When that branch is
 *  the upstream itself, the behind count beside it already says so. */
export function RemoteTipChip({ tip, upstream }: { tip: RemoteTip; upstream: string | null }) {
  if (tip.ref === upstream) return null;
  return (
    <span className="tip" title={`${tip.ref} ${tip.hash} ${ago(tip.at)}: ${tip.subject}`}>
      ⇣ {tip.ref}
    </span>
  );
}

/** What a repo's peers have that this checkout does not: divergence, a
 *  peer's uncommitted work, or nothing else has this repo at all. */
export function PeerChips({ st }: { st: PeerState | undefined }) {
  const chips = peerChips(st);
  return (
    <>
      {chips.map((c) => (
        // title, not text: two branches diverged from the same peer by the
        // same counts, or two WIPs from one peer the same age, share text.
        <span key={`${c.kind}:${c.title}`} className={`peer peer-${c.kind}`} title={c.title}>
          {c.text}
        </span>
      ))}
    </>
  );
}

/** Open pull requests on GitHub, as a link to the list. Like the remote
 *  link, it keeps its clicks so the card under it does not open. */
export function Pulls({ pulls, name }: { pulls: PullCount; name: string }) {
  if (pulls.open === 0) return null;
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  return (
    <a
      className="pulls"
      href={pulls.url}
      target="_blank"
      rel="noreferrer noopener"
      title={`${pulls.open} open pull request${pulls.open === 1 ? "" : "s"} on GitHub`}
      aria-label={`${pulls.open} open pull request${pulls.open === 1 ? "" : "s"} on ${name}`}
      onClick={stop}
      onAuxClick={stop}
      onKeyDown={stop}
    >
      ⇄ {pulls.open}
    </a>
  );
}

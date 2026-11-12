import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { groupSum, sumParts, sumTitle } from "../badges";
import { headingAgentsOn, statusOf, useStore } from "../store";
import type { Repo } from "../../../src/core/types";

/** A section heading in the tree or the grid. The name is a button that
 *  folds the section; the counts stay in place, so a folded section still
 *  says what it holds. Alt+click folds or opens every group at once, the
 *  way the clicked one goes, as Finder does (`onToggleAll`). */
export function GroupHead({
  className,
  label,
  hint,
  open,
  onToggle,
  onToggleAll,
  children,
}: {
  className: string;
  label: string;
  hint?: string;
  open: boolean;
  onToggle: () => void;
  onToggleAll?: () => void;
  children?: ReactNode;
}) {
  const allHint = onToggleAll ? `Alt+click ${open ? "folds" : "opens"} every group` : undefined;
  return (
    <h2 className={open ? className : `${className} closed`}>
      <button
        type="button"
        className="head-toggle"
        aria-expanded={open}
        title={[hint, allHint].filter(Boolean).join("\n") || undefined}
        onClick={(e) => (e.altKey && onToggleAll ? onToggleAll() : onToggle())}
      >
        <svg
          className="caret"
          width="11"
          height="11"
          viewBox="0 0 10 10"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M3 1.5 7.5 5 3 8.5z" />
        </svg>
        <span className="head-name">{label}</span>
      </button>
      {children}
    </h2>
  );
}

/** A group heading's live sum: the grid's whole line (dirty, lines, not
 *  pushed, worktrees, agents working and waiting), or the narrow tree's
 *  dirty count, lines and agents with the rest in the tooltip. Nothing when
 *  the group is quiet. */
export function GroupSummary({ repos, compact = false }: { repos: readonly Repo[]; compact?: boolean }) {
  // the sum is plain numbers, so a shallow compare holds while none changed
  const sum = useStore(useShallow((s) => groupSum(repos, repos.map((r) => headingAgentsOn(s, r.id)), statusOf(s))));
  const parts = sumParts(sum, compact);
  if (parts.length === 0) return null;
  return (
    <span className="group-sum" title={compact ? sumTitle(sum) : undefined}>
      {parts.map((p) => (
        <span key={p.kind} className={p.cls} title={compact ? undefined : p.title}>
          {p.glyph && <span className="sum-glyph">{p.glyph}</span>}
          {p.text}
        </span>
      ))}
    </span>
  );
}

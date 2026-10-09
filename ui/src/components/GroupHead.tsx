import type { ReactNode } from "react";

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
          width="9"
          height="9"
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

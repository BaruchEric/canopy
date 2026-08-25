import type { ReactNode } from "react";

/** A section heading in the tree or the grid. The name is a button that
 *  folds the section; the counts stay in place, so a folded section still
 *  says what it holds. */
export function GroupHead({
  className,
  label,
  hint,
  open,
  onToggle,
  children,
}: {
  className: string;
  label: string;
  hint?: string;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <h2 className={open ? className : `${className} closed`}>
      <button
        type="button"
        className="head-toggle"
        aria-expanded={open}
        title={hint}
        onClick={onToggle}
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

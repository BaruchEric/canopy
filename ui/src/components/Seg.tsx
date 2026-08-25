export interface SegOption<T extends string> {
  value: T;
  label: string;
  /** tooltip; say what the option does, in one line */
  title?: string;
}

/** A row of mutually exclusive choices, used for grouping and every setting. */
export function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly SegOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      className={className ? `seg ${className}` : "seg"}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

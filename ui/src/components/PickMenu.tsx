import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { HANGS_LEFT, useFitPop } from "../pop";
import { PopGrip } from "./PopGrip";
import { escapeCloses } from "../surface";

/** One choice in a pick menu: its name, and the line under it that says what
 *  picking it does. */
export interface PickOption {
  value: string;
  label: ReactNode;
  what?: ReactNode;
  title?: string;
}

/** A run of choices under a heading; one group can go without one. */
export interface PickGroup {
  label?: string;
  options: PickOption[];
}

/** The caret that says a word opens more of them. */
export function Caret() {
  return (
    <svg className="pick-caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One word on the bar that opens the rest: the choice in use is the button,
 * and the menu lists every choice in its groups, each with what it does. A
 * pick closes it; Escape or a press outside does too, and the arrows step
 * between the choices. On a phone the menu comes up from the bottom edge as
 * a sheet, as every `.settings-pop` does.
 */
export function PickMenu({
  label,
  value,
  groups,
  onPick,
  trigger,
  title,
  hint,
  className = "",
}: {
  /** what the choices are, for a screen reader: "Group repos by" */
  label: string;
  value: string | null;
  groups: PickGroup[];
  onPick: (value: string) => void;
  /** what the button shows: the choice in use, as the bar wants it */
  trigger: ReactNode;
  title?: string;
  /** a line at the foot of the menu */
  hint?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    // the choice in use takes the focus, so the arrows start from it
    const list = ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    const on = ref.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]');
    (on ?? list?.[0])?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      escapeCloses(e, () => {
        setOpen(false);
        button.current?.focus();
      });
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const step = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const by = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (by === 0 && e.key !== "Home" && e.key !== "End") return;
    const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    if (list.length === 0) return;
    e.preventDefault();
    const at = list.findIndex((b) => b === document.activeElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : (at + by + list.length) % list.length;
    list[next]?.focus();
  };

  return (
    <div className={`settings pick ${className}`} ref={ref}>
      <button
        ref={button}
        type="button"
        className={open ? "pill pick-btn open" : "pill pick-btn"}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={title}
        onClick={() => setOpen(!open)}
      >
        {trigger}
        <Caret />
      </button>
      {open && (
        <div className="settings-pop pick-pop" role="dialog" aria-label={label} onKeyDown={step}>
          {groups.map((g, i) => (
            <section key={g.label ?? i} className="settings-row">
              {g.label && <h3 className="panel-label">{g.label}</h3>}
              <div className="sort-list" role="radiogroup" aria-label={g.label ?? label}>
                {g.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={o.value === value}
                    title={o.title}
                    onClick={() => {
                      onPick(o.value);
                      setOpen(false);
                      button.current?.focus();
                    }}
                  >
                    <span className="sort-name">{o.label}</span>
                    {o.what && <span className="sort-what">{o.what}</span>}
                  </button>
                ))}
              </div>
            </section>
          ))}
          {hint && <p className="settings-hint pick-hint">{hint}</p>}
          <PopGrip name={`pick ${label}`} anchor={HANGS_LEFT} />
        </div>
      )}
    </div>
  );
}

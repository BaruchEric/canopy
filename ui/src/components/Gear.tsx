import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { keptForNow } from "../screens";

/** One line of a gear's menu. */
export type GearEntry =
  /** a zoom: less, the level, more, and back to `home` (100% when none) */
  | {
      type: "zoom";
      label: string;
      value: string;
      less: (() => void) | null;
      more: (() => void) | null;
      reset: (() => void) | null;
      home?: string;
      /** what grows and shrinks, when it is not the zoom: "command text" */
      what?: string;
    }
  /** something kept that can be dropped: a remembered rule, with a line
   *  under it saying where it applies */
  | {
      type: "forget";
      label: string;
      sub?: string;
      title?: string;
      forget: () => unknown;
    }
  /** a line of text, when a group has nothing else to show */
  | { type: "note"; label: string }
  /** something to do. `on` marks the current choice of a set; `stay` keeps
   *  the menu open, and whatever `run` resolves to shows at its foot, which
   *  is how a copy or a capture says where it went */
  | {
      type: "item";
      label: string;
      run: () => unknown;
      on?: boolean;
      /** why it cannot run here; the item shows but does nothing */
      off?: string;
      title?: string;
      stay?: boolean;
    }
  /** a row of an ordered list that can be switched off: a panel's sections */
  | {
      type: "row";
      label: string;
      on: boolean;
      toggle: () => void;
      up: (() => void) | null;
      down: (() => void) | null;
    };

export interface GearGroup {
  label: string;
  entries: GearEntry[];
}

const MENU_W = 256;

/** The one settings icon: every gear has it, and so does the top bar's
 *  settings button. */
export function GearIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M6.6 1h2.8l.4 2 1.4.8 1.9-.7 1.4 2.4-1.5 1.3v1.6l1.5 1.3-1.4 2.4-1.9-.7-1.4.8-.4 2H6.6l-.4-2-1.4-.8-1.9.7-1.4-2.4L3 8.8V7.2L1.5 5.9l1.4-2.4 1.9.7 1.4-.8zM8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z"
      />
    </svg>
  );
}

/**
 * The ⚙ on a panel, a section, a shell or the feed: its zoom, how it sits,
 * and sharing it, in a menu rendered through a portal so a panel's
 * `overflow: hidden` cannot clip it. Closed by an outside click or Escape;
 * kept beside its button through scrolls, resizes and zooms.
 */
export function Gear({
  label,
  groups,
  hint = "Zoom, layout and sharing",
  keptElse,
}: {
  label: string;
  groups: GearGroup[];
  hint?: string;
  /** what the menu holds that is kept somewhere else, said at its foot */
  keptElse?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // read as the menu opens: the screen the window is on now
  const keptFor = open ? keptForNow() : null;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    if (!trigger.current || !menu.current) return;
    const r = trigger.current.getBoundingClientRect();
    const h = menu.current.offsetHeight;
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - 6 - h) : below;
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
      trigger.current?.focus();
    };
    // a zoom moves the button under the menu; follow it rather than close
    const follow = () => requestAnimationFrame(place);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open, place]);

  const buttons = () =>
    Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);

  useEffect(() => {
    if (open && pos && !menu.current?.contains(document.activeElement)) buttons()[0]?.focus();
  }, [open, pos]);

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const list = buttons();
    const i = list.findIndex((el) => el === document.activeElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next !== null) {
      e.preventDefault();
      list[next]?.focus();
    }
  };

  const act = (fn: () => unknown, stay: boolean) => {
    setNote(null);
    let out: unknown;
    try {
      out = fn();
    } catch (err) {
      setNote({ ok: false, text: String(err instanceof Error ? err.message : err) });
      return;
    }
    if (!stay) {
      setOpen(false);
      return;
    }
    requestAnimationFrame(place);
    void Promise.resolve(out).then(
      (text) => {
        if (typeof text === "string" && text) setNote({ ok: true, text });
      },
      (err: unknown) => setNote({ ok: false, text: String(err instanceof Error ? err.message : err) }),
    );
  };

  // events inside the portal bubble through React to what holds the gear:
  // a card that opens on click, a section that leaves focus on Escape
  const swallow = (e: SyntheticEvent) => e.stopPropagation();

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`gear${open ? " on" : ""}`}
        aria-label={`Settings for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={hint}
        onClick={(e) => {
          e.stopPropagation();
          setPos(null);
          setNote(null);
          setOpen(!open);
        }}
        onPointerDown={swallow}
        onKeyDown={swallow}
      >
        <GearIcon />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="menu gear-pop"
            role="menu"
            aria-label={`Settings for ${label}`}
            style={{ width: MENU_W, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            onKeyDown={(e) => {
              onMenuKey(e);
              swallow(e);
            }}
            onClick={swallow}
            onPointerDown={swallow}
          >
            {groups
              .filter((g) => g.entries.length > 0)
              .map((g) => (
                <div key={g.label} className="gear-group" role="group" aria-label={g.label}>
                  <p className="menu-label">{g.label}</p>
                  {g.entries.map((entry) => (
                    <Entry key={`${entry.type}:${entry.label}${entry.type === "forget" ? `:${entry.sub ?? ""}` : ""}`} entry={entry} act={act} />
                  ))}
                </div>
              ))}
            {note && (
              <p className={`gear-note${note.ok ? "" : " err"}`} role="status">
                {note.text}
              </p>
            )}
            {keptFor && (
              <p className="gear-where">
                Kept for this {keptFor}
                {keptElse ? `; ${keptElse}` : ""}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function Entry({ entry, act }: { entry: GearEntry; act: (fn: () => unknown, stay: boolean) => void }) {
  switch (entry.type) {
    case "zoom":
      return (
        <div className="gear-zoom">
          <span className="gear-zoom-label">{entry.label}</span>
          <button
            type="button"
            role="menuitem"
            aria-label={entry.what ? `Smaller ${entry.what}` : "Zoom out"}
            disabled={!entry.less}
            onClick={() => entry.less && act(entry.less, true)}
          >
            −
          </button>
          <button
            type="button"
            role="menuitem"
            className="gear-zoom-value"
            title={`Back to ${entry.home ?? "100%"}`}
            aria-label={`${entry.what ? `${entry.what[0]?.toUpperCase()}${entry.what.slice(1)}` : "Zoom"} ${entry.value}, back to ${entry.home ?? "100%"}`}
            disabled={!entry.reset}
            onClick={() => entry.reset && act(entry.reset, true)}
          >
            {entry.value}
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label={entry.what ? `Larger ${entry.what}` : "Zoom in"}
            disabled={!entry.more}
            onClick={() => entry.more && act(entry.more, true)}
          >
            +
          </button>
        </div>
      );
    case "item":
      return (
        <button
          type="button"
          role={entry.on === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={entry.on}
          className={`menu-item gear-item${entry.on ? " on" : ""}`}
          aria-disabled={entry.off ? true : undefined}
          title={entry.off ?? entry.title}
          onClick={() => {
            if (!entry.off) act(entry.run, entry.stay ?? false);
          }}
        >
          <span className="gear-mark" aria-hidden="true">
            {entry.on ? "●" : ""}
          </span>
          <span className="menu-text">{entry.label}</span>
        </button>
      );
    case "note":
      return <p className="gear-line">{entry.label}</p>;
    case "forget":
      return (
        <div className="gear-row gear-forget">
          <span className="gear-kept" title={entry.title ?? entry.label}>
            <span className="menu-text">{entry.label}</span>
            {entry.sub && <span className="gear-sub">{entry.sub}</span>}
          </span>
          <button type="button" role="menuitem" className="gear-move" aria-label={`Forget ${entry.label}`} title="Forget it: this asks again" onClick={() => act(entry.forget, true)}>
            ✕
          </button>
        </div>
      );
    case "row":
      return (
        <div className="gear-row">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={entry.on}
            className="menu-item gear-item"
            title={entry.on ? `Hide ${entry.label} in every panel` : `Show ${entry.label} in every panel`}
            onClick={() => act(entry.toggle, true)}
          >
            <span className="gear-mark" aria-hidden="true">
              {entry.on ? "✓" : ""}
            </span>
            <span className={`menu-text${entry.on ? "" : " off"}`}>{entry.label}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="gear-move"
            aria-label={`Move ${entry.label} up`}
            disabled={!entry.up}
            onClick={() => entry.up && act(entry.up, true)}
          >
            ↑
          </button>
          <button
            type="button"
            role="menuitem"
            className="gear-move"
            aria-label={`Move ${entry.label} down`}
            disabled={!entry.down}
            onClick={() => entry.down && act(entry.down, true)}
          >
            ↓
          </button>
        </div>
      );
  }
}

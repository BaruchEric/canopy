import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { PHONE, useMedia } from "../media";
import { oneMenu } from "../menus";
import type { BoxChip, BoxChipId, BoxMenu } from "../startbox";
import { menuSpot } from "./Gear";
import type { useMentions } from "./Mentions";
import { Caret } from "./PickMenu";
import { PopGear } from "./PopGrip";

/** px; the gears' menus are as wide */
const MENU_W = 256;

/** A chip that opens its choices. The menu goes through a portal, as a
 *  gear's does, so the sheet's `overflow: hidden` cannot clip it; on a phone
 *  it comes up from the bottom edge. Escape closes the menu and leaves the
 *  sheet open. */
function ChipMenu({ chip, menu, onPick }: { chip: BoxChip; menu: BoxMenu; onPick: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const asSheet = useMedia(PHONE);

  const place = useCallback(() => {
    if (!trigger.current || !list.current) return;
    const r = trigger.current.getBoundingClientRect();
    // hung off the chip's left edge: menuSpot hangs a menu off a right edge
    setPos(menuSpot({ right: r.left + MENU_W, top: r.top, bottom: r.bottom }, list.current.offsetHeight, MENU_W, { w: window.innerWidth, h: window.innerHeight }));
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const release = oneMenu(close);
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (!list.current?.contains(t) && !trigger.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // in capture and stopped, so the sheet under the menu stays open
      e.stopPropagation();
      close();
      trigger.current?.focus();
    };
    const follow = () => requestAnimationFrame(place);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      release();
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open, place]);

  const rows = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);

  // the choice in use takes the focus once the menu has its place
  useEffect(() => {
    if (!open || (!pos && !asSheet) || list.current?.contains(document.activeElement)) return;
    (list.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? rows()[0])?.focus();
  }, [open, pos, asSheet]);

  const onListKey = (e: ReactKeyboardEvent) => {
    const all = rows();
    const i = all.findIndex((el) => el === document.activeElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (i + 1) % all.length;
    else if (e.key === "ArrowUp") next = (i - 1 + all.length) % all.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = all.length - 1;
    if (next !== null) {
      e.preventDefault();
      all[next]?.focus();
    }
    // the words box under the menu reads no key pressed here
    e.stopPropagation();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`start-chip start-pick${open ? " on" : ""}`}
        data-chip={chip.id}
        aria-haspopup="menu"
        aria-expanded={open}
        title={chip.title}
        onClick={() => {
          setPos(null);
          setOpen(!open);
        }}
      >
        <span className="start-chip-text">{chip.text}</span>
        <Caret />
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            className={`menu gear-pop start-menu${asSheet ? " gear-sheet" : ""}`}
            role="menu"
            aria-label={menu.label}
            style={asSheet ? undefined : { width: MENU_W, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            onKeyDown={onListKey}
          >
            <p className="menu-label">{menu.label}</p>
            {menu.options.map((o) => {
              const on = o.value === menu.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  className={`menu-item gear-item${on ? " on" : ""}`}
                  onClick={() => {
                    onPick(o.value);
                    setOpen(false);
                    trigger.current?.focus();
                  }}
                >
                  <span className="gear-mark" aria-hidden="true">
                    {on ? "●" : ""}
                  </span>
                  <span className="start-opt">
                    <span className="menu-text">{o.label}</span>
                    {o.what && <span className="start-what">{o.what}</span>}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

/** One chip: a menu where the pre-flight lets it be changed, plain text
 *  where it does not. */
function Chip({ chip, onPick }: { chip: BoxChip; onPick: (id: BoxChipId, value: string) => void }) {
  if (chip.menu === null) {
    return (
      <span className="start-chip" data-chip={chip.id} title={chip.title}>
        <span className="start-chip-text">{chip.text}</span>
      </span>
    );
  }
  return <ChipMenu chip={chip} menu={chip.menu} onPick={(value) => onPick(chip.id, value)} />;
}

/**
 * The start box (FR-079): the pre-flight of one plain run or chat as one
 * box, at the intermediate level. The words, with the chips of where the run
 * works on the box's top edge and the loadout or model on its bottom edge,
 * then send. "more options" opens the full pre-flight with the words and the
 * picks kept. It holds no state of its own: `Plan` in RunSheet.tsx draws it
 * from the pre-flight's state and starts the run, so the box sends what the
 * pre-flight sends. What each chip reads is in `../startbox`.
 */
export function StartBox({
  agentName,
  workspace,
  verb,
  repoText,
  top,
  agent,
  onPick,
  note,
  setNote,
  noteBox,
  mentions,
  placeholder,
  notes,
  held,
  error,
  busy,
  ready,
  onSend,
  onMore,
  onClose,
}: {
  /** the head's words, as the full pre-flight has them */
  agentName: string;
  workspace: string | undefined;
  verb: string;
  repoText: string;
  /** the chips on the top edge, and the one on the bottom edge */
  top: readonly BoxChip[];
  agent: BoxChip;
  onPick: (id: BoxChipId, value: string) => void;
  note: string;
  setNote: (text: string) => void;
  noteBox: RefObject<HTMLTextAreaElement | null>;
  mentions: ReturnType<typeof useMentions>;
  placeholder: string;
  /** what the pre-flight would tell a person before this start (`boxNotes`) */
  notes: readonly string[];
  /** why send is held, when it is */
  held: string | null;
  error: string | null;
  busy: boolean;
  ready: boolean;
  onSend: () => void;
  onMore: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <header className="sheet-head">
        <div>
          <div className="eyebrow">
            with {agentName}
            {workspace && ` · in workspace ${workspace}`}
          </div>
          <h2 className="sheet-title">
            {verb} <span className="sheet-repo">{repoText}</span>
          </h2>
        </div>
        {/* the sheet's focus goes to the words, so the gear steps aside */}
        <span className="start-gear no-autofocus">
          <PopGear />
        </span>
        <button type="button" className="mini close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="sheet-body start">
        <div className="start-box">
          {/* no-autofocus: the sheet's focus goes to the words, not to a chip */}
          <div className="start-edge no-autofocus" role="group" aria-label="Where the run works">
            {top.map((chip) => (
              <Chip key={chip.id} chip={chip} onPick={onPick} />
            ))}
          </div>
          <div className="mention-host">
            <textarea
              ref={noteBox}
              className="start-words"
              rows={3}
              placeholder={placeholder}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (mentions.onKeyDown(e)) return;
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSend();
              }}
              aria-label={`What ${agentName} should do`}
            />
            {mentions.menu}
          </div>
          <div className="start-edge start-foot">
            <span className="start-with no-autofocus" role="group" aria-label="What the run starts with">
              <Chip chip={agent} onPick={onPick} />
            </span>
            <span className="spacer" />
            <button type="button" className="start-more no-autofocus" title="Several tries at once, a PR when done, the dev task, canopy's tools, the priority and what will happen" onClick={onMore}>
              more options
            </button>
            <button type="button" className="mini strong start-send no-autofocus" disabled={!ready} title="⌘↩" onClick={onSend}>
              {busy ? "starting…" : "send"}
            </button>
          </div>
        </div>
        {notes.map((line) => (
          <p key={line} className="note start-note">
            {line}
          </p>
        ))}
        {held && <p className="note start-held">{held}</p>}
        {error && <p className="note err">{error}</p>}
      </div>
    </>
  );
}

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { RunStep } from "../../../src/core/types";
import { TYPES_INTO } from "../kbfocus";
import { PHONE, useMedia } from "../media";
import { FOLLOW_SLACK, RAIL_MIN, boxIsEmpty, cardSlide, jumpTop, pickRail, railItems, railMarked, railPlace, railStep, tickLabel, type RailItem } from "../promptrail";

/** where a finger does the pointing, or the window is a phone's: the ticks
 *  give way to a bar with the place and two buttons */
const TOUCH = `${PHONE}, (pointer: coarse)`;
/** The reading line, as the part of the timeline's body under it: a message
 *  that has come up to the line, 40% of the way down, is the one in view. */
const UNDER_LINE = 60;
/** How far over the body's top a message still counts as past the line, px:
 *  further than a timeline is long. With no upper edge to leave by, a message
 *  changes sides only at the line, so a jump of any length is reported. */
const OVER_TOP = 10_000_000;
/** how far past the body's foot the end of the timeline still counts as in view, px */
const END_REACH = 32;
/** how long a jump's own scrolling may take to reach the observers, ms */
const SETTLE_MS = 250;
/** the room left over a message a jump brings to the top, px */
const JUMP_GAP = 8;
/** how long the message a jump landed on stays lit, ms */
const LIT_MS = 1100;

/** a rail on the page, as the keys see it */
interface LiveRail {
  list: HTMLElement;
  /** the rail as drawn, or null before it is */
  nav: () => HTMLElement | null;
  step: (dir: 1 | -1) => void;
}
const rails = new Set<LiveRail>();
/** the timeline the pointer was last over */
let pointed: HTMLElement | null = null;

const depthOf = (el: Element): number => {
  let n = 1;
  for (let p = el.parentElement; p; p = p.parentElement) n++;
  return n;
};

/** what a field holds: a box's value, anything else's text */
const wordsIn = (el: Element): string => (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : (el.textContent ?? ""));

/** Steps the rail of the timeline in hand to the message before (-1) or
 *  after (1): the keys' half of the rail (App.tsx, `message-prev` and
 *  `message-next`). `from` is what the press was made in: a press typed
 *  into a field steps only the timeline that field is the message box of,
 *  and only while the box is empty, so a draft and any other field keep
 *  their own Alt and arrows. False when no rail takes the press, which
 *  then stays the browser's. */
export function stepPromptRail(dir: 1 | -1, from: Element | null = null): boolean {
  const typed = from?.closest(TYPES_INTO) ?? null;
  if (typed !== null && !boxIsEmpty(wordsIn(typed))) return false;
  const live = [...rails].filter((r) => typed === null || (r.list.parentElement?.contains(typed) ?? false));
  const active = document.activeElement;
  const over = document.querySelector(".sheet-back");
  const rail = live[
    pickRail(
      live.map((r) => {
        const host = r.list.parentElement;
        return {
          shown: (r.nav()?.getClientRects().length ?? 0) > 0,
          modal: over?.contains(r.list) ?? false,
          focus: host && active && host.contains(active) ? depthOf(host) : 0,
          pointed: r.list === pointed,
        };
      }),
    )
  ];
  if (!rail) return false;
  rail.step(dir);
  return true;
}

/** `el`'s top inside `box`'s scrolled content, in the box's own px. Summed
 *  from offsets, which a zoomed panel and a step's rise-in leave alone,
 *  where a bounding box would be scaled and moved. */
function topWithin(el: HTMLElement, box: HTMLElement): number {
  let y = 0;
  let node: Element | null = el;
  while (node instanceof HTMLElement && node !== box && box.contains(node)) {
    y += node.offsetTop;
    node = node.offsetParent;
  }
  // the offsets were counted from an ancestor of the box, so its own comes off
  return node === box ? y : y - box.offsetTop - box.clientTop;
}

/** The timeline's own message elements, wherever its steps are drawn, and
 *  none of a timeline nested in it (a workflow's step at its gate). */
const messagesIn = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>("[data-prompt]")].filter((el) => el.closest(".console") === root);

const messageIn = (root: HTMLElement, id: string): HTMLElement | null =>
  messagesIn(root).find((el) => el.getAttribute("data-prompt") === id) ?? null;

/** the height of the checklist pinned over the timeline's top, which a message must clear */
const pinnedOver = (root: HTMLElement): number => {
  const todos = root.querySelector(":scope > .todos");
  return todos instanceof HTMLElement ? todos.offsetHeight : 0;
};

/**
 * The prompt rail (FR-078): one tick per message the person sent, down the
 * edge of a run's timeline. The tick of the message in view is marked, a
 * tick under the pointer or the keyboard's focus shows a card with the
 * message's first words, the reply's and its place, and a click brings the
 * message to the top. On a touch screen the ticks are a bar at the
 * timeline's foot instead: the place, which opens the list of messages,
 * between a button for the one before and one for the one after.
 *
 * It is the first child of the timeline's scrolling body, which `list`
 * names, and `PromptRailEnd` is the last. `onFollow` sets the timeline's
 * own "follow the newest step": a jump to an older message turns it off,
 * as scrolling up does, and a jump that lands at the end turns it on.
 */
export function PromptRail({ steps, list, onFollow }: { steps: readonly RunStep[]; list: RefObject<HTMLDivElement | null>; onFollow: (on: boolean) => void }) {
  const items = useMemo(() => railItems(steps), [steps]);
  if (items.length < RAIL_MIN) return null;
  return <Rail items={items} list={list} onFollow={onFollow} />;
}

/** The end of a timeline's scrolling body: the mark the rail knows "at the
 *  newest step" by, and the foot its bar sits in on a touch screen. */
export function PromptRailEnd() {
  return (
    <>
      <span className="prompt-rail-end" aria-hidden="true" />
      <div className="prompt-rail-foot" />
    </>
  );
}

function Rail({ items, list, onFollow }: { items: readonly RailItem[]; list: RefObject<HTMLDivElement | null>; onFollow: (on: boolean) => void }) {
  const touch = useMedia(TOUCH);
  const nav = useRef<HTMLElement>(null);
  const cardId = useId();
  // what the observers last said: how many messages have reached the
  // reading line, and whether the timeline's end is in view
  const [view, setView] = useState({ passed: items.length, atEnd: true });
  // a jump's target, marked until the view next moves
  const [held, setHeld] = useState<number | null>(null);
  const [peek, setPeek] = useState<{ at: number; top: number; slide: number } | null>(null);
  const [foot, setFoot] = useState<Element | null>(null);
  const settleAt = useRef(0);
  const seen = useRef("");
  // the line's observer and the elements it watches already
  const watch = useRef<{ line: IntersectionObserver; known: WeakSet<Element> } | null>(null);
  const lit = useRef<{ el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(null);
  const total = items.length;
  const marked = railMarked({ total, ...view, held });
  // the observers are made again only when the messages themselves change
  const ids = items.map((i) => i.id).join("\n");

  // Which message is in view, without a scroll listener: one observer says
  // when a message crosses the reading line, a second when the timeline's
  // end comes into view.
  useEffect(() => {
    const root = list.current;
    if (!root || typeof IntersectionObserver !== "function") return;
    const order = new Map(ids.split("\n").map((id, i) => [id, i] as const));
    // by element, since a step drawn again keeps its id and not its element
    const reached = new Set<Element>();
    let atEnd = true;
    const tell = () => {
      let passed = 0;
      for (const el of reached) {
        if (el.isConnected) passed = Math.max(passed, (order.get(el.getAttribute("data-prompt") ?? "") ?? -1) + 1);
      }
      const now = `${passed} ${atEnd}`;
      if (now !== seen.current) {
        // a message crossed the line or the end came or went: the view
        // moved, so a jump's target lets go. The jump's own scrolling
        // arrives here too, a moment after it.
        if (seen.current !== "" && performance.now() >= settleAt.current) setHeld(null);
        seen.current = now;
      }
      setView((v) => (v.passed === passed && v.atEnd === atEnd ? v : { passed, atEnd }));
    };
    // A timeline out of sight (a hidden panel) reports every message as off
    // the line and, shown again, the ones on it: the set stays the
    // observer's own, so nothing here is skipped.
    const line = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) reached.add(e.target);
          else reached.delete(e.target);
        }
        tell();
      },
      { root, rootMargin: `${OVER_TOP}px 0px -${UNDER_LINE}% 0px` },
    );
    watch.current = { line, known: new WeakSet() };
    const tail = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        if (!e) return;
        atEnd = e.isIntersecting;
        tell();
      },
      { root, rootMargin: `0px 0px ${END_REACH}px 0px` },
    );
    const end = root.querySelector(":scope > .prompt-rail-end");
    if (end) tail.observe(end);
    return () => {
      line.disconnect();
      tail.disconnect();
      watch.current = null;
    };
  }, [ids, list]);
  // Every message drawn is watched, looked over after each render: the
  // messages of a new set, and a step whose element was made again under
  // the same id (a level that draws the timeline another way). No layout
  // is read, and a watched element is passed by.
  useEffect(() => {
    const root = list.current;
    const now = watch.current;
    if (!root || !now) return;
    for (const el of messagesIn(root)) {
      if (now.known.has(el)) continue;
      now.known.add(el);
      now.line.observe(el);
    }
  });

  // The ticks run the height of the timeline's body, which only the body
  // knows: its observer hands the rail that height when it changes.
  useEffect(() => {
    const root = list.current;
    const el = nav.current;
    if (touch || !root || !el || typeof ResizeObserver !== "function") return;
    const sizer = new ResizeObserver((entries) => {
      const h = entries[entries.length - 1]?.contentRect.height;
      if (h !== undefined) el.style.setProperty("--rail-h", `${Math.max(0, Math.floor(h))}px`);
    });
    sizer.observe(root);
    return () => sizer.disconnect();
  }, [list, touch]);

  // On a touch screen the bar sits in the foot PromptRailEnd left. Looked
  // for once the timeline's body is mounted, which is after this rail is.
  useEffect(() => {
    setFoot(touch ? (list.current?.querySelector(":scope > .prompt-rail-foot") ?? null) : null);
  }, [list, touch]);
  // The bar takes room at the timeline's foot. A timeline that was at its
  // end when the bar came stays there, or the bar would cover its last lines.
  useLayoutEffect(() => {
    const root = list.current;
    const bar = nav.current;
    if (!touch || !foot || !root || !bar) return;
    if (root.scrollHeight - root.scrollTop - root.clientHeight < bar.offsetHeight + FOLLOW_SLACK) root.scrollTo({ top: root.scrollHeight, behavior: "instant" });
  }, [list, touch, foot]);

  /** Brings message `to` to the top of the timeline, or with "end" the
   *  newest step; at once, since a glide across a long chat is no jump. */
  const jump = (to: number | "end") => {
    const root = list.current;
    if (!root) return;
    if (to === "end") {
      onFollow(true);
      setHeld(null);
      root.scrollTo({ top: root.scrollHeight, behavior: "instant" });
      return;
    }
    const item = items[to];
    const el = item ? messageIn(root, item.id) : null;
    if (!el) return;
    const landing = jumpTop(topWithin(el, root) - pinnedOver(root) - JUMP_GAP, root.scrollHeight - root.clientHeight);
    // before the scroll, so a step arriving in between cannot pull the view back down
    onFollow(landing.follow);
    settleAt.current = performance.now() + SETTLE_MS;
    setHeld(to);
    root.scrollTo({ top: landing.top, behavior: "instant" });
    if (lit.current) {
      clearTimeout(lit.current.timer);
      lit.current.el.removeAttribute("data-rail-lit");
    }
    el.setAttribute("data-rail-lit", "");
    lit.current = {
      el,
      timer: setTimeout(() => {
        el.removeAttribute("data-rail-lit");
        lit.current = null;
      }, LIT_MS),
    };
  };
  useEffect(
    () => () => {
      if (!lit.current) return;
      clearTimeout(lit.current.timer);
      lit.current.el.removeAttribute("data-rail-lit");
    },
    [],
  );

  const step = (dir: 1 | -1) => {
    const root = list.current;
    const item = items[marked];
    const el = root && item ? messageIn(root, item.id) : null;
    // measured now, on the press: whether the marked message's top is out of sight above
    const above = root !== null && el !== null && topWithin(el, root) - root.scrollTop < pinnedOver(root) - 1;
    const to = railStep({ marked, dir, total, above });
    if (to !== null) jump(to);
  };

  // the keys reach this rail through the page's list of them
  const stepNow = useRef(step);
  useEffect(() => {
    stepNow.current = step;
  });
  useEffect(() => {
    const root = list.current;
    if (!root) return;
    const me: LiveRail = { list: root, nav: () => nav.current, step: (dir) => stepNow.current(dir) };
    const point = () => {
      pointed = root;
    };
    rails.add(me);
    root.addEventListener("pointerenter", point);
    return () => {
      rails.delete(me);
      root.removeEventListener("pointerenter", point);
      if (pointed === root) pointed = null;
    };
  }, [list]);

  if (touch) {
    if (!foot) return null;
    const here = items[marked];
    return createPortal(
      <nav ref={nav} className="rail-bar no-autofocus" aria-label="Your messages">
        <button type="button" className="rail-go" aria-label="The message before" onClick={() => step(-1)}>
          ↑
        </button>
        <div className="rail-where">
          <span className="rail-where-n" aria-hidden="true">
            {railPlace(marked + 1, total)}
          </span>
          <span className="rail-where-words" aria-hidden="true">
            {here?.label}
          </span>
          <span className="rail-where-open" aria-hidden="true">
            ▾
          </span>
          <select aria-label="Jump to one of your messages" value={marked} onChange={(e) => jump(Number(e.target.value))}>
            {items.map((item, i) => (
              <option key={item.id} value={i}>
                {item.n}. {item.label}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="rail-go" aria-label="The message after" onClick={() => step(1)}>
          ↓
        </button>
      </nav>,
      foot,
    );
  }

  const show = (at: number, tick: HTMLElement) => {
    const center = tick.offsetTop + tick.offsetHeight / 2;
    setPeek({ at, top: center, slide: cardSlide(center, tick.parentElement?.clientHeight ?? 0) });
  };
  // the arrows walk the ticks, each showing its card; Enter or Space jumps
  const onTickKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? total - 1 : null;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    const next = e.currentTarget.parentElement?.children[Math.max(0, Math.min(total - 1, to))];
    if (next instanceof HTMLElement) next.focus();
  };
  const shown = peek ? items[peek.at] : undefined;

  return (
    <nav ref={nav} className="prompt-rail no-autofocus" aria-label="Your messages">
      <div className="rail-ticks" onPointerLeave={() => setPeek(null)}>
        {items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            className="rail-tick"
            aria-label={tickLabel(item, total)}
            aria-current={i === marked ? "true" : undefined}
            aria-describedby={peek?.at === i ? cardId : undefined}
            tabIndex={i === marked ? 0 : -1}
            onClick={() => jump(i)}
            onPointerEnter={(e) => show(i, e.currentTarget)}
            onFocus={(e) => show(i, e.currentTarget)}
            onBlur={() => setPeek(null)}
            onKeyDown={(e) => onTickKey(e, i)}
          />
        ))}
      </div>
      {peek && shown && (
        <div id={cardId} className="rail-card" role="tooltip" style={{ top: peek.top, transform: `translateY(-${peek.slide}%)` }}>
          <strong className="rail-card-words">{shown.label}</strong>
          {shown.reply && <span className="rail-card-reply">{shown.reply}</span>}
          <span className="rail-card-place">{railPlace(shown.n, total)}</span>
        </div>
      )}
    </nav>
  );
}

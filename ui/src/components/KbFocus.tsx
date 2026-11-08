/**
 * The keyboard ring's page half (FR-023): reads each zone's list off the
 * page (`[data-kb]` under the zone's roots, in document order), moves the
 * ring, peeks and goes in, and keeps the place while the list changes under
 * it. The model is pure in kbfocus.ts; items spread `useKb` (kbring.ts).
 * App.tsx's key handler calls `kbMove`, `kbPeek`, `kbEnter` and `kbCopy`
 * (the copy keys, FR-025, their model in kbcopy.ts) through the shortcut
 * table and mounts `KbWatch`.
 */
import { useEffect } from "react";
import type { PrWatch } from "../../../src/core/types";
import type { InboxItem } from "../inbox";
import { copyOf, copyableOfOrigin, copyableOfRepo, copyableOfRun, type Copyable } from "../kbcopy";
import { KB_ZONES, homeZone, keepKb, parseKb, ringOf, stepKb, triggerOf, uniqueKeys, type KbTarget, type KbZone } from "../kbfocus";
import { backendOf, qual } from "../registry";
import { say } from "../said";
import { copyText } from "../share";
import type { CopyKey } from "../shortcuts";
import { activeFlowFor, flowFor, idLabel, inboxItems, landingAll, prsAll, runFor, useStore, type CanopyState } from "../store";
import { OVER_PAGE } from "../surface";
import { showInboxSheet } from "./Inbox";

const ZONES = Object.keys(KB_ZONES) as KbZone[];

/** each zone's place, so a zone left for another keeps where it was */
const places = new Map<KbZone, string>();
/** each zone's list as it was while its place was in it, for a place that
 *  then leaves it */
const lists = new Map<KbZone, string[]>();
/** the zone the last pointer press landed in, or the one `w` named */
let zone: KbZone | null = null;
/** the zone the ring shows in */
let ringZone: KbZone | null = null;

/** `w` opens "waiting on you": j and k walk the dock's rows next. */
export const kbZone = (z: KbZone): void => {
  zone = z;
};

function zoneAt(el: Element): KbZone | null {
  return ZONES.find((z) => el.closest(KB_ZONES[z])) ?? null;
}

/** the items a zone lists now, each key once in the page's order; null
 *  while none of its roots is on the page */
function itemsIn(z: KbZone): HTMLElement[] | null {
  const roots = [...document.querySelectorAll(KB_ZONES[z])];
  if (roots.length === 0) return null;
  return roots.flatMap((r) => [...r.querySelectorAll<HTMLElement>("[data-kb]")]);
}

function keysIn(z: KbZone): string[] | null {
  const items = itemsIn(z);
  return items && uniqueKeys(items.map((el) => el.dataset["kb"] ?? "").filter(Boolean));
}

/** the elements carrying `key` in the zone: a repo's card and its tree row */
const elsOf = (z: KbZone, key: string): HTMLElement[] => (itemsIn(z) ?? []).filter((el) => el.dataset["kb"] === key);

/** the ringed key while its item is on the page, so a press on another
 *  view never acts on what that view does not show */
function shown(s: CanopyState): string | null {
  const key = s.kbFocus;
  return s.kbRing && key && ringZone && elsOf(ringZone, key).length > 0 ? key : null;
}

/** Shows the ring on `key` in `z` and remembers it as that zone's place. */
function ring(z: KbZone, key: string, keys: string[]): void {
  places.set(z, key);
  lists.set(z, keys);
  ringZone = z;
  useStore.getState().setKbFocus(key, true);
}

/** Answers a press that has nothing to open: the ring blinks once. */
function blink(key: string): void {
  if (!ringZone) return;
  for (const el of elsOf(ringZone, key)) {
    el.removeAttribute("data-kb-blink");
    // read layout, so the animation starts again on a second press
    void el.offsetWidth;
    el.setAttribute("data-kb-blink", "");
    setTimeout(() => el.removeAttribute("data-kb-blink"), 500);
  }
}

/**
 * Puts the ring on `key` in `z` and scrolls it into view: a link from one
 * view to a row of another, called once that view is on the page (after
 * the view switch has rendered, so `KbWatch`'s hide on the switch has
 * run). False when the zone or the row is not there.
 */
export function kbRingTo(z: KbZone, key: string): boolean {
  const keys = keysIn(z);
  if (!keys?.includes(key)) return false;
  zone = z;
  ring(z, key, keys);
  for (const el of elsOf(z, key)) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

/**
 * j, k and the arrows: the ring `delta` items on in the zone pressed in
 * last, else the view's own. A press on an item (a card reached with Tab
 * or clicked) starts from that item. The move takes DOM focus off what held
 * it, so the next Enter or Space is the ring's. False when there is
 * nothing to walk.
 */
export function kbMove(delta: number, view: string, target: Element | null): boolean {
  const here = target ? zoneAt(target) : null;
  const on = target?.closest<HTMLElement>("[data-kb]")?.dataset["kb"];
  if (here) {
    zone = here;
    if (on) places.set(here, on);
  }
  let z = zone;
  let keys = z ? keysIn(z) : null;
  if (!keys?.length) {
    z = homeZone(view);
    keys = z ? keysIn(z) : null;
  }
  if (!z || !keys?.length) return false;
  const next = stepKb(keys, places.get(z) ?? null, delta, lists.get(z));
  if (!next) return false;
  zone = z;
  ring(z, next, keys);
  const held = document.activeElement;
  if (held instanceof HTMLElement && held !== document.body) held.blur();
  for (const el of elsOf(z, next)) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

/** the run or workflow a card's chip shows, as the card does: a live
 *  workflow, else its run (or that run's best-of-N group), else its last
 *  workflow */
function cardPeek(s: CanopyState, repoId: string): (() => void) | null {
  const live = activeFlowFor(s, repoId);
  if (live) return () => s.showFlow(live.id);
  const run = runFor(s, repoId);
  if (run) {
    const group = landingAll(s).groups?.find((g) => g.id === (run.group ?? run.branch?.group));
    return group ? () => s.showGroup(group.id) : () => s.showRun(run.id);
  }
  const last = flowFor(s, repoId);
  return last ? () => s.showFlow(last.id) : null;
}

/** a trigger row's event, by the backend and id its key carries */
function eventOf(s: CanopyState, id: string) {
  const t = triggerOf(id);
  return t ? { backend: t.backend, event: s.triggers[t.backend]?.events.find((e) => e.id === t.eventId) } : null;
}

/** Unfolds an inbox row's form; `enter` puts the keyboard in it, in its
 *  first box, else on its first button, as a run sheet's focus lands. */
function unfold(key: string, enter: boolean): boolean {
  const row = ringZone ? elsOf(ringZone, key)[0] : undefined;
  const head = row?.querySelector<HTMLElement>(".inbox-head");
  if (!row || !head) return false;
  if (head.getAttribute("aria-expanded") !== "true") head.click();
  if (enter) {
    // a frame on, the row has drawn its form
    requestAnimationFrame(() => {
      const box = row.querySelector<HTMLElement>(".inbox-body :is(textarea, input:not([type]), input[type=text])");
      (box ?? row.querySelector<HTMLElement>(".inbox-body :is(button:not([disabled]), a[href], input, select)"))?.focus();
    });
  }
  return true;
}

/** Space: the ringed item's run in its sheet over the list (Escape closes
 *  it, and the ring stays). In select mode a card is picked instead. True
 *  when the press was the ring's. */
export function kbPeek(): boolean {
  const s = useStore.getState();
  const t = ringOf(s);
  const key = shown(s);
  if (!t || !key) return false;
  switch (t.kind) {
    case "repo": {
      if (s.selecting) {
        s.toggleSelected(t.id);
        return true;
      }
      const open = cardPeek(s, t.id);
      if (open) open();
      else blink(key);
      return true;
    }
    case "trigger": {
      const runId = eventOf(s, t.id)?.event?.runId;
      if (runId) s.showRun(runId);
      else blink(key);
      return true;
    }
    case "inbox": {
      const item = inboxItems(s).find((i) => i.key === t.id);
      if (!item) return false;
      // an agent's ask has no sheet: its row unfolds instead
      if (!showInboxSheet(item) && !unfold(key, false)) blink(key);
      return true;
    }
  }
}

/** Enter: go in. A card opens its repo as a click does (picked instead in
 *  select mode), a trigger row takes the git view to its repo's panel
 *  (`showRepo`, App's), an inbox row unfolds its form with the keyboard in
 *  it. */
export function kbEnter(showRepo: (id: string) => void): boolean {
  const s = useStore.getState();
  const t = ringOf(s);
  const key = shown(s);
  if (!t || !key) return false;
  switch (t.kind) {
    case "repo":
      if (s.selecting) s.toggleSelected(t.id);
      else s.openRepo(t.id);
      return true;
    case "trigger": {
      const found = eventOf(s, t.id);
      const e = found?.event;
      const b = found?.backend ?? "";
      const repo = e && s.repos.find((r) => r.id === e.repoId || r.id === qual(b, e.repoId) || (backendOf(r.id) === b && r.path === e.repoId));
      if (repo) showRepo(repo.id);
      else blink(key);
      return true;
    }
    case "inbox":
      if (!unfold(key, true)) blink(key);
      return true;
  }
}

/** the branch a repo's checkout is on, for a run that worked in it */
const checkoutOf = (s: CanopyState, repoId: string): string | null => s.repos.find((r) => r.id === repoId)?.status?.branch ?? null;

/** a trigger's event, by its id alone, on whichever backend has it */
function eventById(s: CanopyState, id: string) {
  for (const [backend, info] of Object.entries(s.triggers)) {
    const event = info?.events.find((x) => x.id === id);
    if (event) return { backend, event };
  }
  return undefined;
}

/** What a trigger's event has to copy: through its latest run, else
 *  through its branch id. The event holds the run's id as its backend
 *  minted it, so it is qualified before the store is asked. */
function eventCopyable(s: CanopyState, backend: string, e: { runId?: string; branch?: string }, prs: readonly PrWatch[]): Copyable {
  const runId = e.runId ? qual(backend, e.runId) : null;
  const run = runId ? s.runs[runId] : undefined;
  if (run) return copyableOfRun(run, prs, checkoutOf(s, run.repoId));
  if (e.branch) return copyableOfOrigin(e.branch, prs, landingAll(s).entries, Object.values(s.runs));
  return { branch: null, pr: null, run: runId };
}

/** What an inbox row has to copy: a run's through the run, a PR's or a
 *  sent-back branch's through its branch id, a workflow's through its
 *  branch (else its checkout and its latest step), a trigger's as a
 *  trigger row's; any other row (an ask, a sprout, the sweep, a group)
 *  through its repo's card, when it has one. */
function inboxCopyable(s: CanopyState, item: InboxItem, prs: readonly PrWatch[]): Copyable | null {
  const origin = (id: string) => copyableOfOrigin(id, prs, landingAll(s).entries, Object.values(s.runs));
  switch (item.source) {
    case "run": {
      const run = s.runs[item.id];
      return run ? copyableOfRun(run, prs, checkoutOf(s, run.repoId)) : null;
    }
    case "pr":
    case "landing":
      return origin(item.id);
    case "flow": {
      const f = s.flows[item.id];
      if (!f) return null;
      if (f.branch) return origin(f.branch.origin);
      const last = [...f.steps].reverse().find((st) => st.runId)?.runId ?? null;
      return { branch: checkoutOf(s, f.repoId), pr: null, run: last };
    }
    case "trigger": {
      const found = eventById(s, item.id);
      return found ? eventCopyable(s, found.backend, found.event, prs) : null;
    }
    default: {
      const repo = item.repoId ? s.repos.find((r) => r.id === item.repoId) : undefined;
      return repo ? copyableOfRepo(repo, runFor(s, repo.id), prs) : null;
    }
  }
}

/** What the ringed item has to copy. */
function ringCopyable(s: CanopyState, t: KbTarget, prs: readonly PrWatch[]): Copyable | null {
  switch (t.kind) {
    case "repo": {
      const repo = s.repos.find((r) => r.id === t.id);
      return repo ? copyableOfRepo(repo, runFor(s, t.id), prs) : null;
    }
    case "trigger": {
      const found = eventOf(s, t.id);
      return found?.event ? eventCopyable(s, found.backend, found.event, prs) : null;
    }
    case "inbox": {
      const item = inboxItems(s).find((i) => i.key === t.id);
      return item ? inboxCopyable(s, item, prs) : null;
    }
  }
}

/** What the copy keys read, in order: the run sheet's run, else the ringed
 *  card or row while nothing else is up, else the run a window of one run
 *  shows (`solo`, App's `route.run`). `key` is the ringed item's, for a
 *  blink; `from` names it for the quiet line. */
function copySource(s: CanopyState, solo: string | null): { parts: Copyable; from: string; key: string | null } | null {
  const prs = prsAll(s);
  const sheet = s.sheet;
  if (sheet?.kind === "run") {
    const run = s.runs[sheet.runId];
    return run ? { parts: copyableOfRun(run, prs, checkoutOf(s, run.repoId)), from: "the run", key: null } : null;
  }
  if (sheet) return null;
  const t = ringOf(s);
  const key = shown(s);
  if (t && key) {
    const parts = ringCopyable(s, t, prs);
    return parts ? { parts, from: t.kind === "repo" ? "the card" : "the row", key } : null;
  }
  const run = solo ? s.runs[solo] : undefined;
  return run ? { parts: copyableOfRun(run, prs, checkoutOf(s, run.repoId)), from: "the run", key: null } : null;
}

/**
 * y then b, p or r (FR-025): copies the branch, the PR's link or the run's
 * id of the run sheet's run, else of the ringed card or row, and says so in
 * the page's quiet line (said.ts). An item with none of that part is said
 * the same way, and the ring blinks as on Space with nothing to open; a
 * clipboard the browser refused is said in rust. The run id copied is the
 * one its backend knows, the line naming the backend when it is not home.
 */
export function kbCopy(key: CopyKey, solo: string | null = null): void {
  const s = useStore.getState();
  const found = copySource(s, solo);
  if (!found) {
    say(`nothing to copy from: ring a card or a row, or open a run`);
    return;
  }
  const { name, text } = copyOf(found.parts, key);
  if (text === null) {
    if (found.key) blink(found.key);
    say(`${found.from} has no ${name}`);
    return;
  }
  copyPart(key, text);
}

/** Copies one part an item has, and says so as y does: a run's id as its
 *  backend knows it, the backend named when it is not home. */
export function copyPart(key: CopyKey, text: string): void {
  const { name } = copyOf({ branch: text, pr: text, run: text }, key);
  const { plain, backend } = key === "r" ? idLabel(text) : { plain: text, backend: null };
  copyText(plain, { from: name }).then(
    () => say(`copied ${name}: ${plain}${backend ? ` on ${backend}` : ""}`),
    (e: unknown) => say(`could not copy: ${e instanceof Error ? e.message : String(e)}`, true),
  );
}

/** What an item with a ring key (`repo:…`, `trigger:…`, `inbox:…`) has
 *  for the copy keys, ringed or not: a right-click's copy rows (FR-056). */
export function copyableOfKey(key: string): Copyable | null {
  const t = parseKb(key);
  if (!t) return null;
  const s = useStore.getState();
  return ringCopyable(s, t, prsAll(s));
}

/** A trigger row's event by its ring id, with its backend. */
export function triggerEventOf(id: string) {
  return eventOf(useStore.getState(), id);
}

/** Hides the ring and keeps the place, for Escape with nothing else to close. */
export function kbHide(): boolean {
  const s = useStore.getState();
  if (!s.kbRing) return false;
  s.setKbFocus(s.kbFocus, false);
  return true;
}

/**
 * Keeps the place while the page changes. A pointer press hides the ring,
 * and on an item it moves that zone's place there quietly; a press in a
 * sheet, a menu or on a sheet's backdrop leaves the ring alone. After any
 * store change (an SSE update, a filter, a fold), once the page has drawn
 * it, a ringed item that left its list hands the ring to the item that took
 * its place, and with none left the ring hides. A change of view hides it.
 */
export function KbWatch({ view }: { view: string }) {
  // another view shows none of this one's items: the ring hides, its place kept
  useEffect(() => {
    kbHide();
  }, [view]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element) || t.closest(`${OVER_PAGE}, .sheet-back`)) return;
      const z = zoneAt(t);
      if (z) zone = z;
      const key = t.closest<HTMLElement>("[data-kb]")?.dataset["kb"];
      const s = useStore.getState();
      if (z && key) {
        places.set(z, key);
        lists.set(z, keysIn(z) ?? []);
        s.setKbFocus(key, false);
      } else if (s.kbRing) s.setKbFocus(s.kbFocus, false);
    };
    let frame = 0;
    const check = () => {
      frame = 0;
      const s = useStore.getState();
      const z = ringZone;
      if (!s.kbRing || !s.kbFocus || !z) return;
      const keys = keysIn(z);
      // the zone is off the page (another view): its place waits for it
      if (keys === null) return;
      const kept = keepKb(keys, s.kbFocus, lists.get(z) ?? []);
      if (kept === s.kbFocus) lists.set(z, keys);
      else if (kept) ring(z, kept, keys);
      else s.setKbFocus(s.kbFocus, false);
    };
    window.addEventListener("pointerdown", down, true);
    const unsubscribe = useStore.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(check);
    });
    return () => {
      window.removeEventListener("pointerdown", down, true);
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}

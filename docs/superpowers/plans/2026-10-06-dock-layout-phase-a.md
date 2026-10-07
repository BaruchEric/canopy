# The movable dock, phase A: reorder, carousel, full screen, pop out and back. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dock panels can be:
- dragged into a new order, or moved by keyboard;
- laid out as a full-width carousel that pans by drag, wheel and shift+wheel and snaps panel to panel;
- taken truly full screen;
- popped out to their own window and brought back to the same slot.

No panel's shell or preview reloads along the way.

**Architecture:**
- Pure helpers live in `ui/src/dock.ts`, `ui/src/carousel.ts`, `ui/src/fullscreen.ts` and `ui/src/panes.ts`, each tested with `bun test`.
- `Dock` renders panels in a stable DOM order, sorted by id, and places them with CSS `order` from `panels`. A reorder is then a style change, never a DOM move.
- The carousel is a setting that collapses the cards column and lifts `dockRoom`'s cap.
- Full screen is the existing `surface-full` mode plus `requestFullscreen` on the document element.
- Pop out and back is a `BroadcastChannel` between the main window and the solo window.

**Tech stack:** React 19 + zustand, plain CSS in `ui/src/styles.css`, native HTML5 drag and drop, the Fullscreen API, `BroadcastChannel`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-kilo-borrowings-design.md`, section "The movable dock", the first rule and phase A.

## Global constraints

- **A panel is never reparented or moved in the DOM.** Moving a `RepoPanel` element reloads its preview iframe. Panels render as keyed children of `.dock` sorted by id, each `Resizer` directly before its panel. Placement is CSS `order` only.
- TypeScript `"strict": true`. No `any`, no `as` casts on untrusted data (a `BroadcastChannel` message is untrusted), no non-null `!`.
- `ui/src/*` stays browser-safe.
- Gates: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`.
- No drag-and-drop, split-pane or gesture library. No CSS framework.
- Motion only under `@media (prefers-reduced-motion: no-preference)`. No transform animation on an element with `position: fixed` descendants past its entrance. No CSS `zoom` on an ancestor of an xterm.
- Wheel events over a panel's own scrollable content are never turned into panning.
- Below `PHONE` (760px): no drag, no carousel. The phone dock is unchanged.
- Every UI task ends with a real browser check: a scratch canopy server (memory note "Scratch canopy server for UI checks") driven with playwright-cli, including a window resize. `bun test` alone does not verify UI work, because the repo has no DOM test library.
- Commit per task, never amend, no backticks in commit messages. Unslop for comments and copy.

## Review focus

1. **A reorder with a live preview and a running shell.** The iframe must not reload: its `src` load count stays 1. The terminal keeps its scrollback. Tasks 2 and 6.
2. **Shift+wheel and trackpad sideways swipes over a terminal or a diff.** A diff that scrolls sideways itself keeps shift+wheel. Over a terminal, a plain wheel scrolls the terminal and shift+wheel pans the row, since the terminal does not scroll sideways. Task 3.
3. **A solo window that is not a pop-out.** "open in a new tab", shift-click on a card and a typed URL all open `soloUrl` without `popped=1`, and must never take the panel out of the dock. Only a window opened by "pop out" claims its panel. Task 5.
4. **A pop-out that reloads, crashes or is closed from the OS.** A reload must not bounce the panel back into the dock for good. A window killed without `pagehide` is found by the `who` ping on the next main-window load, and its panel returns. Task 5.
5. **Two main windows open at once.** Both get `return` and `hello`. Each applies it to its own `panels`, so both stay consistent. A dockless window ignores the channel's layout messages. Task 5.
6. **Full screen refused or unsupported.** `requestFullscreen` rejects without a user gesture, and does not exist on iOS Safari. The panel still fills the window and the entry says "fill the window". Leaving full screen with Esc also leaves `surface-full`. Task 4.

---

## File structure

| File | What changes |
|---|---|
| `ui/src/dock.ts`, `ui/src/dock.test.ts` | `movePanel`, `dropIndex`, `stableOrder` |
| `ui/src/store.ts` | `movePanel` action; `popped` in `Layout`, `popOut`, `returnPanel`, `claimPanel`; the dockless patch strips `popped` |
| `ui/src/components/Dock.tsx:1682-1745` | stable DOM order, CSS order, the carousel class and pan handlers, the drag source and target on tabs and heads, the gear entries |
| `ui/src/carousel.ts`, `ui/src/carousel.test.ts` | `wheelPan`, `snapTo`, `PAN_SLOP` |
| `ui/src/fullscreen.ts`, `ui/src/fullscreen.test.ts` | `fullWord`, `enterFull`, `leaveFull`, `useFullscreenExit` |
| `ui/src/panes.ts`, `ui/src/panes.test.ts` | `PaneMsg`, `parsePaneMsg`, `restorePanel`, `PANES_CHANNEL`, `unclaimed` |
| `ui/src/components/Solo.tsx` | joins the channel only when its URL says `popped=1`, the "back to the dock" button |
| `ui/src/routes.ts`, `ui/src/routes.test.ts` | `soloUrl(id, { popped })` adds `popped=1`; `parseRoute` reads it as `popped: boolean` |
| `ui/src/App.tsx` | the main window's channel listener, `.body.carousel` |
| `ui/src/settings.ts` | `dockCarousel: boolean`, slotted per screen |
| `ui/src/styles.css` | `.dock` order rules, `.body.carousel`, snap, `.drop-before`/`.drop-after`, `.panel.popped-slot` |
| `docs/architecture.md` | "Layout and motion", "ui/" |

---

## Task 1: the reorder arithmetic

**Files:**
- Modify: `ui/src/dock.ts`
- Test: `ui/src/dock.test.ts`

**Interfaces:**
- Produces:
  - `movePanel(panels: readonly string[], id: string, to: number): string[]`. It clamps `to` and returns a copy that is unchanged when `id` is absent.
  - `dropIndex(panels: readonly string[], dragged: string, over: string, after: boolean): number`. This is the `to` for `movePanel` when `dragged` is dropped before or after `over`.
  - `stableOrder(panels: readonly string[]): string[]`. This is the DOM order, sorted by id.

- [x] **Step 1: Write the failing tests**, appended to `dock.test.ts`:

```ts
import { dropIndex, movePanel, stableOrder } from "./dock";

describe("moving panels", () => {
  test("moves to an index, clamped, without touching the input", () => {
    const p = ["a", "b", "c", "d"];
    expect(movePanel(p, "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(movePanel(p, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(movePanel(p, "b", 99)).toEqual(["a", "c", "d", "b"]);
    expect(movePanel(p, "b", -5)).toEqual(["b", "a", "c", "d"]);
    expect(movePanel(p, "zzz", 1)).toEqual(p);
    expect(p).toEqual(["a", "b", "c", "d"]);
  });
  test("a drop before or after a panel lands next to it, either direction", () => {
    const p = ["a", "b", "c", "d"];
    expect(movePanel(p, "a", dropIndex(p, "a", "c", false))).toEqual(["b", "a", "c", "d"]);
    expect(movePanel(p, "a", dropIndex(p, "a", "c", true))).toEqual(["b", "c", "a", "d"]);
    expect(movePanel(p, "d", dropIndex(p, "d", "b", false))).toEqual(["a", "d", "b", "c"]);
    expect(movePanel(p, "d", dropIndex(p, "d", "b", true))).toEqual(["a", "b", "d", "c"]);
    expect(movePanel(p, "b", dropIndex(p, "b", "b", true))).toEqual(p);
  });
  test("the DOM order is the ids sorted, whatever the visual order", () => {
    expect(stableOrder(["c", "a", "b"])).toEqual(["a", "b", "c"]);
  });
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/dock.test.ts`
Expected: FAIL, the exports are missing.

- [x] **Step 3: Implement** in `ui/src/dock.ts`:

```ts
/** `panels` with `id` moved to index `to` (clamped). An id that is not
 *  open leaves the list as it was. */
export function movePanel(panels: readonly string[], id: string, to: number): string[] {
  const from = panels.indexOf(id);
  if (from === -1) return [...panels];
  const rest = panels.filter((p) => p !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** The index `movePanel` takes to drop `dragged` just before (or after)
 *  `over`: counted in the list without `dragged`, where it is inserted. */
export function dropIndex(panels: readonly string[], dragged: string, over: string, after: boolean): number {
  const rest = panels.filter((p) => p !== dragged);
  const i = rest.indexOf(over);
  if (i === -1) return panels.indexOf(dragged);
  return after ? i + 1 : i;
}

/** The order panels are rendered in the DOM: by id, so a reorder (a
 *  change of CSS order) never moves an element, which would reload a
 *  preview's iframe. */
export const stableOrder = (panels: readonly string[]): string[] => [...panels].sort();
```

- [x] **Step 4: Run the tests and watch them pass**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/dock.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add ui/src/dock.ts ui/src/dock.test.ts
git commit -m "feat(dock): the arithmetic for moving a panel"
```

---

## Task 2: drag to reorder, keyboard moves, a stable DOM

**Files:**
- Modify: `ui/src/store.ts` (`movePanel` action beside `closePanel` at :1913)
- Modify: `ui/src/components/Dock.tsx` (`Dock` :1682, `DockTabs` :1581, the panel head at :1186 and :1393, the gear at :1020-1030)
- Modify: `ui/src/styles.css` (dock section, :2270-2330)
- Test: `ui/src/store.test.ts`

**Interfaces:**
- Consumes: `movePanel`, `dropIndex`, `stableOrder` (Task 1).
- Produces: store action `movePanel(id: string, to: number): void`, and the drag data type `"application/x-canopy-panel"`.

- [x] **Step 1: Write the failing store test**, in `store.test.ts`, the way its other dock tests set state:

```ts
test("movePanel reorders the open panels and keeps the active one", () => {
  useStore.setState({ panels: ["a", "b", "c"], activePanel: "b" });
  useStore.getState().movePanel("c", 0);
  expect(useStore.getState().panels).toEqual(["c", "a", "b"]);
  expect(useStore.getState().activePanel).toBe("b");
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/store.test.ts`
Expected: FAIL, `movePanel` is not a function.

- [x] **Step 3: Implement**

`store.ts`:
- Declare `movePanel: (id: string, to: number) => void;` beside `closePanel`.
- Implement it as `movePanel: (id, to) => set((s) => ({ panels: movePanel(s.panels, id, to) })),`. Import the helper as `movePanel as moveIn` to avoid the name clash.
- `panels` is already persisted through `layoutOf`, so the order survives a reload.

`Dock.tsx` `Dock`:
- Render `stableOrder(panels)` instead of `panels`.
- Give each panel `style={{ order: 2 * panels.indexOf(id) + 1 }}`, and its `Resizer` `style={{ order: 2 * panels.indexOf(id) }}`. `Resizer` needs a `style` prop passed to its element; add it if it has none. The resizer stays the panel's previous DOM sibling, so `target={(h) => h.nextElementSibling}` still finds it.
- `RepoPanel` takes `order?: number` and sets `style.order` on `.panel`, next to the existing `--panel-w`.
- In tabbed mode, order does not matter, because every panel shares one grid cell. Only `DockTabs` must follow `panels`, which it already maps.

`DockTabs` and the panel head (both `<header className="panel-head">` sites) become drag sources and targets:

```tsx
const PANEL_DRAG = "application/x-canopy-panel";

function dragProps(id: string, panels: readonly string[], move: (id: string, to: number) => void, horizontal = true) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(PANEL_DRAG, id);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(PANEL_DRAG)) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      const after = horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
      e.currentTarget.dataset.drop = after ? "after" : "before";
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      delete e.currentTarget.dataset.drop;
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      const dragged = e.dataTransfer.getData(PANEL_DRAG);
      const after = e.currentTarget.dataset.drop === "after";
      delete e.currentTarget.dataset.drop;
      if (!dragged || dragged === id) return;
      e.preventDefault();
      move(dragged, dropIndex(panels, dragged, id, after));
    },
  };
}
```

- On the panel head, only the head's own background starts a drag. Buttons and inputs inside it keep `draggable={false}`. The dragstart handler returns early when `e.target` is not the header itself or its title span, which keeps text selection and button clicks working.
- Phones: pass no drag props when `useMedia(PHONE)` is true.
- Keyboard: on a dock tab and on the panel head, Alt+Shift+ArrowLeft/Right calls `movePanel(id, panels.indexOf(id) ∓ 1)` and keeps focus on the moved element. The panel gear's layout entries gain:

```ts
        { type: "item", label: "move left", run: () => movePanel(repo.id, panels.indexOf(repo.id) - 1), disabled: panels.indexOf(repo.id) <= 0 },
        { type: "item", label: "move right", run: () => movePanel(repo.id, panels.indexOf(repo.id) + 1), disabled: panels.indexOf(repo.id) >= panels.length - 1 },
```

If `GearEntry` has no `disabled` field, leave the entry out at the ends instead.

`styles.css`, in the dock section:

```css
.dock-tab[data-drop="before"], .panel-head[data-drop="before"] { box-shadow: inset 2px 0 0 var(--sky); }
.dock-tab[data-drop="after"], .panel-head[data-drop="after"] { box-shadow: inset -2px 0 0 var(--sky); }
.panel-head[draggable="true"] { cursor: grab; }
.panel-head[draggable="true"]:active { cursor: grabbing; }
```

- [x] **Step 4: Gates, then the browser check**

Run: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

Then, on a scratch server with three repos:
1. Open three panels. Open the preview section in the middle one, pointed at a page that counts its loads (any static page; `performance.getEntriesByType("navigation")` inside the iframe tells a reload). Start a shell in the last one and print 50 lines.
2. Drag the last panel's head before the first.
3. Check that the order changed, that the iframe's navigation entry is the same one (no reload), and that the shell still has its 50 lines.
4. Do the same with Alt+Shift+ArrowLeft on the focused head, and with "move right" in the gear.
5. Switch the gear to "panels as tabs", drag a tab, and check that the tab order follows.
6. Resize to 390px and check that heads are not draggable.

- [x] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(dock): drag panels and tabs into a new order without reloading them"
```

---

## Task 3: the carousel

**Files:**
- Create: `ui/src/carousel.ts`, `ui/src/carousel.test.ts`
- Modify: `ui/src/settings.ts` (`dockCarousel`, in `SCREEN_SETTINGS`)
- Modify: `ui/src/App.tsx:281-333` (`.body` class)
- Modify: `ui/src/components/Dock.tsx` (`dockRoom`, `Dock`, the gear)
- Modify: `ui/src/styles.css`

**Interfaces:**
- Produces:
  - `wheelPan(e: { deltaX: number; deltaY: number; shiftKey: boolean }, over: "head" | "content", contentScrollsX: boolean): number`. It returns px to add to `scrollLeft`, or 0 to leave the event alone.
  - `snapTo(lefts: readonly number[], scrollLeft: number, dir: 1 | -1): number`. It returns the next panel's left edge in `dir`.
  - `PAN_SLOP = 6`.
  - The setting `dockCarousel: boolean`, default `false`.

- [x] **Step 1: Write the failing tests**, `ui/src/carousel.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { snapTo, wheelPan } from "./carousel";

describe("carousel wheel", () => {
  test("over a head, a vertical wheel pans sideways", () => {
    expect(wheelPan({ deltaX: 0, deltaY: 40, shiftKey: false }, "head", false)).toBe(40);
  });
  test("over content, a plain wheel is the content's", () => {
    expect(wheelPan({ deltaX: 0, deltaY: 40, shiftKey: false }, "content", false)).toBe(0);
  });
  test("shift+wheel pans unless the content scrolls sideways itself", () => {
    expect(wheelPan({ deltaX: 0, deltaY: 40, shiftKey: true }, "content", false)).toBe(40);
    expect(wheelPan({ deltaX: 0, deltaY: 40, shiftKey: true }, "content", true)).toBe(0);
  });
  test("a sideways trackpad swipe is left to the browser everywhere", () => {
    expect(wheelPan({ deltaX: 30, deltaY: 2, shiftKey: false }, "head", false)).toBe(0);
  });
});

describe("carousel snap", () => {
  const lefts = [0, 446, 1052, 1498];
  test("next and previous panel edges", () => {
    expect(snapTo(lefts, 0, 1)).toBe(446);
    expect(snapTo(lefts, 500, 1)).toBe(1052);
    expect(snapTo(lefts, 500, -1)).toBe(446);
    expect(snapTo(lefts, 446, -1)).toBe(0);
  });
  test("stops at the ends", () => {
    expect(snapTo(lefts, 1498, 1)).toBe(1498);
    expect(snapTo(lefts, 0, -1)).toBe(0);
  });
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/carousel.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

`ui/src/carousel.ts`:

```ts
/** The carousel's pointer arithmetic: when a wheel pans the row, and where
 *  a keyboard jump lands. Pure, so the rules that keep a terminal's or a
 *  diff's own scrolling theirs are tested. */

/** a press that moves less than this is a click, not a pan */
export const PAN_SLOP = 6;

/** px to pan the row by for a wheel event, or 0 to leave it alone. A
 *  sideways swipe is the browser's already; over a head a vertical wheel
 *  pans; over content only shift+wheel does, and not where the content
 *  itself scrolls sideways (a wide diff). */
export function wheelPan(
  e: { deltaX: number; deltaY: number; shiftKey: boolean },
  over: "head" | "content",
  contentScrollsX: boolean,
): number {
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return 0;
  if (over === "head") return e.deltaY;
  if (e.shiftKey && !contentScrollsX) return e.deltaY;
  return 0;
}

/** the left edge of the next panel past `scrollLeft` in `dir`, or the
 *  last edge when there is none */
export function snapTo(lefts: readonly number[], scrollLeft: number, dir: 1 | -1): number {
  const edge = 2; // px: a row resting on an edge counts as on it
  if (dir === 1) return lefts.find((l) => l > scrollLeft + edge) ?? lefts.at(-1) ?? 0;
  return [...lefts].reverse().find((l) => l < scrollLeft - edge) ?? lefts[0] ?? 0;
}
```

`settings.ts`:
- Add `dockCarousel: boolean` to `Settings`, defaulting to `false`.
- Add it to `SCREEN_SETTINGS`, so an ultrawide can keep it on and a laptop off.
- Load it in the normalizer with the file's existing boolean pattern (`typeof saved.x === "boolean" ? ... : default`).

`App.tsx`: `.body` gains the class `carousel` when `settings.dockCarousel && panels.length > 0 && !phone`.

`styles.css`:

```css
/* the carousel: the dock takes the cards' room and scrolls sideways,
   one panel's edge at a time */
.body.carousel { grid-template-columns: var(--sidebar-w) 6px 0 minmax(0, 1fr); }
.body.carousel.no-side { grid-template-columns: 0 minmax(0, 1fr); }
.body.carousel > .repo-grid { display: none; }
.body.carousel > .dock { max-width: none; scroll-snap-type: x proximity; overscroll-behavior-x: contain; }
.body.carousel > .dock > .panel { scroll-snap-align: start; }
.dock.panning, .dock.panning * { cursor: grabbing; user-select: none; }
```

Check the real class of the cards grid element (`RepoGrid`'s root) and the real column template at `styles.css:478` before writing these. Mirror the `.no-side` variant.

`Dock.tsx`:
- `dockRoom` returns `window.innerWidth - 6` when the dock's parent has the `carousel` class. A panel may then be as wide as the window.
- `Dock` attaches to `.dock`, when the carousel is on and not on a phone:
  - **`onWheel`.** Work out `over` from `e.target.closest(".panel-head, .dock-tabs") ? "head" : "content"`. Set `contentScrollsX` by walking up from `e.target` to `.dock` and asking whether any element has `scrollWidth > clientWidth` with `overflow-x` of `auto` or `scroll` in `getComputedStyle`. Call `const dx = wheelPan(...)`. When `dx` is nonzero, `dock.scrollLeft += dx` and `e.preventDefault()`. React's `onWheel` is passive, so attach this one with `addEventListener("wheel", h, { passive: false })` in a `useEffect` with cleanup.
  - **Pan by drag.** Listen to `pointerdown` on `.panel-head` background and on the dock's own gutter (`e.target === dock`). Record the start x and `scrollLeft`. Past `PAN_SLOP`, call `setPointerCapture`, add `.panning` and set `scrollLeft = start - (x - x0)`. On release, remove the class. A press under the slop is left as a click. A head with drag props from Task 2 keeps HTML5 drag for reorder, so pan only from `.dock` gutters and from the dock tabs strip's empty space. **Reorder wins on heads.** Write this choice into the code comment.
  - **Keys.** Ctrl+Alt+ArrowLeft/Right anywhere in the document while the carousel is on calls `dock.scrollTo({ left: snapTo(lefts, dock.scrollLeft, dir), behavior: reduced ? "auto" : "smooth" })`. `lefts` is each `.panel`'s `offsetLeft - dock.offsetLeft`, read in visual order (sorted by `offsetLeft`, since the DOM order is by id).
- A toggle button at the dock's top-right (`className="mini dock-carousel"`, `aria-pressed`) and a gear entry "carousel" both flip `settings.dockCarousel`.

- [x] **Step 4: Gates, then the browser check**

Run: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

Then, at 1440px wide with four panels open:
1. Turn the carousel on. Check that the cards column is gone and that a panel can be dragged wider than half the window.
2. Wheel over a panel head and check that the row pans.
3. Wheel over the changes list and check that the list scrolls and the row does not.
4. Shift+wheel over a terminal and check that the row pans and the terminal does not scroll.
5. Shift+wheel over a wide diff with sideways overflow and check that the diff scrolls.
6. Press Ctrl+Alt+ArrowRight and check that the row snaps to the next panel's edge.
7. Resize to 390px and check that the carousel class is off and the phone dock is as before.
8. Resize back and check that the setting is still on.

- [x] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(dock): a carousel that pans by drag, wheel and keys"
```

---

## Task 4: full screen

**Files:**
- Create: `ui/src/fullscreen.ts`, `ui/src/fullscreen.test.ts`
- Modify: `ui/src/surface.ts` (`modeEntries` gains the full-screen entry) or the panel gear in `Dock.tsx:1020`
- Modify: `ui/src/components/Dock.tsx` (`RepoPanel`'s `placed` mode), `ui/src/components/Solo.tsx`

**Interfaces:**
- Produces:
  - `fullWord(supported: boolean): string`, which is "full screen" or "fill the window".
  - `enterFull(doc: Pick<Document, "documentElement" | "fullscreenEnabled">): Promise<boolean>`, which resolves true when the browser went full screen.
  - `leaveFull(doc)`.
  - `useFullscreenExit(on: boolean, onExit: () => void): void`.

- [x] **Step 1: Write the failing tests**, `ui/src/fullscreen.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { enterFull, fullWord } from "./fullscreen";

describe("full screen", () => {
  test("the word says what the browser can do", () => {
    expect(fullWord(true)).toBe("full screen");
    expect(fullWord(false)).toBe("fill the window");
  });
  test("an unsupported browser never calls requestFullscreen", async () => {
    let called = false;
    const doc = { fullscreenEnabled: false, documentElement: { requestFullscreen: async () => void (called = true) } };
    expect(await enterFull(doc as never)).toBe(false);
    expect(called).toBe(false);
  });
  test("a refused request resolves false instead of throwing", async () => {
    const doc = { fullscreenEnabled: true, documentElement: { requestFullscreen: () => Promise.reject(new Error("no gesture")) } };
    expect(await enterFull(doc as never)).toBe(false);
  });
});
```

`as never` is for a test double only. If lint refuses it, type the parameter as a minimal interface, `{ fullscreenEnabled: boolean; documentElement: { requestFullscreen(): Promise<void> } }`, and drop the cast.

- [x] **Step 2: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/fullscreen.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement** `ui/src/fullscreen.ts`:

```ts
/** True full screen for a panel: the browser's Fullscreen API on the whole
 *  document, with the panel's own `surface-full` mode doing the filling.
 *  Never on the panel element: gear menus and sheets are portals to body
 *  and would not show inside it. */
import { useEffect } from "react";

interface FsDoc {
  fullscreenEnabled: boolean;
  documentElement: { requestFullscreen(): Promise<void> };
}

export const fullWord = (supported: boolean): string => (supported ? "full screen" : "fill the window");

export async function enterFull(doc: FsDoc): Promise<boolean> {
  if (!doc.fullscreenEnabled) return false;
  try {
    await doc.documentElement.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

export function leaveFull(doc: { fullscreenElement: Element | null; exitFullscreen(): Promise<void> }): void {
  if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {});
}

/** While `on`, a browser exit from full screen (Esc, F11) calls `onExit`. */
export function useFullscreenExit(on: boolean, onExit: () => void): void {
  useEffect(() => {
    if (!on) return;
    const h = () => {
      if (!document.fullscreenElement) onExit();
    };
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, [on, onExit]);
}
```

In `RepoPanel`:
- Add local state `const [screen, setScreen] = useState(false)`.
- The gear entry `{ type: "item", label: fullWord(document.fullscreenEnabled), on: screen, run: ... }` does this on enter: `setMode("full"); setScreen(await enterFull(document));`. On leave: `leaveFull(document); setScreen(false); setMode("normal")`.
- `useFullscreenExit(screen, () => { setScreen(false); setMode("normal"); })`.
- The existing Escape handler (`useLeaveOnEscape`) stays. On a real full screen the browser takes the first Esc and `fullscreenchange` does the rest.
- `Solo.tsx` gets the same entry for the solo window's panel.
- `onExit` must be stable or listed honestly in the effect's dependencies. Wrap it in `useCallback` with `setMode` in its dependencies. Mind stale closures.

- [x] **Step 4: Gates, then the browser check**

Run: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

Then:
1. Choose "full screen" from a panel gear, through a real click, so the user gesture counts. Check that `document.fullscreenElement` is `<html>` and the panel has `surface-full`.
2. Open its gear and check that the menu shows.
3. Press Escape and check that the browser leaves full screen and the panel is back in the dock.
4. Try the same in a pop-out window.

Playwright's headless Chromium may refuse full screen. Run this check headed, or accept the "fill the window" fallback and check that path.

- [x] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(dock): a panel can go full screen and come back on Esc"
```

---

## Task 5: pop out and back

**Files:**
- Create: `ui/src/panes.ts`, `ui/src/panes.test.ts`
- Modify: `ui/src/store.ts` (`Layout.popped`, `layoutOf`, the dockless patch at :2854, `popOut`, `returnPanel`, `claimPanel`)
- Modify: `ui/src/App.tsx` (the main window's listener)
- Modify: `ui/src/components/Solo.tsx` (`hello`, `bye`, "back to the dock")
- Modify: `ui/src/components/Dock.tsx:1027-1028` (the gear's "open in a new window" becomes "pop out")

**Interfaces:**
- Produces:
  - `PANES_CHANNEL = "canopy:panes"`.
  - `type PaneMsg = { type: "hello"; id: string } | { type: "bye"; id: string } | { type: "return"; id: string } | { type: "who" }`.
  - `parsePaneMsg(v: unknown): PaneMsg | null`.
  - `restorePanel(panels: readonly string[], id: string, slot: number): string[]`.
  - `unclaimed(popped: Record<string, number>, claimed: ReadonlySet<string>): string[]`.
  - Store: `popped: Record<string, number>` in `Layout`, plus `popOut(id)`, `returnPanel(id)` and `claimPanel(id)`.

- [x] **Step 1: Write the failing tests.** In `ui/src/routes.test.ts`:

```ts
test("a popped solo window says so in its URL, and only then", () => {
  expect(parseRoute(new URL(soloUrl("a/b", { popped: true }), "http://x").search).popped).toBe(true);
  expect(parseRoute(new URL(soloUrl("a/b"), "http://x").search).popped).toBe(false);
});
```

Then `ui/src/panes.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parsePaneMsg, restorePanel, unclaimed } from "./panes";

describe("pane messages", () => {
  test("parses the four kinds and refuses anything else", () => {
    expect(parsePaneMsg({ type: "hello", id: "a" })).toEqual({ type: "hello", id: "a" });
    expect(parsePaneMsg({ type: "who" })).toEqual({ type: "who" });
    expect(parsePaneMsg({ type: "hello" })).toBeNull();
    expect(parsePaneMsg({ type: "hello", id: 3 })).toBeNull();
    expect(parsePaneMsg({ type: "nuke", id: "a" })).toBeNull();
    expect(parsePaneMsg("hello")).toBeNull();
    expect(parsePaneMsg(null)).toBeNull();
  });
});

describe("putting a panel back", () => {
  test("at its old slot, clamped, once", () => {
    expect(restorePanel(["a", "c"], "b", 1)).toEqual(["a", "b", "c"]);
    expect(restorePanel(["a"], "b", 9)).toEqual(["a", "b"]);
    expect(restorePanel(["a", "b"], "b", 0)).toEqual(["a", "b"]);
  });
  test("popped ids no window answered for", () => {
    expect(unclaimed({ a: 0, b: 2 }, new Set(["b"]))).toEqual(["a"]);
  });
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/panes.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement** `ui/src/panes.ts`:

```ts
/** Pop out and back: the main window and a panel's own window talk on one
 *  BroadcastChannel. A pop-out says hello when it shows a panel and bye
 *  when it goes; "return" asks the dock to take it back; "who" asks every
 *  pop-out to say hello again (a main window just loaded). Messages come
 *  from any same-origin page, so each one is checked. */

export const PANES_CHANNEL = "canopy:panes";
/** how long a loading main window waits for pop-outs to answer "who" */
export const WHO_WAIT_MS = 1500;

export type PaneMsg =
  | { type: "hello"; id: string }
  | { type: "bye"; id: string }
  | { type: "return"; id: string }
  | { type: "who" };

export function parsePaneMsg(v: unknown): PaneMsg | null {
  if (!v || typeof v !== "object") return null;
  const type = "type" in v ? v.type : undefined;
  if (type === "who") return { type };
  const id = "id" in v ? v.id : undefined;
  if (typeof id !== "string" || !id) return null;
  if (type === "hello" || type === "bye" || type === "return") return { type, id };
  return null;
}

export function restorePanel(panels: readonly string[], id: string, slot: number): string[] {
  if (panels.includes(id)) return [...panels];
  const at = Math.max(0, Math.min(panels.length, slot));
  return [...panels.slice(0, at), id, ...panels.slice(at)];
}

export const unclaimed = (popped: Record<string, number>, claimed: ReadonlySet<string>): string[] =>
  Object.keys(popped).filter((id) => !claimed.has(id));
```

`store.ts`:
- Add `popped: Record<string, number>` to `Layout`, to `layoutOf` and to the saved-layout loader (normalize: an object of finite numbers, else `{}`). Do not add it to `SCREEN_LAYOUT`, because a pop-out is about windows, not screen size.
- In the dockless patch at :2854, add `delete patch.popped;`.
- The actions:

```ts
  popOut: (id) => {
    const s = get();
    const slot = s.panels.indexOf(id);
    if (slot === -1) return;
    set({ popped: { ...s.popped, [id]: slot } });
    s.closePanel(id);
    // the marker is what lets this window claim the panel (a plain solo
    // tab, shift-click or typed URL never does)
    openNamed(`canopy:${id}`, soloUrl(id, { popped: true }), "window");
  },
  /** a pop-out said bye or asked to come back: the panel returns to its slot */
  returnPanel: (id) => {
    const s = get();
    const slot = s.popped[id];
    if (slot === undefined) return;
    const { [id]: _, ...rest } = s.popped;
    set({ popped: rest, panels: restorePanel(s.panels, id, slot), activePanel: id });
  },
  /** a window says it shows `id`: the dock lets go of it */
  claimPanel: (id) => {
    const s = get();
    if (!s.panels.includes(id)) return;
    set({ popped: { ...s.popped, [id]: s.panels.indexOf(id) } });
    s.closePanel(id);
  },
```

`closePanel` may also clear other per-panel state, such as `closedSections`. Read it first and make sure a pop-out does not lose the panel's folded sections. If it clears them, add a `keep` flag or split the removal.

`App.tsx`, in the main window only (`!dockless()`):

```tsx
useEffect(() => {
  if (dockless() || typeof BroadcastChannel === "undefined") return;
  const ch = new BroadcastChannel(PANES_CHANNEL);
  const claimed = new Set<string>();
  ch.onmessage = (e) => {
    const m = parsePaneMsg(e.data);
    if (!m) return;
    const s = useStore.getState();
    if (m.type === "hello") { claimed.add(m.id); s.claimPanel(m.id); }
    else if (m.type === "bye" || m.type === "return") { claimed.delete(m.id); s.returnPanel(m.id); }
  };
  ch.postMessage({ type: "who" } satisfies PaneMsg);
  const t = setTimeout(() => {
    for (const id of unclaimed(useStore.getState().popped, claimed)) useStore.getState().returnPanel(id);
  }, WHO_WAIT_MS);
  return () => { clearTimeout(t); ch.close(); };
}, []);
```

`routes.ts`: `soloUrl(id, opts?: { popped?: boolean })` appends `&popped=1` when asked. `parseRoute` returns `popped: boolean`. Export `openNamed`, or add `popOutWindow(id)` beside `openElsewhere` that opens the popped URL, and call that from the store.

`Solo.tsx`:
- Only when `parseRoute(location.search).popped` is true: in an effect keyed on `id`, open the channel and post `hello`. Answer `who` with `hello`. A solo window without the marker never joins the channel.
- On `pagehide`, post `bye`. When the pop-out reloads, `bye` fires and then `hello` again, so the main window returns the panel and claims it again within a moment. Accept that flicker, or delay `returnPanel` on `bye` by 300 ms and cancel it on a `hello` for the same id. The delay is better; do it in `App.tsx`'s listener with a `Map<id, timer>`.
- A "back to the dock" button in the solo top bar posts `return` and then calls `window.close()`.
- Before writing `popOut`, read `closePanel` at `store.ts:1913` and what it does to the panel's shells (`terms` with `place: "panel"`, `parkedTerms`) and to `closedSections`. Popping a panel out must not end, hide or park its shells, and must not forget its folded sections. If `closePanel` does any of that, split out a `dropFromDock(id)` that only takes the id out of `panels` and moves `activePanel`, and use it in `popOut` and `claimPanel`.

`Dock.tsx:1027-1028`: "open in a new window" becomes "pop out", which calls `popOut(repo.id)`. "open in a new tab" stays, opening a copy without leaving the dock, as today.

- [x] **Step 4: Gates, then the browser check**

Run: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

Then, with three panels:
1. Pop out the middle one. Check that it leaves the dock and its window shows the panel.
2. Click "back to the dock". Check that the window closes and the panel is back in the middle.
3. Pop it out again and reload the pop-out. Check that the panel stays out of the dock after the reload settles.
4. Close the pop-out with the window's close button. Check that the panel returns.
5. Pop out once more and reload the main window. Check that the panel stays out (the pop-out answers `who`).
6. Kill the pop-out tab through playwright without `pagehide`, then reload the main window. Check that the panel returns after 1.5 s.
7. Use "open in a new tab" on another panel. Check that it stays in the dock while the tab is open.
8. Pop out a panel with a running shell. Check that the shell is still running in the pop-out and is back in the panel after "back to the dock".
9. Open a second main window and check that both docks agree after each step.

- [x] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(dock): pop a panel out to its own window and back to its slot"
```

---

## Task 6: a full pass and the architecture note

**Files:**
- Modify: `docs/architecture.md`, sections "Layout and motion" and "ui/"

- [ ] **Step 1: Run the clean-build gate.** Run `~/.claude/skills/verify-build/clean-rebuild.sh rebuild`, then `verify "dockCarousel"`. The served bundle must carry the new setting key.

- [ ] **Step 2: One end-to-end browser pass** at 1440px:
1. Reorder three panels, one with a live preview.
2. Turn the carousel on and pan it.
3. Take one panel full screen and back.
4. Pop one out and back.

Throughout, the preview's navigation entry stays the same and the shell keeps its scrollback. Then resize to 760px and 390px and check that nothing overflows sideways.

- [ ] **Step 3: Write the notes.** Cover:
  - The stable DOM order and the CSS order rule, why it exists, and that a reorder is never a DOM move.
  - The carousel setting, the wheel rules and the snap keys.
  - Full screen on `documentElement` with `surface-full`.
  - The `canopy:panes` channel and its four messages.
  - `popped` in the layout, and that dockless windows strip it.
  - The 1.5 s `who` wait.

- [ ] **Step 4: Gates**

Run: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: the movable dock, phase A"
```

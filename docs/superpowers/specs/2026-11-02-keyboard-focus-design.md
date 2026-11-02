# A keyboard ring through cards and rows (FR-023)

Date: 2026-11-02. Status: built the same day.

## Intent

j and k (and ↓ and ↑) move a ring through the repo cards, the trigger rows and the inbox rows, as Linear's lists move their highlight. Space peeks at the ringed item's run in its sheet over the list, Escape closes the sheet and the ring is where it was, and Enter goes in. FR-024 (⌘K on the ringed card) and FR-025 (copy its branch, PR link or run id) read what the ring is on later, so the model says that in one place.

## The model

The ring is a key, `<kind>:<id>`, held in the store as `kbFocus`, with `kbRing` saying whether it shows. Three kinds:

- `repo:<repo id>`, a repo card and its row in the tree. Both carry the key, so one press rings both: the tree and the grid are one list, in the order `groupRepos` gives them both.
- `trigger:<backend>:<event id>`, a row of the triggers view.
- `inbox:<item key>`, an inbox row (`InboxRow`) in the dock's "waiting on you" panel.

It is a virtual focus, not the DOM's. A card that moves under an SSE update is moved by React, and a moved node loses DOM focus, so the place lives in the store and every item reads whether it is the ringed one. Each item carries `data-kb` with its key, and the ringed one `data-kb-on`, which `ui/src/styles.css` draws in sky with a wash.

The list j and k walk is read from the page: every `[data-kb]` under a zone's roots, in document order, each key once. Reading the page rather than the store keeps the order whatever groups, folds and filters (and FR-017's topic headings) do to it. A zone is a part of the page: `repos` (the tree and the grid), `dock` (the dock's panels) and `triggers` (the triggers view). The zone is where the last pointer press landed, or `dock` after `w` opens "waiting on you"; when that zone has nothing to walk, the view's own zone (git's `repos`, triggers' `triggers`). Each zone keeps its own place, so `w`, a few rows, then a click on the grid and back keeps both.

`ui/src/kbfocus.ts` is the pure half, tested in `kbfocus.test.ts`: keys, `stepKb` (move and clamp at the ends), `keepKb` (the place after the list changed), `ringOf` (what is ringed, for FR-024 and FR-025) and the guards on which targets keep their own keys. `components/KbFocus.tsx` is the page half: the hook items spread (`useKb`), the move, peek and go-in, and a watcher that keeps the place.

## Keys

| key | repo card or tree row | trigger row | inbox row |
| --- | --- | --- | --- |
| j, ↓ | the next one | the next one | the next one |
| k, ↑ | the one before | the one before | the one before |
| Space | the card's run sheet, the one its chip shows (a live workflow, else its run, else its last workflow) | the run's sheet | its sheet where it has one (a run, a workflow at a gate, a comparison, a sprout, the landing queue, a PR's run); an agent's ask has none, so its row unfolds |
| Enter | opens the repo, as a click does (`openRepo`) | the repo on the git view, its panel open | unfolds its form and puts the keyboard in its first box, else on its first button, as a run sheet's focus lands |
| Escape | closes the sheet a Space opened; the ring stays. With nothing to close, hides the ring and keeps the place | the same | the same |

In select mode Space and Enter on a ringed card pick or unpick it, as both keys do on a focused card today.

A card with no run has nothing to peek at. Space then opens nothing and the ring blinks once, so the press is answered. Opening the repo instead would make Space and Enter the same key, and offering a new run would start something from a key that only looks.

The first j or k with no place rings the first item. From a place that left the list, j lands on the next item that is still there and k on the one before, from the order the list had when the place was in it.

## Keeping the place

- The place is a key, so an SSE update that reorders, restyles or remounts the items leaves it where it was.
- When the ringed item leaves the list (filtered out, folded away, answered), the watcher moves the ring to the item that took its place: the next survivor in the old order, else the one before. With none left the ring hides and the place stays for the next press.
- A pointer press hides the ring, and on an item it moves the place there quietly, so j after a click goes on from what was clicked. A press inside a sheet, a menu or on a sheet's backdrop leaves the ring as it is.
- A sheet over the page is outside every zone, so opening and closing one moves nothing.
- Another view hides the ring and keeps each zone's place, so `g t`, then `g g` and j goes on from the card it was on. Space and Enter act only on a ringed item the page shows.

## What keeps its keys

j, k, the arrows, Space and Enter do nothing of the ring's in a text box, a select, anything `contenteditable`, a shell (xterm), a widget that moves with arrows (radios, tabs, listboxes, sliders, menus), or while a sheet, a dialog or a menu is up (`OVER_PAGE`, as ? and g already check). Space and Enter also leave a control that holds DOM focus alone: a button, a link, a card reached with Tab. A move takes DOM focus off whatever held it, so the next Enter is the ring's. Space and Enter act only while the ring shows, so a mouse user's Space still scrolls the page.

## Out of scope

- Left and right, and moving by rows of the grid: the cards are one list.
- The inbox popover, the agents board's inbox rows and the other views' lists. The popover is a dialog and keeps its keys; its rows are walked in "waiting on you" (`w`).
- The waiting panel's other rows (turns, repos, failures) and a repo panel's own rows.
- ⌘K on the ringed card (FR-024) and the copy keys (FR-025). `ringOf(state)` is what they read: the kind and id of what is ringed, or null while the ring is hidden.

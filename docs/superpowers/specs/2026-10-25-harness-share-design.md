# Harness share in the costs view (FR-044)

FR-044 asks the costs view to say what fraction of the spend and of the
sessions went into canopy itself, so that building the workbench never
quietly becomes the work. The warning is Steve Yegge's, from the author of
Gas Town: "working on Wheelhouse itself occupies about 20-25% of all my
Wyvern work" (https://yegge.ai/essays/the-shape-of-things-to-come/), and
Gas Town "was intended to be reusable, but I only ever wound up using it to
build itself". Canopy already keeps the figures; this puts one more line
over them. Ranked last in `2026-10-25-software-factory-borrowings-design.md`
on purpose: it is a mirror, not a feature, and a one-plan change.

## Where things stand (2026-10-25)

- The costs view (`ui/src/components/Costs.tsx`, pure sums in
  `ui/src/costs.ts`) shows today, 7 or 30 local days (`COST_WINDOWS`) by
  service, by repo card and by run or chat (`costSheet`), with the Claude
  sessions behind the dollars (`sessionLines`).
- Claude's dollars come from the claude-history archive in the store
  (`s.history`, a `HistoryOverview`): per repo id, `RepoHistory.days` is the
  spend per local day over `HistoryOverview.days` and `daySessions` the
  sessions started, oldest first. `claudeByCard` takes a card's largest
  checkout's figure, not the sum, since one archive may map a session to a
  checkout on each backend.
- Everything else is the per-backend ledger (`core/costledger.ts`,
  `core/costs.ts`: `costs/<YYYY-MM>.jsonl`, `CostEntry` with `repo`,
  `repoName`, `run`, `usd`, `tokens`, `seconds`), served by
  `GET /api/costs?days=` with the repo as this backend's id. Only Claude
  reports dollars; `prices.json` turns the rest into estimates.
- A repo is starred through `POST /api/repos/favorite` and
  `config.favorites` (a path list, `core/favorite.ts` `linkFavorites`);
  `config.archived` works the same way. There is no mark for "this repo is
  the harness".
- Per-browser settings live in `ui/src/settings.ts` (`Settings`) in
  localStorage; the inbox lists quiet lines from `landing/notices.json` at
  its foot, outside its count.
- The ranger's brief (`lib/ranger.md`) takes `{{slot}}` values and
  `{{#block}}` sections from `rangerBrief` (`core/ranger.ts`).
- The CLI has no `costs` command.

## The mark

A repo is a harness repo when its path is in `config.harness`, a path list
beside `favorites` and `archived`, kept and linked the same way
(`linkHarness` in `core/favorite.ts`, `Repo.harness?: true`,
`POST /api/repos/harness {harness: boolean}`, right `operate`). The card's
menu gets "counts as the harness" under "star". At first start a repo whose
root has a `package.json` named `canopy` is marked, once, so Eric's own
checkouts count without a click (`seedHarness` in `server/index.ts`, run
only when the list is absent from the config, never again). devhub,
tailchan, claude-history and herdr are Eric's to mark; canopy guesses
nothing more.

The list is per machine, like favorites, and the mark rides on the `Repo`
in every broadcast, so the page knows it for every backend's cards.

## The figure

`harnessShare(sheet, history, days, cards)` in `ui/src/costs.ts` (pure)
returns:

```ts
interface HarnessShare {
  /** dollars, reported plus estimated, in the window */
  usd: { harness: number; rest: number };
  /** Claude sessions started in the window, from the archive */
  sessions: { harness: number; rest: number };
  /** usd share, 0 to 1; null when nothing was spent */
  share: number | null;
  /** sessions share, the same */
  sessionShare: number | null;
}
```

- Dollars: each `CostLine` in `sheet.repos` is harness or rest by its
  card's `harness`; Claude's archive dollars are already in those lines
  through `claudeByCard`. Rows with no repo (a voice call outside a chat)
  are rest. `est` counts with `usd`, as the view's total does.
- Sessions: `RepoHistory.daySessions` summed over the window's days per
  card, taking the card's largest checkout as `claudeLeads` does; harness or
  rest by the card.
- Share is harness over harness plus rest. With nothing spent the figure
  reads "—".

### By week

`harnessWeeks(history, cards, weeks)` folds `RepoHistory.days` into local
weeks (Monday first, the newest week partial), `WEEKS` (8) of them, each
`{from, harness, rest, share}` in dollars from the archive alone, since the
ledger's non-Claude rows are small beside Claude's and the archive goes back
far enough. The store's overview covers the window it last asked for
(`HISTORY_WINDOWS`: 30d, 90d, all); the costs view asks for 90d when the
share table is open and falls back to the weeks it has. A week with no
spend reads "—".

## The view

Under the header's total, one line: "harness 23% of $41.20 · 31% of 48
sessions", the percentage in rust when it is at or over the threshold,
moss otherwise, with a title that names the harness repos. The line folds
open to the weeks: a plain table, one row per week, the share as a number
and as a bar, two spans with `width` set inline and the palette's tokens
(`--moss` for rest, `--rust` for harness over the threshold, `--lichen`
under it), in `styles.css` under `.cost-share`. No chart library; the view
has none and the rings in the sidebar draw the same way.

The threshold is a per-browser setting, `harnessShareMax`, default 25
(Yegge's own figure, rounded), 5 to 90, in the device tab of Settings as
"harness share warning at __ %". Zero turns the colour and the inbox line
off.

Once a week at most, when the newest full week's share crossed the
threshold, the page adds one quiet line to the inbox's foot: "last week 34%
of Claude spend went into the harness (canopy, devhub)", through the same
`advice`-style source the sprouts use, kept in localStorage with the week
it was for (`harnessSaid: "2026-W43"`), so each browser says it once and no
backend writes anything. It asks nothing and counts for nothing.

## The CLI and the ranger

- `canopy costs [--days 7|30] [--share]` (`cli/costs.ts`): without
  `--share`, the window's by-service and by-repo lines as `costSheet` sums
  them, from every backend the home one lists like `canopy health`; with
  `--share`, the figure and the weeks table. The CLI has no archive of its
  own, so Claude's dollars come from each backend's `/api/history` overview
  the way the page reads them (`GET /api/history?window=90d`, `read`).
- The ranger's brief gains `{{harnessShare}}`, the figure for the last
  full week with the threshold ("harness share last week: 34%, over the
  25% line"), filled by `RangerHub` from the same pure function over the
  server's overview when the brief is written. The ranger may say so in its
  weekly words to Eric; nothing in canopy acts on it.

## Routes

No new route beyond `POST /api/repos/harness`. The page has the sheet, the
overview and the cards; the CLI reads the routes that exist.

## Components

- `src/core/favorite.ts`: `linkHarness`, `setHarness`; `src/core/types.ts`:
  `Repo.harness`, `Config.harness`.
- `src/server/index.ts`: the route, `seedHarness`, the config field.
- `ui/src/costs.ts`: `harnessShare`, `harnessWeeks`, `WEEKS`, `weekKey`.
- `ui/src/components/Costs.tsx`: the line and the table; `styles.css`'s
  `.cost-share`.
- `ui/src/settings.ts`: `harnessShareMax`; `Settings.tsx`'s row.
- `ui/src/inbox.ts`: the weekly line; `ui/src/store.ts`: `harnessSaid`.
- `components/RepoMenu.tsx`: "counts as the harness".
- `src/cli/costs.ts` (new), `cli/index.ts`.
- `src/core/ranger.ts`: the slot; `lib/ranger.md`: one line using it.
- `docs/architecture.md`: two sentences under "Costs".

## Calls

Made on 2026-10-25:

1. **A mark in config, not a heuristic.** Which repos are "the harness" is
   Eric's call; canopy seeds its own name once and stops guessing.
2. **Dollars and sessions both.** Dollars follow the model; a week of
   cheap Haiku runs on canopy would hide under dollars alone. Sessions
   count attention.
3. **Weeks from the archive alone.** The ledger's non-Claude rows are
   voice minutes and Codex tokens with no price unless `prices.json` says;
   mixing estimates into a trend line would make it jump when a price is
   added.
4. **The browser says the weekly line, not the server.** It is a note to
   Eric, not an event; a per-browser `said` key keeps it to once a week
   with no file on any backend.
5. **25% default.** Yegge's own number for his harness, and the one the
   research called a warning.

For Eric:

6. Whether the share should also appear on the top bar beside the inbox
   chip, in rust when over. The spec keeps it in the costs view; a chip is
   one line more if the mirror is to be in view every day.

## Out of scope

- Budgets, caps or any hold on harness runs. The figure informs; the
  capacity governor (`2026-10-25-capacity-governor-design.md`) is where
  priorities live, and it does not read this.
- Time tracked outside Claude (an editor, a terminal without an agent).
- A share by task kind (features vs fixes). The ledger carries the verb;
  a later cut could use it.

## Testing

- `ui/src/costs.test.ts`: `harnessShare` with harness and rest cards,
  rows with no repo, estimates counted, nothing spent (`null`); sessions
  from `daySessions` with two checkouts of one card (the larger counts);
  `harnessWeeks` over 60 days of fixture spend (Monday boundaries, the
  partial newest week, a week with nothing), `WEEKS` cap.
- `favorite.test.ts`: `linkHarness` and `setHarness` beside the favorites'
  cases.
- `server/index` tests: the route's 400 on a non-boolean, the broadcast,
  `seedHarness` marks a `canopy` package once and never on a later start.
- `settings.test.ts`: the default and the 5–90 clamp.
- `inbox.test.ts`: the weekly line once per week key, none under the
  threshold or at zero.
- `cli/costs.test.ts`: the lines from a stand-in overview and sheet.
- `ranger.test.ts`: the slot filled and the line present only with a
  figure.

## Plans

1. The mark, the figure, the weeks table, the setting and the inbox line;
   `canopy costs`; the ranger's slot. One plan.

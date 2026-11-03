# Quick notes and reminders (FR-020)

Date: 2026-11-02. Status: built the same day.

## The case

A thought arrives while a run is going: "ask Eric about the atlas push", "look at the ranger's brief tomorrow". Today it goes into a pen note or a shell comment and is lost, or it interrupts the work to find a place for it. The request is a jot that stays in canopy, on a repo or on its own, and a reminder that comes back by itself when its time comes.

## The record

A note is `{id, text, repoId?, due?, createdAt, remindedAt?, doneAt?}`, kept in `<config dir>/notes.json` as one array. One file, not a file per note: a note is a line of text, there are tens of them at most, and `triggers.json` and `capacity.json` already keep a small whole in one file. The id is `n-` and eight base32 characters, minted as the work ledger's is. `core/notes.ts` is pure and browser-safe (the UI imports its types): it parses the file (a bad record is dropped, never the file), caps the text at 600 characters, sorts open notes due first, and says which reminders have come due. The file is read again before every write and written whole through a temp file and a rename, so two servers on one config dir during a redeploy's overlap clobber as little as possible; a lost note between two servers in that minute is accepted.

A note lives on one backend: the one its repo lives on, else the page's home or the CLI's `--backend`. The page lists every backend's notes under its prefixed ids, as it does trigger events, and the inbox merges them.

## Routes and the event

`GET /api/notes` (read) lists every note. `POST /api/notes` adds one (`text`, optional `repo` by id or path, optional `at`); `POST /api/notes/edit` changes text, repo or time by id; `POST /api/notes/done` marks one done; `DELETE /api/notes?id=` removes one. The writes need the operate right, so a shell's or the CLI's token can jot, and the ranger's too. `at` is a time as typed, read by `parseWhen` from `core/cron.ts` (`in 30m`, `14:00`, `2026-11-03 09:00`), on the server's clock, so a clock time means the backend's local day, as the sweep's hour does. Every change broadcasts `{type: "notes", notes}` whole, so every open page follows.

## The reminder

A note with a `due` in the past and no `remindedAt` is delivered once: `remindedAt` is set, the file written, the event sent. The inbox builds an item from every note with `remindedAt` set and no `doneAt`, so the reminder stays in the inbox until it is done, and a reload or another device shows the same row. The row names the note's text and its repo, and offers done, an hour later (which moves `due` and clears `remindedAt`, so it comes back once more) and the notes popup. The waiting panel and the system notification take it as they take any inbox item.

The delivery runs from the triggers' tick (`TriggerHub.tick`, every 30 seconds), through a `remind` dependency the server wires to the notes hub, not from a timer of the notes' own and not from the sweep's. The triggers' tick is already the clock that fires cron schedule rules and the daily digest, it runs only on the server holding the flows lock (so two servers on one config dir never both deliver), and its `now` is injectable. The sweep's tick is about closing what went idle, runs once a minute, and is skipped under test altogether.

## The page and the CLI

A notes chip in the top bar (✎ and the count of open notes) opens a popup like the tasks': a form (text, a repo picked from the repos the page knows, a remind-at as typed) and the open notes, each with its repo, its due word and done and delete. The popup is a `PopupName`, so FR-030's tab and FR-047's dock card apply to it for free. A repo's grid card and its panel head show ✎ and its count of open notes when it has any; the chip opens the popup.

`canopy note add "<text>" [--repo <id>] [--at <time>]`, `canopy note list [--all]`, `canopy note done <id>`, `canopy note delete <id>`, each a call to the routes with the caller's token.

## Out of scope

- Repeating reminders: a reminder fires once; a cron line is a trigger rule's.
- Notes synced between backends, or attached to a run or a work item.
- A reminder that pings tailchan or the ranger: the inbox and the browser notification are the delivery.

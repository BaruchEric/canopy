# People, teams and tenants (FR-074)

Date: 2026-11-22. Status: plan 1 (people, roles, invites, who did what, who is here) is built on the `multi-user` branch. Of plan 2, teams are built as a focus: a name, folders and members, and the page starts a member on their teams' repos. The scope lane that would make a team a wall is designed below and not built. Plan 3 (a tenant as a backend) is designed and not built.

## The case

canopy knows devices and agents, never people. A page that signs in is "a page": it holds every right, and nothing says whose it is. That was right for one owner. It stops being right the day a second person is let in: a partner who should watch and not push, a contractor who should work in one repo, a family member with their own phone. Today the only way in is to hand over the owner's rights.

This reverses SPEC.md's "Multi-user accounts, permissions or teams" under Out of scope, on Eric's ask of 2026-11-22.

## What a backend can and cannot promise

A backend is one trust domain. Whoever holds `operate` or `shell` there can run code as canopy's OS user: an agent's Bash runs what they approve, and a shell is a shell. So a role or a team's scope decides what the API shows and takes from a person. It guards against accidents and against a watcher reading what they should not. It is not a wall against a hostile teammate who can start a run. Two people who must not reach each other's files need two backends (plan 3). The page already joins many backends, each with its own sign-in, so that costs nothing in the UI.

Runs use the backend's own `claude` login. A second person's runs spend that login's plan, and a Max plan is one person's. A team should give its backend a provider file (`providers/<id>.json`, FR-069) on a key the team pays for. canopy says so in the People view and does not enforce it.

## The record

`<config dir>/people.json`, 0600, written whole through a rename, read again before each write:

```
{ owner: { name, color? },
  people:  [{ id, name, role, teams: [team id], color?, created, off? }],
  teams:   [{ id, name, folders: [absolute path], created }],
  invites: [{ hash, person, created, expires, by }] }
```

- A person's id is `p-` and eight base32 characters. The built-in person `owner` always exists, is never in the list, cannot be removed or demoted, and is who every session without a person belongs to. So a backend with no `people.json` behaves exactly as before, and every page and CLI Eric already signed in stays his.
- Roles cap rights. `owner` and `admin` hold all six. `member` holds read, plan, operate, shell and helper (a helper on their own machine). `viewer` holds read. A caller's rights are its kind's and its person's role's, both: a member's shell token holds read and operate, a viewer's CLI holds read.
- Nobody hands out more than they hold: an admin cannot make an owner, invite one, change one or approve a device as one. Admin and owner differ only in that.
- `off` keeps the record and drops every token the person holds. Removing a person does the same and deletes the record.
- An invite is `cnv_` and 24 base32 characters, kept as its SHA-256, good once and for 72 hours unless it says otherwise (1 hour to 30 days). At most five wait per person.

`core/people.ts` is pure and browser-safe: the types, the role table, `rightsOf(kind, role)`, the parser (a bad record is dropped, never the file), the rules above as functions that return a refusal's words, and a team's focus (`focusOf`, `inFocus`). `server/people.ts` holds the file, the routes and the event.

## Signing in as someone

- `POST /api/auth/join {code, label, kind}` (open, counted against guesses like `claim`) trades an invite for a token of that kind, page or cli, that belongs to the invite's person. The page reads `?join=<code>` once, takes it out of the address bar, and signs in with it. The sign-in box takes a pasted invite too. `canopy auth join <code>` does the same for a CLI. A page that is already signed in keeps its session and says the invite was left unused, so the owner opening a link they made never becomes the invitee. A join may carry the asker's own waiting pair (`id`, `secret`), which the backend then withdraws so it does not sit in an inbox.
- `POST /api/auth/approve {id, person?}` gives the device to the approver's own person unless it names another the approver may hand out. The inbox card has a picker.
- `POST /api/auth/signout` (open, needs a token) drops the calling session, since `revoke` is admin's and a member must be able to leave.
- The first code in the server's log still makes the owner. The backend offers it whenever no owner's page or CLI session is live. Before people, any live session held it back. A member's session approves no owner, so that rule would have locked the owner out once their own sessions lapsed.
- Tokens canopy mints for agents carry the person who started them: a shell's opener, a run's starter. The ranger is the owner's. A shell someone else joins keeps its opener.
- `GET /api/auth` adds `person` (`{id, name, role}`) and `rights`, the caller's own, so the page asks once.

The people routes that write, and `auth/join`, are checked in every mode, like the auth routes: in `log` a role is counted, not refused, but nobody without admin adds a person or mints an invite.

## Who did what, and who is here

- `Run.who`, `Flow.who` and `TermInfo.who` are the person's id (`by` already names the caller kind). The server takes it from the request's caller through an AsyncLocalStorage actor (`server/actor.ts`, `byWhom()`). A run started by a trigger, a flow step or the ranger has none.
- `<config dir>/activity.jsonl` (0600) takes one line per write a caller made that canopy answered 2xx, for the routes `ACTIVITY` in `core/people.ts` gives words to ("started a run", "pushed", "answered a prompt"): `{at, person, kind, what, repo?}`. Reads, beats and tickets are never logged. The file is cut to its newest half at 2 MB. `GET /api/people/activity?limit=&person=` (read) answers the newest 200.
- A device carries its stream's person. `POST /api/people/at {client, repos}` (read; it says only where the caller is) keeps the repos a browser has open, at most 12, and `GET /api/people` answers each person with the devices they have on and those repos. The `people` event carries the same, whole, whenever the roster or anyone's place changes. A place counts only for the person who said it, is kept 30 seconds for a browser whose stream has not opened yet, and is forgotten once that browser is off.

## Routes

| route | right |
| --- | --- |
| `GET /api/people` | read; invites only to admin |
| `GET /api/people/activity` | read |
| `POST /api/people/at`, `POST /api/people/me` (own name and colour) | read |
| `POST /api/people/add`, `set`, `remove`, `invite`, `uninvite`, `team`, `team/remove` | admin, in every mode |
| `POST /api/auth/join`, `POST /api/auth/signout` | open; the handler checks |

## The page and the CLI

- A People view (`?view=people`, `g` then `u`): your own name, colour and sign out; the roster with role, teams, devices on and where; add a person; role and team pickers; an invite's link shown once with a copy button; off and remove; the teams and their folders; the activity feed. Controls show only to a caller that holds admin.
- The top bar shows the other people who are on, as initials in their colour, and says "viewing" to someone whose role only reads. A repo card shows the initials of others who have it open. A run's sheet and a kept shell's row say who started it when that is not you. A viewer's shell tab says a viewer opens no shell and asks for no ticket.
- The filters menu has "my teams only", which starts on for a member or viewer whose teams name folders.
- Settings' sign-in tab names who you are and your role, and lists each caller with its person.
- `canopy people [list|add|invite|uninvite|role|rename|team|off|on|remove|me|teams|activity]`, `canopy auth join`, and `canopy auth status` says the person and role.
- `scripts/browser/people.sh` drives all of it in a headless browser on a scratch backend that enforces who calls.

## Plan 2: teams

Built: a team is a name, folders and members. A repo is a team's when its path sits under one of its folders. The page of a member or viewer whose teams name folders starts with "my teams only" on, and they can turn it off. That is a focus and not a wall: the backend still answers every repo to everyone signed in, and the People view says so.

Not built, the wall: a member or viewer with teams would be scoped, so canopy shows and takes only those teams' repos. Owners and admins are never scoped.

The 2026-11-09 decision turned down hiding fields per caller, because a list that leaks unless someone remembers a filter is a bug waiting. The scope is built the other way round, as the coordinator's lane is: a scoped caller reaches only the routes `SCOPED` names, each with how it is held to the scope (`filter` for a list whose answer is cut down, `repo` for a route that names one repo in its query or JSON body, `own` for the caller's own records), and hears only the events `scopeEvent` knows how to cut. Everything else is a 403 that says so, in every mode. A new route or event is closed to a scoped person until someone files it. What is filed first is the board: the tree, the repo reads, runs and their answers, shells, tasks, the people routes. The Library, the kit, secrets, notes, clips, the work ledger, the landing queue, triggers, the coordinator, the incubator, tailchan and the sweep stay closed. A scoped person's shell token is scoped too, and the page hides the views it cannot load.

The scope is soft for the reason above: a scoped member's agent can still `cat` a sibling folder. It is exact for a viewer.

## Plan 3: a tenant is a backend

`canopy tenant add <name> --root <dir>` on a host makes a second canopy with its own config dir, port, callers and people, and names it in the page's backend registry: under launchd on a Mac, as a compose project on the mini, with its own OS user or container when the two must not read each other's files. Each tenant signs in apart, and a person in two tenants sees both in one page. Not built: it is deploy work on each host, and it wants a provider per tenant first.

## Out of scope

- Passwords, email, SSO. Identity is an invite or an approved device. Cloudflare Access still fronts a public name.
- Per-repo roles, comments, assignment and per-person inboxes. `Run.by` is what a "mine" filter would read.
- Billing, quotas or a cost split per person, beyond the `by` the cost ledger could later carry.

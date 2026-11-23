# People, teams and tenants (FR-074)

Date: 2026-11-22. Status: plan 1 (people, roles, invites, who did what, who is here) and plan 2 (teams, as a focus and as a wall for the API) landed on main on 2026-11-23, with a viewer's page that offers nothing their role refuses. Plan 3 (a tenant as a backend, `canopy tenant`) is built too, on launchd on a Mac and as a compose project on the mini.

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

A team is a name, folders and members. A repo is a team's when its path sits under one of its folders. A member or viewer whose teams name folders is scoped, and canopy shows and takes only those teams' repos. Owners and admins are never scoped, nor is a person on no team with folders.

The 2026-11-09 decision turned down hiding fields per caller, because a list that leaks unless someone remembers a filter is a bug waiting. So the scope is built the other way round, as the coordinator's lane is: a scoped caller reaches only the routes `scopeRule` in `core/scope.ts` files, each with how it is held. `filter` is a list whose answer is cut down (the tree, runs, flows, fleets, jobs, shells, kept shells, tasks, branch trees, devices, helpers, the roster, the activity log). `ids` is a route that names a repo, a run, a flow or a shell in its query, its JSON body or its path, every one of which must trace to a repo under the folders; two values under one key, a missing id and an id canopy does not hold are refused. `own` is the caller's own records, and `any` holds no repo's data (the agents' profiles, the verdict, the push key, the backend registry). The event stream is cut per stream by `scopeEvent`, which drops any kind it does not know. Everything else is a 403 `{error, scoped: true}` in every mode, so a new route or event is closed to a scoped person until someone files it. The Library, the kit, secrets, notes, clips, the work ledger, the landing queue, triggers, the coordinator (a run's body asking to coordinate too), the incubator, tailchan, the sweep, archiving, moving and launching a repo, and opening anything on the backend's desktop stay closed. Routes open to anyone stay open, the Library's reads among them, and the page does not offer that view.

What the build found on the way. A run, a shell and a task in a kept branch tree live under the config dir, not the team's folder, so each carries its checkout's `repoId` and the wall traces that. The activity log named a repo by name, and two repos share a name across folders, so each line now carries `repoId` too. A person's scope moves when a team's folders or members change; their streams end then, and the next read is the new cut. Every route an agent's token reaches is filed or named as closed on purpose, and a pure test holds that.

The page asks nothing the wall would refuse. `req()` learns from the auth read whether a backend holds the page and answers a closed route itself, with the backend's refusal. A held page offers the board, the shells and the people, and nothing else. `canopy auth status` names the folders.

The scope is soft for the reason above: a scoped member's agent or shell can still `cat` a sibling folder. It is exact for a viewer.

A viewer's page. The role caps the API, and the page now keeps to it too: under enforce `req()` answers a route the role lacks locally, and the controls a viewer cannot use are gone (card and panel menus, staging and the commit box, pull and push, the guided panel's run and save buttons and its tour, the agent buttons on a shell's tab row, a run's answers, composer, stop, fork, rename and side questions, a new shell). The star shows and stars nothing.

## Plan 3: a tenant is a backend

`canopy tenant add <name> --root <dir>`, run on a host, makes a second canopy there with its own config dir, port (7880 to 7899), callers and people, enforcing who calls from the start, and names it in that host's backend registry, so the page already open there lists it. Each tenant signs in apart: its log prints a first sign-in code for its owner, and a person in two tenants sees both in one page. `canopy tenant list` says which are up; `canopy tenant up <name>` starts one again on what the host has now (a redeploy leaves tenants on the image they started with); `canopy tenant remove <name>` stops one and takes it out of the registry, keeping its state unless `--purge`. On the mini the registry is the main stack's, edited through `docker exec canopy-canopy-1 bun bin/canopy.ts tenant register|unregister`, and those two touch only an entry on a tenant port, so a slip of the name never drops the mini, the Mac or De Soto. The pure half (names, ports, the plist, the compose `.env`, the origins, the registry edit) is `core/tenant.ts`; the host's half is `cli/tenant.ts`.

On Linux (the mini) a tenant is a compose project, `canopy-t-<name>`, from `docker-compose.tenant.yml`: the main stack's images, its own config volume, one port on loopback that `tailscale serve` puts on the tailnet over https (as the main stack's 7849 is), and only two binds, the tenant's folder and a home of its own under `~/.local/share/canopy-tenants/<name>/`. Nothing of the owner's is mounted: no `~/.claude`, `~/.claude.json`, `~/.ssh`, `~/.codex`, `GH_TOKEN` or secrets socket. That is the wall: the tenant's agents and shells see the tenant's folder and nothing else of the host. No incubator, coordinator, secret store, previews or tunnel. The main stack's registry is edited through its container, and the tenant answers every page the main stack answers.

On a Mac a tenant is a launchd agent, `canopy.tenant.<name>`, running bun on canopy straight (not `mac-server.sh`, which loads the owner's keys), with `HOME` set to a folder of its own under `~/.config/canopy/tenants/<name>/` and listening on loopback only. Its people, callers, state and claude login are its own, checked: `claude auth status` under that HOME says not logged in. Its files are not: it runs as the owner's OS user, so an agent there can read the owner's home, and ssh reads the owner's `~/.ssh` whatever `HOME` says and reaches the owner's ssh agent through the `SSH_AUTH_SOCK` launchd hands every agent. `GIT_CONFIG_NOSYSTEM` keeps git off Homebrew's system gitconfig, whose keychain helper would hand a push the owner's GitHub login, and `CANOPY_NO_DESKTOP` keeps the desktop openers off the owner's screen. So a Mac tenant is for a second roster on one machine, and the mini's is for a group that must not reach the owner's files.

A tenant starts with no claude login, on purpose, since a Max plan is one person's. Give it a provider file (`providers/<id>.json` in its config, FR-069) on a key the group pays for, or sign claude in from one of its shells.

Tried on 2026-11-23 with a scratch tenant on each host. On the Mac the agent came up on 7880, refused a bare call, took its first code from a CLI with a config of its own and scanned only its folder; launchd showed the switches above. On the mini the project came up on 7880 behind `tailscale serve`, answered a page at `https://canopy.beric.ca` and refused one from an origin not on its list, mounted only the tenant's folder, its home and its volume, took its first code over the tailnet and scanned only its folder, and `tenant up` started it again. `remove --purge` left no agent, plist, container, volume, network, serve entry or state on either. One limit found: canopy's tmux socket lives in the config dir, so a config dir path longer than about 90 characters exceeds macOS's 104-byte socket path limit and the server will not start; the default `~/.config/canopy/tenants/<name>/config` is well inside it.

## Out of scope

- Passwords, email, SSO. Identity is an invite or an approved device. Cloudflare Access still fronts a public name.
- Per-repo roles, comments, assignment and per-person inboxes. `Run.by` is what a "mine" filter would read.
- Billing, quotas or a cost split per person, beyond the `by` the cost ledger could later carry.

# Linear triggers: a labeled issue starts a branch run

Status: built on 2026-10-23 against fixtures. Not yet run against a real Linear workspace: no Linear account or key was on the mini when it was built.

## Why

Eric asked for Linear in canopy (2026-10-23). Linear holds the planning half of the work: a backlog with priorities, triage, cycles and roadmaps. canopy holds the shipping half: branch runs, the landing queue and the PR watch with auto-fix and auto-merge. Triggers already join the two for Sentry: an outside issue starts a run on its own branch, the run ends in a PR, and a merge marks the issue resolved. A Linear issue fits the same path, so Linear is a second trigger source, not a new subsystem.

## Decisions

- **A label starts the work.** A rule names the labels that mean "canopy, do this" (`labels`, default `canopy`). An issue fires when one of them is new on it: created with it, or updated to add it. Any other update (a title edit, a comment, a state change) is a quiet 200. A label matches by name, ignoring case, or by id, since Linear's docs show no full issue payload and a payload with `labelIds` alone still matches by id.
- **One hook address per rule**, `/api/hooks/linear/<rule>`, like Sentry's. A Linear webhook is set per team or for the whole workspace, so a rule's `projects` holds team keys (`ENG`) to keep one workspace webhook from firing every rule. An issue already completed or canceled is recorded as ignored.
- **Signed and fresh.** The hub checks `Linear-Signature` (hex HMAC-SHA256 of the raw body under the webhook's signing secret, in constant time) before it parses a word, then refuses a `webhookTimestamp` more than 60 s from its own clock, as Linear's docs advise against replays. Linear counts only a 200 as delivered and retries after 1 minute, 1 hour and 6 hours.
- **The issue is data.** The note fences the title, id, team, state, priority, labels, link and description (cut to 6,000 characters) as data, not instructions, the same as Sentry's error text. Anyone who can write in the workspace, and anything Linear's intake turns into an issue, chooses those words. The seed workflow's tools match `sentry-fix`'s: no `bun x`, `bunx` or `bun install`.
- **The branch names the issue.** The note leads with "Linear issue ENG-123 came in.", so the branch reads `run/linear-issue-eng-123-…`. Linear's GitHub integration, where it is installed, links a PR to an issue by the id in its branch name, so that part needs no call from canopy.
- **Write-back needs a token.** With `tokenEnv` naming a Linear API key (a `CANOPY_TRIGGER_` variable like every rule secret, so no run or shell inherits it), canopy comments on the issue with the PR's link once the PR opens, and moves the issue to its team's first completed state once it merges. Without one, nothing goes back to Linear. A test fire never calls Linear. A personal key goes in the `Authorization` header bare; anything else goes as a Bearer token.
- **The seed workflow is `linear-issue`** (unlisted, one step). An issue is a request, not a crash, so the step checks first that the issue is clear and small enough to finish in one run. When it is not, it commits nothing and says what is missing, and the event reads "no fix". Where the issue leaves a product decision open, it stops and names the decision rather than inventing an answer.
- **The event keeps its service.** `TriggerEvent.service` is the rule's source, so a test fire on a Linear rule still says "Linear" on the page. An event written before this has none and reads as Sentry, the only source there was.

## Setup

1. In Linear: Settings, API, Webhooks, new webhook. URL: the hook address the triggers page shows. Data change events: Issues. Copy the signing secret.
2. In Linear: Settings, Security and access, personal API keys, a key with write access, when the PR link and the move to done should go back.
3. Put both in the backend's env as `CANOPY_TRIGGER_<NAME>_SECRET` and `CANOPY_TRIGGER_<NAME>_TOKEN` (the secret store's dotenv sink can fill them), then restart canopy.
4. Add the rule to `<config dir>/triggers.json`:

```json
{ "rules": [{ "name": "web-linear", "source": "linear", "repo": "web-apps/shop", "secretEnv": "CANOPY_TRIGGER_WEB_LINEAR_SECRET", "tokenEnv": "CANOPY_TRIGGER_WEB_LINEAR_TOKEN", "projects": ["ENG"], "labels": ["canopy"] }] }
```

5. The edge gate in front of canopy.beric.ca must let `/api/hooks/*` through, as for Sentry.

## Not done

- A list of Linear issues inside canopy to pick from. It needs the API's read side, and the label already works from Linear's own UI, keyboard and mobile app.
- Linear's agent API, where canopy would be a workspace member that issues are assigned to and that posts its progress as agent activity. That needs an OAuth app with `actor=app` and a public callback.
- Moving the issue to "In progress" when the run starts, and back when it fails.
- One rule fanning out to several repos by team or project.
- Polling Linear, where a webhook cannot reach the backend.

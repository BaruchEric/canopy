# Agent defaults and routing

Canopy needs one place to set agent, model, reasoning effort, provider,
permissions and extra arguments for its systems, work types, workflows,
repos and agent tasks. Eric also requested that cost, token and usage logs
follow the resolved settings.

## Design

Extend the existing profiles and agent resolver. Settings gains an agent
defaults tab using the same editor as Agents → routing. Each backend keeps
its own settings on the server, shared by its connected browsers.

The first usable selection wins:

1. Explicit launch or workflow step profile.
2. Repo's named workflow or task.
3. System's named workflow or task.
4. Repo's work-type route.
5. Repo's general route.
6. System's work-type route.
7. System default profile, then built-in defaults.

Selections are complete settings or named profiles. Inherit removes a
selection; it does not copy the parent's values. Missing profiles fall
through and show a warning. Named workflows override broad repo defaults
because they identify a more specific kind of work. Existing routing
without named overrides retains its order.

Agent tasks are ask and propose. Development commands in the Tasks panel
execute shell commands and have no model settings. Propose and unattended
trigger runs require Claude Code; the editor warns about incompatible
inherited choices. Trigger workflow steps use their named workflow/profile
first and fall back to task ask and job defaults. Their job context survives
server restarts.

Codex can select a configured provider ID without storing credentials.
Claude Code retains the provider in its own CLI configuration. A blank
provider leaves the client's configuration in control.

## Accounting

New runs and ledger rows retain resolved settings so later routing edits
cannot change historical attribution. Reported provider/model metadata
takes precedence where available. Token and dollar deltas must both survive
when a client reports both, and resumed sessions must not count usage twice.
Old ledger rows remain readable and are not rewritten. Provider-specific
price keys must match the recorded provider.

## Alternatives

A separate defaults store would duplicate existing profiles and drift from
launches. Field-by-field inheritance would let unrelated harness/model
choices combine. Complete profile selections reuse the existing resolver
and keep harness-specific validation together.

## Verification

Pure precedence and compatibility tests, HTTP persistence/broadcast tests,
real runner and flow orchestration with only the paid process replaced,
accounting delta tests, browser save/reload/inherit checks, lint, typecheck,
build and the full existing test suite. No live paid model call is needed.

# Capacity probes, 2026-10-26

Status: public-source and local-protocol checks recorded. Live usage-window,
credential metadata and refresh checks remain unobserved. The fixtures are
synthetic examples from the design, not captured account replies. Nothing
reads stored credentials or polls a usage endpoint in the implementation.

## P1

**Command:** not run against a spent window. Installed version checked with
`claude --version`.

**Observed:** `2.1.310 (Claude Code)`. Spent-window reply not observed yet,
2026-10-26.

**Answer:** expected from the design: an error result or stderr containing
`You've hit your limit · resets 3pm`. The fake CLI exercises both paths.
No quota was deliberately spent. The reset's clock is an assumption from
the design, exercised as the backend's local clock, not a live observation.

**Date:** 2026-10-26.

## P2

**Command:** opened the public Orca request and window mapping sources,
ccusage's README, and the two Claude Help Center articles linked below.
No authenticated request was made.

**Observed:** Orca calls `https://api.anthropic.com/api/oauth/usage` with an
OAuth authorization header, `anthropic-beta: oauth-2025-04-20` and a CLI user
agent. It maps `five_hour` and `seven_day` windows. The mapper treats
`utilization` or `used_percentage` as percentages, and accepts reset strings
or numeric timestamps. Its service also refreshes on window activation.
An exact polling interval was not verified. ccusage describes local log
analysis; that README does not establish a second usage-endpoint reader.

The Help Center says, “You can still use the Claude Agent SDK, `claude -p`,
and third-party apps with your subscription limits.”

**Answer:** public code supports the endpoint's expected keys, but no live
reply was captured. The parser retains the design's percentage-or-fraction
compatibility for synthetic fixtures. The quoted sentence permits continued
subscription use; it does not explicitly describe reading this endpoint
with a stored credential. That distinction remains an inference, and
`source: endpoint` stays held for Eric's call 8. Monthly API credits are a
separate opt-in lane and remain unclaimed and unwired.

Sources checked:

- [Orca usage request](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/claude-oauth-usage-request.ts)
- [Orca window mapping](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/claude-usage-window.ts)
- [Orca refresh lifecycle](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/service/service-configuration.ts)
- [ccusage README](https://github.com/ryoppippi/ccusage/blob/main/apps/ccusage/README.md)
- [Claude plan usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Monthly API credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)

**Date:** 2026-10-26. These links point to mutable source branches.

## P3

**Command:** not run. No keychain secret, credential file or remote account
was read, and no refresh was induced.

**Observed:** not observed yet, 2026-10-26.

**Answer:** the design names a macOS keychain item and a credential file in
the mini's bind mount. Their current metadata, ownership, expiry and refresh
behavior are unverified. This does not affect the observed ledger/hit path,
which uses neither location. A future metadata-only check and a refresh
observation must be recorded as new observations rather than inferred here.

**Date:** 2026-10-26.

## P4

**Command:** `codex --version`, `codex app-server --help`, and
`codex app-server generate-json-schema --out .superpowers/sdd/2026-10-26-capacity-governor-1/codex-schema`.

**Observed:** `codex-cli 0.164.0`. The generated local schema includes
`usageLimitExceeded` in `v2/ErrorNotification.json`, the error's
`additionalDetails`, `account/rateLimits/read` in `ClientRequest.json` and
`account/rateLimits/updated` in `ServerNotification.json`. No live request
was made, and no spent-window text was observed yet, 2026-10-26.

**Answer:** this installed protocol does expose usage readings, so assuming
that Codex has no such method would be wrong. Plan 1 still does not call it;
Codex capacity is unknown until a reported hit. The existing driver joins
failed-turn error text and additional details. Its regression uses the
synthetic text `usage limit reached` with `try later`, not a captured reply.
Actual protocol-to-reading integration is later work.

**Date:** 2026-10-26.

## P5

**Command:** not run against a spent weekly window.

**Observed:** not observed yet, 2026-10-26.

**Answer:** the expected fixture is
`You've hit your weekly limit · resets Thu 3pm`. The word `weekly` selects
the weekly window in the pure parser. This remains an expected example
until a real CLI reply is recorded.

**Date:** 2026-10-26.

## What the code takes from this

- P1: synthetic result and stderr fixtures exercise the same limit text.
- P4: synthetic failed-turn text exercises the shared driver classifier;
  the installed usage methods are documented but unused.
- P5: the expected weekly wording selects a weekly hit.
- P2: `five_hour` and `seven_day`, utilization and reset timestamps are
  parsed without wiring an endpoint reader.
- `source: endpoint` remains held for Eric's call 8; the Help Center sentence
  quoted above does not itself settle the credential-reading question.
- With no configured dollar figure, ledger observation leaves utilization
  unknown. Actual hits still have a reset and expiry.

# Capacity probes, 2026-10-26

Status: public-source and local-protocol checks recorded. A real spent
five-hour window was found in a Claude Code transcript and recorded under P1
on 2026-11-02, with the wording of the current CLI read from its binary.
P3 has file metadata only. A spent weekly window (P5), credential expiry and
refresh remain unobserved. The fixtures are
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

**Observed, 2026-11-02:** a spent five-hour window from 2026-10-10, found
in an interactive Claude Code 2.1.296 transcript on the mini
(`~/.claude/projects/-home-eric-dev-dev-tools-canopy/9362f105-....jsonl`,
lines 2578 to 2580 and two later retries). No quota was spent to get it.
The CLI wrote a synthetic assistant message, model `<synthetic>`, with
`error: "rate_limit"`, `isApiErrorMessage: true`, `apiErrorStatus: 429`,
`apiError: "usage_limit_reached"` and this text:

```
You've hit your session limit · resets 1:40pm (UTC)
```

Its `quotaLimits` and `apiErrorParams.rate_limit_info` carried
`status: "rejected"`, `rateLimitType: "five_hour"` and
`resetsAt: 1791639600` (2026-10-10 13:40 UTC), and the notice line read
`Usage limit reached · continuing automatically at 1:40pm`.

The installed 2.1.316 binary (read with `grep -a`, nothing run) builds the
text as `You've hit your <window><suffix>`, with the windows
`5-hour limit`, `weekly limit`, `Opus limit`, `Sonnet limit`,
`Fable limit` and `usage credit limit`, and still recognizes the older
`session limit`. The suffix is ` · resets <time>` and may end
` · progress saved`. The time comes from one formatter: `1:40pm` within a
day, `Oct 29, 3pm` past one, a year added when it differs, and the CLI's
own IANA zone in brackets (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
In stream-json the CLI also emits a `rate_limit_event` whose
`rate_limit_info` holds `status`, `resetsAt` (unix seconds) and
`rateLimitType`.

**What changed:** the design's `You've hit your limit · resets 3pm` and
`resets Thu 3pm` were close but not the CLI's. `isLimitText` did not match
`5-hour limit`, because the hyphen broke its one-word pattern, so a run on
2.1.316 would have ended `failed`. The zone in brackets and the date form
were ignored, so a weekly reset fell back to an hour's hold. Both are
fixed, with the observed text as a fixture. A `-p` stream-json reply on a
spent window was still not captured, and canopy does not read
`rate_limit_event` yet.

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

**Observed, 2026-11-02:** metadata only, by `stat`, inside a canopy shell
on the mini: `/home/bun/.claude/.credentials.json` is owned by `bun:bun`,
mode 600, 524 bytes, last modified 2026-10-16 14:09 PDT. Claude sessions
ran from that mount daily since then. Whether that means a long-lived
token or a refresh written elsewhere was not checked; the file was not
read.

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
`You've hit your weekly limit · resets Thu 3pm`. Per the 2.1.316 binary
(see P1), a reset more than a day out is printed as a date instead, for
example `resets Oct 29, 3pm (UTC)`, and both forms are fixtures now. The word `weekly` selects
the weekly window in the pure parser. This remains an expected example
until a real CLI reply is recorded.

**Date:** 2026-10-26.

## What the code takes from this

- P1: the observed `session limit` text and the 2.1.316 `5-hour limit`
  wording are fixtures; the zone in brackets and the dated reset are read.
  Synthetic result and stderr fixtures still exercise the driver paths.
- P4: synthetic failed-turn text exercises the shared driver classifier;
  the installed usage methods are documented but unused.
- P5: the expected weekly wording selects a weekly hit.
- P2: `five_hour` and `seven_day`, utilization and reset timestamps are
  parsed without wiring an endpoint reader.
- `source: endpoint` remains held for Eric's call 8; the Help Center sentence
  quoted above does not itself settle the credential-reading question.
- With no configured dollar figure, ledger observation leaves utilization
  unknown. Actual hits still have a reset and expiry.

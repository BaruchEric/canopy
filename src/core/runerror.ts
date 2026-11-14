/**
 * A stage run's error said plainly, for a sprout's park. A run ends with
 * the harness's own words: an API status and its JSON body, a process's
 * exit code and the tail of its stderr (claudefold's result, codexfold's
 * turn, the driver's `exitOutcome`). The park's line gets the plain
 * sentence, and the words themselves go on the park's record as its
 * `detail`, which the project's sheet shows behind it. Pure and
 * browser-safe.
 */
import { isLimitText } from "./capacity";
import { redactLine } from "./redact";
import { withoutSecrets } from "./sprout";

/** the most of a raw error or a check's output a park keeps, from its end */
export const PARK_DETAIL_MAX = 2000;
/** an error canopy has no plainer form of stays on the park's line up to this */
export const PARK_LINE_MAX = 200;

/** The harness that wrote an exit line, as the driver labels it. */
const harnessOf = (error: string): string => /^(Claude Code|Codex) exited\b/.exec(error)?.[1] ?? "the harness";

/** Each error the harnesses are known to end a run with, the first match
 *  winning: an API's words come before the exit line that carries them. */
const PLAIN: [RegExp, (error: string) => string][] = [
  [/\bAPI Error:? *529\b|\boverloaded(?:_error)?\b/i, () => "Anthropic's API was overloaded"],
  [/\bAPI Error:? *429\b|\brate_limit_error\b|\brate[ -]limit(?:ed)?\b/i, () => "the model's API turned the request away for its rate limit"],
  [/\bAPI Error:? *5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/i, () => "the model's API had a server error"],
  [/prompt is too long|context (?:window|length)|maximum context|too many tokens/i, () => "the conversation outgrew the model's context window"],
  [/request timed out/i, () => "a request to the model's API timed out"],
  [/\bECONNRESET\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|socket hang up|fetch failed|connection error|network error/i, () => "the connection to the model's API failed"],
  [/exited \(code (?:null|137|143)\)|\bSIGKILL\b|\bSIGTERM\b|out of memory|\bOOM\b/i, (e) => `${harnessOf(e)} was killed before it finished`],
  [/exited \(code -?\d+\) without a result/i, (e) => `${harnessOf(e)} quit with exit code ${/exited \(code (-?\d+)\)/.exec(e)?.[1] ?? "?"} before it finished`],
  [/\btimed out\b|\bETIMEDOUT\b/i, () => "it timed out"],
];

/** The plain sentence for a run's error, or null when canopy knows no
 *  plainer one: words it wrote itself ("stopped after 40 turns without
 *  finishing"), a login refusal (`failHint` says its fix), anything new. */
export function plainRunError(error: string): string | null {
  // a limit hit twice in a row fails the step rather than waiting again
  if (isLimitText(error)) return "the plan's usage limit ran out";
  for (const [re, say] of PLAIN) if (re.test(error)) return say(error);
  return null;
}

/** A raw error or a check's output as a park keeps it: the end, where it
 *  says what failed, with a url's userinfo and canopy's own tokens taken
 *  out, as the retro's record does for a check's output. */
export function parkDetail(text: string, max = PARK_DETAIL_MAX): string {
  const clean = (withoutSecrets(text.trim()) as string)
    .split("\n")
    .map((l) => redactLine(l, []).line)
    .join("\n");
  return clean.length <= max ? clean : `…${clean.slice(clean.length - max + 1)}`;
}

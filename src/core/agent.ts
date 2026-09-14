/** Agent settings: how Claude Code starts for one repo. Browser-safe, so the
 *  form and the menu can read and describe them; the openers and the runner
 *  turn them into command-line flags. */

import {
  AGENT_EFFORTS,
  AGENT_MODELS,
  DEFAULT_AGENT,
  type AgentEffort,
  type AgentModel,
  type AgentSettings,
} from "./types";

const isModel = (v: unknown): v is AgentModel =>
  typeof v === "string" && (AGENT_MODELS as readonly string[]).includes(v);

const isEffort = (v: unknown): v is AgentEffort =>
  typeof v === "string" && (AGENT_EFFORTS as readonly string[]).includes(v);

/** Settings from a request body or a hand-edited config, field by field.
 *  Anything unknown falls back to the default for that field, so a value from
 *  an older build can never reach the claude command line as a flag. */
export function normalizeAgent(v: unknown): AgentSettings {
  if (!v || typeof v !== "object") return { ...DEFAULT_AGENT };
  const o = v as Record<string, unknown>;
  return {
    model: isModel(o["model"]) ? o["model"] : DEFAULT_AGENT.model,
    effort: isEffort(o["effort"]) ? o["effort"] : DEFAULT_AGENT.effort,
    yolo: typeof o["yolo"] === "boolean" ? o["yolo"] : DEFAULT_AGENT.yolo,
    extra: typeof o["extra"] === "string" ? o["extra"].trim() : "",
  };
}

export const isDefaultAgent = (a: AgentSettings): boolean =>
  a.model === DEFAULT_AGENT.model &&
  a.effort === DEFAULT_AGENT.effort &&
  a.yolo === DEFAULT_AGENT.yolo &&
  a.extra === DEFAULT_AGENT.extra;

/** The extra-flags box, split the way a shell would: on whitespace, with
 *  single or double quotes holding a word together. Quotes are removed; an
 *  unclosed quote runs to the end. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (inWord) out.push(word);
  return out;
}

/** The flags an interactive `claude` gets for these settings. `yolo` is the
 *  CLI's own flag for skipping every permission prompt. */
export function claudeArgs(a: AgentSettings): string[] {
  return [
    ...(a.model === "default" ? [] : ["--model", a.model]),
    ...(a.effort === "default" ? [] : ["--effort", a.effort]),
    ...(a.yolo ? ["--dangerously-skip-permissions"] : []),
    ...splitArgs(a.extra),
  ];
}

/** One short line for the menu and the panel: "opus · high · yolo". The
 *  permission word is always there, since it is the one worth a glance;
 *  model and effort only when set. */
export function describeAgent(a: AgentSettings): string {
  return [
    ...(a.model === "default" ? [] : [a.model]),
    ...(a.effort === "default" ? [] : [a.effort]),
    a.yolo ? "yolo" : "ask",
    ...(a.extra ? [a.extra] : []),
  ].join(" · ");
}

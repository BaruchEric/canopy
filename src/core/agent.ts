/** Agent settings: which harness starts for a repo, and how. Browser-safe,
 *  so the form and the menu can read and describe them; the openers and the
 *  runner turn them into command-line flags through core/harness. */

import { HARNESS, splitArgs, takesEffort, takesModel } from "./harness";
import { DEFAULT_AGENT, isHarness, type AgentSettings } from "./types";

export { splitArgs };

/** Settings from a request body or a hand-edited config, field by field and
 *  per harness. A missing harness is claude (an entry saved before
 *  harnesses); a model or an effort the harness does not take falls back to
 *  its default, so a value from an older build or another harness can never
 *  reach a command line as a flag. */
export function normalizeAgent(v: unknown): AgentSettings {
  if (!v || typeof v !== "object") return { ...DEFAULT_AGENT };
  const o = v as Record<string, unknown>;
  const harness = isHarness(o["harness"]) ? o["harness"] : DEFAULT_AGENT.harness;
  return {
    harness,
    model: takesModel(harness, o["model"]) ? o["model"] : "default",
    effort: takesEffort(harness, o["effort"]) ? o["effort"] : "default",
    yolo: typeof o["yolo"] === "boolean" ? o["yolo"] : DEFAULT_AGENT.yolo,
    extra: typeof o["extra"] === "string" ? o["extra"].trim() : "",
  };
}

/** Settings carried over to another harness: what the new one takes stays,
 *  the rest goes back to its default. The form's harness picker uses it. */
export const withHarness = (a: AgentSettings, harness: AgentSettings["harness"]): AgentSettings =>
  normalizeAgent({ ...a, harness });

export const sameAgent = (a: AgentSettings, b: AgentSettings): boolean =>
  a.harness === b.harness && a.model === b.model && a.effort === b.effort && a.yolo === b.yolo && a.extra === b.extra;

export const isDefaultAgent = (a: AgentSettings): boolean => sameAgent(a, DEFAULT_AGENT);

/** One short line for the menu and the panel: "opus · high · yolo", or
 *  "codex · gpt-5.5 · ask" for codex. The permission word is always there,
 *  since it is the one worth a glance; model and effort only when set, and
 *  the harness only when it is not the default one and `harness` is not
 *  turned off by a caller that shows it on its own. */
export function describeAgent(a: AgentSettings, harness = true): string {
  return [
    ...(!harness || a.harness === DEFAULT_AGENT.harness ? [] : [HARNESS[a.harness].label]),
    ...(a.model === "default" ? [] : [a.model]),
    ...(a.effort === "default" ? [] : [a.effort]),
    a.yolo ? "yolo" : "ask",
    ...(a.extra ? [a.extra] : []),
  ].join(" · ");
}

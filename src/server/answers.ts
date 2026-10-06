import type { RunAnswer } from "../core/types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The browser's reply to a run prompt, checked field by field: a malformed
 *  body must not reach the SDK as an "allow". */
export function parseAnswer(v: unknown): RunAnswer | null {
  if (!isRecord(v)) return null;
  const kind = v["kind"];
  if (kind === "allow") {
    const r = v["remember"];
    if (r === undefined) return { kind };
    if (!isRecord(r)) return null;
    const rule = r["rule"];
    const scope = r["scope"];
    if (typeof rule !== "string" || !rule.trim() || rule.length > 2_000) return null;
    if (scope !== "step" && scope !== "workflow" && scope !== "repo") return null;
    return { kind, remember: { rule: rule.trim(), scope } };
  }
  if (kind === "approve") {
    const auto = v["auto"];
    return typeof auto === "boolean" ? { kind, auto } : null;
  }
  if (kind === "deny") {
    const m = v["message"];
    if (m === undefined) return { kind };
    if (typeof m !== "string" || m.length > 20_000) return null;
    return m.trim() ? { kind, message: m.trim() } : { kind };
  }
  if (kind === "allow-all") return { kind };
  if (kind !== "answers") return null;
  const raw = v["answers"];
  if (!isRecord(raw)) return null;
  const answers: Record<string, string> = {};
  for (const [q, a] of Object.entries(raw)) {
    if (typeof a !== "string") return null;
    answers[q] = a;
  }
  return { kind: "answers", answers };
}

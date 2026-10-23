/** What a Linear trigger writes back, through Linear's GraphQL API: the PR's
 *  link as a comment once it opens, and the issue moved to its team's done
 *  state once it merges. The token is the rule's `tokenEnv`, a
 *  `CANOPY_TRIGGER_` variable no run or shell inherits. */

import type { TriggerEvent, TriggerRule } from "../core/trigger";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A personal API key goes in the header bare; an OAuth token as Bearer. */
export const linearAuth = (token: string): string => (token.startsWith("lin_api_") ? token : `Bearer ${token}`);

/** One GraphQL call. Linear answers a refused mutation with a 200 and an
 *  `errors` list, so both a bad status and any error throw. */
export async function linearCall(rule: TriggerRule, token: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${rule.api}/graphql`, {
    method: "POST",
    headers: { authorization: linearAuth(token), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const v: unknown = await res.json().catch(() => null);
  const errors = isRecord(v) && Array.isArray(v["errors"]) ? v["errors"] : [];
  if (!res.ok || errors.length) {
    const first = errors.find(isRecord);
    const why = first && typeof first["message"] === "string" ? `: ${first["message"]}` : "";
    throw new Error(`Linear answered ${res.status}${why}`);
  }
  return isRecord(v) && isRecord(v["data"]) ? v["data"] : {};
}

const ok = (data: Record<string, unknown>, field: string): boolean => {
  const r = data[field];
  return isRecord(r) && r["success"] === true;
};

const COMMENT = "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }";

/** Comments the PR's link on the issue. */
export async function linearComment(rule: TriggerRule, event: TriggerEvent, token: string): Promise<void> {
  if (!event.pr) return;
  const body = `canopy opened [pull request #${event.pr.number}](${event.pr.url}) for this issue.`;
  if (!ok(await linearCall(rule, token, COMMENT, { issueId: event.key, body }), "commentCreate")) throw new Error("Linear did not take the comment");
}

const DONE_STATES =
  'query($id: String!) { issue(id: $id) { state { type } team { states(filter: { type: { eq: "completed" } }) { nodes { id name position } } } } }';
const MOVE = "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }";

/** The team's first done state, by its place on the board: the one Linear's
 *  own git automation would pick. */
export function firstDone(nodes: unknown): { id: string; name: string } | null {
  const list = Array.isArray(nodes) ? nodes.filter(isRecord) : [];
  const states = list
    .filter((n) => typeof n["id"] === "string")
    .map((n) => ({ id: n["id"] as string, name: typeof n["name"] === "string" ? n["name"] : "done", position: typeof n["position"] === "number" ? n["position"] : 0 }))
    .sort((a, b) => a.position - b.position);
  const first = states[0];
  return first ? { id: first.id, name: first.name } : null;
}

/** Moves the issue to its team's first done state, unless it is done already. */
export async function linearDone(rule: TriggerRule, event: TriggerEvent, token: string): Promise<void> {
  const data = await linearCall(rule, token, DONE_STATES, { id: event.key });
  const issue = isRecord(data["issue"]) ? data["issue"] : null;
  if (!issue) throw new Error("Linear has no such issue, or the key cannot see it");
  if (isRecord(issue["state"]) && issue["state"]["type"] === "completed") return;
  const team = isRecord(issue["team"]) ? issue["team"] : {};
  const done = firstDone(isRecord(team["states"]) ? team["states"]["nodes"] : undefined);
  if (!done) throw new Error("the issue's team has no done state");
  if (!ok(await linearCall(rule, token, MOVE, { id: event.key, stateId: done.id }), "issueUpdate")) throw new Error(`Linear did not move the issue to ${done.name}`);
}

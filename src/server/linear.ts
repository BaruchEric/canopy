/** What a Linear trigger writes back, through Linear's GraphQL API: the PR's
 *  link as a comment once it opens, and the issue moved to its team's done
 *  state once it merges. The token is the rule's `tokenEnv`, a
 *  `CANOPY_TRIGGER_` variable no run or shell inherits, or the app's own
 *  token, minted from its client secret when the agent is on. The agent
 *  half posts activities to a session and adds links to it. */

import type { AgentActivity, TriggerEvent, TriggerRule } from "../core/trigger";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A personal API key goes in the header bare; an OAuth token as Bearer. */
export const linearAuth = (token: string): string => (token.startsWith("lin_api_") ? token : `Bearer ${token}`);

/** A refused call, with the HTTP status, so a 401 can mint a new app token. */
export class LinearError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

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
    throw new LinearError(`Linear answered ${res.status}${why}`, res.status);
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

/* ---------- the agent ---------- */

/** what the app's token may do: read and write, and be delegated issues and mentioned */
export const APP_SCOPES = "read,write,app:assignable,app:mentionable";
/** a token is used until this long before Linear says it expires */
const MARGIN = 60 * 60 * 1000;

interface Minted {
  token: string;
  until: number;
}

/** App tokens, by client id: minted with the client credentials grant and
 *  held in memory only, as Linear advises, so a restart mints a new one. */
const minted = new Map<string, Minted>();

/** The app's token: the one held while it has an hour left, else a new one. */
export async function linearAppToken(rule: TriggerRule, secret: string, now = Date.now()): Promise<string> {
  const id = rule.clientId;
  if (!id) throw new Error(`${rule.name} has no Linear app`);
  const held = minted.get(id);
  if (held && held.until > now) return held.token;
  const res = await fetch(`${rule.api}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, scope: APP_SCOPES }),
    signal: AbortSignal.timeout(15_000),
  });
  const v: unknown = await res.json().catch(() => null);
  const token = isRecord(v) && typeof v["access_token"] === "string" ? v["access_token"] : "";
  if (!res.ok || !token) {
    const why = isRecord(v) && typeof v["error_description"] === "string" ? `: ${v["error_description"]}` : isRecord(v) && typeof v["error"] === "string" ? `: ${v["error"]}` : "";
    throw new LinearError(`Linear would not mint the app's token (${res.status}${why})`, res.status);
  }
  const life = isRecord(v) && typeof v["expires_in"] === "number" ? v["expires_in"] * 1000 : 24 * 60 * 60 * 1000;
  minted.set(id, { token, until: now + Math.max(life - MARGIN, 60_000) });
  return token;
}

/** Forgets the app's token, after Linear refused it. */
export const forgetAppToken = (rule: TriggerRule): void => {
  if (rule.clientId) minted.delete(rule.clientId);
};

const ACTIVITY = "mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }";

/** Posts one activity to an agent session. */
export async function linearActivity(rule: TriggerRule, token: string, session: string, activity: AgentActivity): Promise<void> {
  const input = { agentSessionId: session, content: activity };
  if (!ok(await linearCall(rule, token, ACTIVITY, { input }), "agentActivityCreate")) throw new Error("Linear did not take the activity");
}

const SESSION_LINKS = "mutation($id: String!, $data: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $data) { success } }";

/** Adds links to an agent session: canopy's page for the run, the PR. */
export async function linearSessionLinks(rule: TriggerRule, token: string, session: string, links: { label: string; url: string }[]): Promise<void> {
  if (!links.length) return;
  if (!ok(await linearCall(rule, token, SESSION_LINKS, { id: session, data: { addedExternalUrls: links } }), "agentSessionUpdate")) throw new Error("Linear did not take the links");
}

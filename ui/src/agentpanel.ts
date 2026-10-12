/**
 * An agent as a dock panel of its own: the board's "your own arrangement",
 * where an agent drags, splits, tabs and sizes like any panel. Its id is
 * `/agent/` and the card's id; a leading slash never names a repo, so it
 * never reads as one. Pure; tested in agentpanel.test.ts.
 */

const PREFIX = "/agent/";

export const agentPanel = (cardId: string): string => PREFIX + cardId;

export const isAgentPanel = (id: string): boolean => id.startsWith(PREFIX) && id.length > PREFIX.length;

/** the card a panel shows, or null for any other panel */
export const cardOfPanel = (id: string): string | null => (isAgentPanel(id) ? id.slice(PREFIX.length) : null);

/** its mark on its head and its tab, the registry chip's */
export const AGENT_GLYPH = "✦";

/**
 * tailchan in the browser, the pure parts: what a conversation is called,
 * the order conversations go in, the capped message list per conversation,
 * what counts as unread, and the one line a message is in the feed.
 */
import { dmPeer } from "../../src/core/tailchan";
import type { ChanChannel, ChanMessage } from "../../src/core/types";

/** messages kept per conversation, the popover's page and then some */
export const CHAN_CAP = 200;

/** the target a conversation is written to: "@peer" for a DM, "#name" else */
export function convTarget(channel: string, me: string): string {
  const peer = dmPeer(channel, me);
  return peer ? `@${peer}` : `#${channel}`;
}

/** what a conversation reads as in the list: the other handle for a DM */
export const convName = convTarget;

/** a conversation's id for a target: `dm.a+b` for "@h", the name for "#name" */
export function convOf(target: string, me: string): string {
  const t = target.trim().toLowerCase();
  if (t.startsWith("@")) return `dm.${[me, t.slice(1)].sort().join("+")}`;
  return t.replace(/^#/, "");
}

/**
 * The conversations to list: every channel the handle is in (a DM, a
 * subscription, or one it has heard from live), newest activity first,
 * a conversation with nothing in it last.
 */
export function convOrder(channels: ChanChannel[], live: Record<string, ChanMessage[]>): string[] {
  const last = new Map<string, number>();
  for (const c of channels) {
    if (c.subscribed || c.private) last.set(c.name, c.last_ts ?? 0);
  }
  for (const [name, msgs] of Object.entries(live)) {
    const ts = msgs.at(-1)?.ts ?? 0;
    if ((last.get(name) ?? -1) < ts) last.set(name, ts);
  }
  return [...last.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

/** a conversation's messages with `add` merged in by id, in id order, capped */
export function mergeMessages(list: ChanMessage[] | undefined, add: ChanMessage[]): ChanMessage[] {
  const byId = new Map<number, ChanMessage>();
  for (const m of list ?? []) byId.set(m.id, m);
  for (const m of add) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-CHAN_CAP);
}

/** whether a message counts toward the chip: someone else's, not silent */
export const isUnread = (m: ChanMessage, me: string): boolean => m.handle !== me && m.meta["silent"] !== true;

/** a message's one line in the list or the feed: an object is its file */
export function messageText(m: ChanMessage): string {
  if (m.kind === "object") {
    const name = typeof m.meta["name"] === "string" ? m.meta["name"] : "a file";
    return m.body ? `${name}: ${m.body}` : name;
  }
  if (m.kind === "clip") return `clipboard, ${m.body.length} chars`;
  return m.body;
}

/** the feed's words for a message: who, where, and the text cut to a line */
export function chanLine(m: ChanMessage, me: string): string {
  const where = convTarget(m.channel, me);
  const who = m.handle === me ? "you" : `${m.handle}@${m.node}`;
  const text = messageText(m).replace(/\s+/g, " ");
  return `${who} → ${where}: ${text.length > 160 ? `${text.slice(0, 159)}…` : text}`;
}

/** the newest clipboard message across everything held, text or file */
export function latestClip(live: Record<string, ChanMessage[]>): ChanMessage | null {
  let best: ChanMessage | null = null;
  for (const msgs of Object.values(live)) {
    for (const m of msgs) {
      const isClip = m.kind === "clip" || (m.kind === "object" && m.body === "clipboard file");
      if (isClip && (!best || m.id > best.id)) best = m;
    }
  }
  return best;
}

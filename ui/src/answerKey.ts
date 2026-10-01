/* This browser's answer key: one device's named secret out of the tailchan
   broker's ANSWER_TOKENS (`name:secret`, one pair per device, so the broker
   says which device answered and one can be revoked alone). The page keeps
   it and sends it to its home backend on the four writes that need it
   (answering an ask, setting and beating presence, editing the guards), and
   canopy forwards it without keeping it: a secret held by the server would
   be open to every agent on its machine (server/asks.ts says how). Kept in
   localStorage under its own key, apart from `canopy.settings`, and read
   and written through try/catch, since storage can be blocked. Pure but
   for the storage calls, which take the storage as an argument; tested. */

export const ANSWER_KEY_STORE = "canopy.answerKey";

/** the header the key rides in, to the home backend alone */
export const ANSWER_KEY_HEADER = "X-Canopy-Answer-Key";

/** A key as the broker takes it: one word, trimmed; null for anything else
 *  (empty, or with spaces, which a paste of the whole `name:secret` line's
 *  neighbours would bring). */
export function cleanKey(raw: string | null | undefined): string | null {
  const k = (raw ?? "").trim();
  return /^\S{1,512}$/.test(k) ? k : null;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const local = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** the key this browser holds, or null */
export function readAnswerKey(store: Store | null = local()): string | null {
  try {
    return cleanKey(store?.getItem(ANSWER_KEY_STORE));
  } catch {
    return null;
  }
}

/** Keeps the key (null forgets it); false when storage refused, so the key
 *  holds for this page only. */
export function writeAnswerKey(key: string | null, store: Store | null = local()): boolean {
  try {
    if (!store) return false;
    if (key === null) store.removeItem(ANSWER_KEY_STORE);
    else store.setItem(ANSWER_KEY_STORE, key);
    return true;
  } catch {
    return false;
  }
}

/** the headers a keyed write carries: the JSON body's type, and the key */
export const keyHeaders = (key: string): Record<string, string> => ({ "Content-Type": "application/json", [ANSWER_KEY_HEADER]: key });

/** The key as Settings shows it once saved: dots, and its last characters
 *  when it is long enough that they give nothing away. */
export function maskKey(key: string): string {
  return key.length >= 16 ? `••••••••${key.slice(-4)}` : "••••••••";
}

/** What a key's test says: ok, refused by the broker, or it could not tell
 *  (the broker or the backend did not answer). */
export type KeyTest = { ok: true } | { ok: false; refused: boolean; why: string };

/** A test's outcome from the error a presence beat threw, or null for none. */
export function keyTestOf(err: unknown): KeyTest {
  if (err === null || err === undefined) return { ok: true };
  const status = (err as { status?: unknown }).status;
  const why = err instanceof Error ? err.message : String(err);
  return { ok: false, refused: status === 403 || status === 401, why };
}

import { useStore } from "./store";

/** What an item the keyboard ring walks spreads on its element (FR-023,
 *  kbfocus.ts): its key, which is how components/KbFocus.tsx reads the
 *  list off the page, and `data-kb-on` while the ring is on it, which the
 *  stylesheet draws. */
export function useKb(key: string): { "data-kb": string; "data-kb-on"?: "" } {
  const on = useStore((s) => s.kbRing && s.kbFocus === key);
  return on ? { "data-kb": key, "data-kb-on": "" } : { "data-kb": key };
}

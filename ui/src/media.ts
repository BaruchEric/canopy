import { useEffect, useState } from "react";

/** The widths the layout turns at, the same numbers styles.css uses: a phone
 *  gets its own top bar, and below `NARROW` the tree leaves the page for a
 *  drawer. */
export const PHONE = "(max-width: 760px)";
export const NARROW = "(max-width: 1100px)";

/** Whether a media query matches, following it as the window changes. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const change = () => setOn(mq.matches);
    change();
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, [query]);
  return on;
}

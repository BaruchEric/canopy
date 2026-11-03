import { useEffect, useState, useSyncExternalStore } from "react";
import { SAID_MS, onSaid, saidNow } from "../said";

const none = () => null;

/** The page's quiet line (said.ts): the latest word at the foot of the
 *  window for `SAID_MS`, then gone. Mounted once, by App. */
export function Said() {
  const said = useSyncExternalStore(onSaid, saidNow, none);
  // the id of the word showing; a newer word restarts the clock
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (!said) return;
    setShown(said.id);
    const t = setTimeout(() => setShown((id) => (id === said.id ? null : id)), SAID_MS);
    return () => clearTimeout(t);
  }, [said]);
  if (!said || shown !== said.id) return null;
  return (
    <p className={said.bad ? "said bad" : "said"} role="status">
      {said.text}
    </p>
  );
}

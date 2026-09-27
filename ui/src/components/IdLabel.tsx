import { connOf, idLabel, idParts, useStore } from "../store";
import { homeName } from "../registry";
import { Crowns } from "./TopBar";

/** A repo's id as its own backend knows it, then that backend's name when it
 *  is not the page's own. */
export function IdLabel({ id }: { id: string }) {
  const { plain, backend } = idLabel(id);
  return (
    <>
      {plain}
      {backend && <span className="backend-word">{backend}</span>}
    </>
  );
}

/** The machine a window's repo is on while that machine has not answered
 *  yet, else null: a repo not found there is not missing until it has. */
export function useWaitingFor(id: string, found: boolean): string | null {
  const b = idParts(id)[0];
  const connecting = useStore((s) => connOf(s, b).status.state === "connecting");
  return !found && b !== homeName() && connecting ? b : null;
}

/** What a window shows while its repo's machine is still answering. */
export function WaitingFor({ name }: { name: string }) {
  return (
    <div className="loading" role="status">
      <Crowns size={40} live />
      waiting for {name}…
    </div>
  );
}

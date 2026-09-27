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

/** The small word after a name a list already shows, when its id is not
 *  home's: for a row that has its own way of falling back when the id is
 *  unknown (`idText`, which already says "on b") and only needs the word
 *  added once it knows the name. */
export function BackendWord({ id }: { id: string }) {
  const { backend } = idLabel(id);
  return backend ? <span className="backend-word">{backend}</span> : null;
}

/** The machine a window's repo is on while that machine has not answered
 *  yet, else null: a repo not found there is not missing until it has. */
export function useWaitingFor(id: string, found: boolean): string | null {
  const b = idParts(id)[0];
  // a hidden backend has no connection at all, so it is not waited on
  const connecting = useStore((s) => s.backendOrder.includes(b) && connOf(s, b).status.state === "connecting");
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

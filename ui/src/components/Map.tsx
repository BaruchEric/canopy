import { useState } from "react";
import { loadMapKind, saveMapKind, type MapKind } from "../mapkind";
import { ArchifyMap } from "./Archify";
import { FloorplanMap } from "./Floorplan";
import type { Repo } from "../../../src/core/types";

const KINDS: { kind: MapKind; word: string; title: string }[] = [
  { kind: "floorplan", word: "floorplan", title: "Floorplan: a plain-English map of the code's parts, files and endpoints, with its own Ask bar" },
  { kind: "archify", word: "archify", title: "Archify: checked, interactive diagrams of the code (architecture, sequence, data flow and more) and one-page explainers" },
];

/** The switch at the top of the map section: which of the two it shows. */
function MapKinds({ kind, setKind }: { kind: MapKind; setKind: (k: MapKind) => void }) {
  return (
    <div className="seg map-kinds" role="radiogroup" aria-label="What the map shows">
      {KINDS.map((k) => (
        <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} title={k.title} onClick={() => setKind(k.kind)}>
          {k.word}
        </button>
      ))}
    </div>
  );
}

/**
 * The repo panel's map section: Floorplan's map of the checkout (FR-070)
 * or Archify's diagrams of it (FR-071), each its own component so neither
 * holds the other's hooks. The choice is kept per repo in this browser.
 * Folded by default.
 */
export function MapSection({ repo }: { repo: Repo }) {
  const [kind, setKindState] = useState<MapKind>(() => loadMapKind(repo.id));
  const setKind = (k: MapKind) => {
    setKindState(k);
    saveMapKind(repo.id, k);
  };
  const kinds = <MapKinds kind={kind} setKind={setKind} />;
  return kind === "archify" ? <ArchifyMap repo={repo} kinds={kinds} /> : <FloorplanMap repo={repo} kinds={kinds} />;
}

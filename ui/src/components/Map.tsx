import { useState } from "react";
import { loadMapKind, saveMapKind, type MapKind } from "../mapkind";
import { ArchifyMap } from "./Archify";
import { DiagnosisMap } from "./Diagnosis";
import { FloorplanMap } from "./Floorplan";
import { UnderstandMap } from "./Understand";
import type { Repo } from "../../../src/core/types";

const KINDS: { kind: MapKind; word: string; title: string }[] = [
  { kind: "floorplan", word: "floorplan", title: "Floorplan: a plain-English map of the code's parts, files and endpoints, with its own Ask bar" },
  { kind: "archify", word: "archify", title: "Archify: checked, interactive diagrams of the code (architecture, sequence, data flow and more) and one-page explainers" },
  { kind: "understand", word: "understand", title: "Understand-Anything: a knowledge graph of the code's files, functions, classes and layers, with a guided tour and a summary on every node" },
  { kind: "diagnosis", word: "diagnosis", title: "Architecture Diagnosis: import cycles, module cycles, hubs and complex functions found by reading the code, beside an atlas of every file, dependency and function. No model runs" },
];

/** The switch at the top of the map section: which of the four it shows. */
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
 * The repo panel's map section: Floorplan's map of the checkout (FR-070),
 * Archify's diagrams of it (FR-071), Understand-Anything's knowledge graph
 * of it (FR-072) or its Architecture Diagnosis (FR-075), each its own
 * component so none holds another's hooks. The choice is kept per repo in this browser. Folded by default.
 */
export function MapSection({ repo }: { repo: Repo }) {
  const [kind, setKindState] = useState<MapKind>(() => loadMapKind(repo.id));
  const setKind = (k: MapKind) => {
    setKindState(k);
    saveMapKind(repo.id, k);
  };
  const kinds = <MapKinds kind={kind} setKind={setKind} />;
  switch (kind) {
    case "archify":
      return <ArchifyMap repo={repo} kinds={kinds} />;
    case "understand":
      return <UnderstandMap repo={repo} kinds={kinds} />;
    case "diagnosis":
      return <DiagnosisMap repo={repo} kinds={kinds} />;
    case "floorplan":
      return <FloorplanMap repo={repo} kinds={kinds} />;
  }
}

export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <p className="diff-empty">No textual changes.</p>;
  const lines = diff.split("\n");
  return (
    <pre className="diff">
      {lines.map((line, i) => {
        let cls = "ctx";
        if (line.startsWith("+++") || line.startsWith("---")) cls = "meta";
        else if (line.startsWith("@@")) cls = "hunk";
        else if (line.startsWith("+")) cls = "add";
        else if (line.startsWith("-")) cls = "del";
        else if (line.startsWith("diff ") || line.startsWith("index "))
          cls = "meta";
        return (
          <span key={i} className={`dl ${cls}`}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

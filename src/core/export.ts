import { redactLine } from "./redact";
import type { Secret } from "./redact";
import type { Run, RunStep } from "./types";

/** The first lines of a tool's output the export keeps. */
export const EXPORT_OUTPUT = 40;

export interface ExportInfo {
  /** The repo's name, else its id. */
  repoName: string;
  /** Where a branch run's work went, in words. */
  where?: string;
  /** The current time for an unfinished run, in unix ms. */
  now?: number;
}

/**
 * Make a Markdown excerpt for a FEATURES.md source line or a bug report from
 * run.json's settled steps. This reads the kept run, not the wire; plan 2
 * folds the wire into the run. Prompts appear as their settle notes.
 */
export function exportRun(run: Run, secrets: readonly Secret[], info: ExportInfo): string {
  const endedAt = run.endedAt ?? info.now ?? Date.now();
  const endLabel = run.endedAt === undefined ? "now" : new Date(run.endedAt).toISOString();
  const elapsedSeconds = Math.max(0, Math.floor((endedAt - run.startedAt) / 1_000));
  const duration = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  const model = run.result?.model ?? "unknown";
  const cost = run.result?.costUsd !== undefined
    ? `$${run.result.costUsd.toFixed(2)}`
    : run.result?.tokens
      ? `${new Intl.NumberFormat("en-US").format(run.result.tokens.total)} tokens`
      : "unknown";

  const header = [
    `# ${run.verb} in ${info.repoName}`,
    "",
    `- run: ${run.id}`,
    `- action: ${run.action}`,
    `- agent: ${run.harness === "claude" ? "Claude Code" : "Codex"}, model ${model}`,
    `- when: ${new Date(run.startedAt).toISOString()} to ${endLabel}, ${duration}`,
    `- cost: ${cost}`,
    ...(run.note !== "" ? [`- note: ${run.note}`] : []),
    ...(run.branch
      ? [`- branch: ${run.branch.name} onto ${run.branch.target}, ${info.where ?? run.branch.state}`]
      : []),
  ];
  const timeline = run.steps.map(renderStep).filter((step) => step !== "").join("\n\n");
  const result = run.result?.text ?? `No result: the run ${run.status}.`;
  const document = `${header.join("\n")}\n\n## Timeline${timeline ? `\n\n${timeline}` : ""}\n\n## Result\n\n${result}`;

  const redacted = redactLine(document, secrets);
  const footer = redacted.count === 0
    ? "nothing redacted"
    : redacted.count === 1
      ? "1 value redacted"
      : `${redacted.count} values redacted`;
  return `${redacted.line}\n\n---\n${footer}\n`;
}

function renderStep(step: RunStep): string {
  let rendered: string;
  switch (step.kind) {
    case "text":
      rendered = step.text ?? "";
      break;
    case "note":
      rendered = step.text ? step.text.split("\n").map((line) => `> ${line}`).join("\n") : "";
      break;
    case "user":
      rendered = step.text ? `**you:** ${step.text}` : "";
      break;
    case "tool":
      rendered = step.tool ? renderTool(step.tool) : "";
      break;
  }

  if (step.parent && rendered !== "") {
    return rendered.split("\n").map((line) => `  ${line}`).join("\n");
  }
  return rendered;
}

function renderTool(tool: NonNullable<RunStep["tool"]>): string {
  const lines = [
    "<details>",
    `<summary>${tool.name}: ${tool.title} (${tool.status})</summary>`,
  ];
  if (tool.output !== undefined && tool.output !== "") {
    const outputLines = tool.output.replace(/\r\n/g, "\n").split("\n");
    if (outputLines.at(-1) === "" && tool.output.endsWith("\n")) outputLines.pop();
    const shownLines = outputLines.slice(0, EXPORT_OUTPUT);
    lines.push("", "```", ...shownLines, "```");
    const more = outputLines.length - shownLines.length;
    if (more > 0) lines.push("", `… ${more} more lines`);
  }
  lines.push("", "</details>");
  return lines.join("\n");
}

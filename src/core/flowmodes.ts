/** `.canopy/workflows.json` stores workflow and step modes. This pure parser
 *  is read from the repo's HEAD by `readFlowModes` in `workflows.ts`. */

import { STEP_MODES, type StepMode, type Workflow, type WorkflowStep } from "./types";

export const FLOW_MODES_FILE = ".canopy/workflows.json";

/** `modes[workflow][step]`; the workflow `"*"` applies to any workflow. */
export type FlowModes = Record<string, Record<string, StepMode>>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** The file's text as modes, or why it cannot be; a missing `modes` is empty. */
export function parseFlowModes(text: string): FlowModes | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { error: `${FLOW_MODES_FILE} is not JSON: ${String(error instanceof Error ? error.message : error)}` };
  }
  if (!isRecord(value)) return { error: `${FLOW_MODES_FILE} must be an object` };
  const rawModes = value["modes"];
  if (rawModes === undefined) return {};
  if (!isRecord(rawModes)) return { error: `${FLOW_MODES_FILE}: modes must be an object of workflow names` };

  const workflowEntries: Array<[string, Record<string, StepMode>]> = [];
  for (const [workflow, rawSteps] of Object.entries(rawModes)) {
    if (!isRecord(rawSteps)) return { error: `${FLOW_MODES_FILE}: modes.${workflow} must be an object of step names` };
    const stepEntries: Array<[string, StepMode]> = [];
    for (const [step, rawMode] of Object.entries(rawSteps)) {
      const mode = typeof rawMode === "string" ? STEP_MODES.find((candidate) => candidate === rawMode) : undefined;
      if (mode === undefined) {
        return { error: `${FLOW_MODES_FILE}: modes.${workflow}.${step} must be auto or manual, not ${String(rawMode)}` };
      }
      stepEntries.push([step, mode]);
    }
    workflowEntries.push([workflow, Object.fromEntries(stepEntries)]);
  }
  return Object.fromEntries(workflowEntries);
}

/** Apply a repo's say over the workflow without changing the input. */
export function applyModes(wf: Workflow, modes: FlowModes): { workflow: Workflow; warnings: string[] } {
  const specific = hasOwn(modes, wf.name) ? modes[wf.name] ?? {} : {};
  const wildcard = hasOwn(modes, "*") ? modes["*"] ?? {} : {};
  const stepNames = new Set(wf.steps.map((step) => step.name));
  const warnings = Object.keys(specific)
    .filter((name) => !stepNames.has(name))
    .map((name) => `${FLOW_MODES_FILE}: modes.${wf.name}.${name} names no step of ${wf.name}`);
  const steps: WorkflowStep[] = wf.steps.map((step): WorkflowStep => {
    const specificMode = hasOwn(specific, step.name) ? specific[step.name] : undefined;
    const wildcardMode = hasOwn(wildcard, step.name) ? wildcard[step.name] : undefined;
    const mode = specificMode ?? wildcardMode;
    return mode === undefined ? step : { ...step, mode, modeFrom: "repo" };
  });
  return { workflow: { ...wf, steps }, warnings };
}

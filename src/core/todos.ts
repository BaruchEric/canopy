/** The agent's own checklist, read off its todo tools (spec P4): Claude
 *  Code's TaskCreate/TaskUpdate, and the TodoWrite of older versions.
 *  Pure and browser-safe. */
import type { RunTodo } from "./types";

export const TODO_TOOLS: ReadonlySet<string> = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TodoWrite"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStatus = (v: unknown): v is RunTodo["status"] => v === "pending" || v === "in_progress" || v === "completed";
const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? o[k] : "");

export function todoCreated(todos: readonly RunTodo[], input: Record<string, unknown>, resultText: string): RunTodo[] {
  const id = /Task #(\d+) created/.exec(resultText)?.[1];
  const subject = str(input, "subject").trim();
  if (!id || !subject || todos.some((t) => t.id === id)) return [...todos];
  const active = str(input, "activeForm").trim();
  return [...todos, { id, subject, status: "pending", ...(active ? { active } : {}) }];
}

export function todoUpdated(todos: readonly RunTodo[], input: Record<string, unknown>): RunTodo[] {
  const id = str(input, "taskId") || (typeof input["taskId"] === "number" ? String(input["taskId"]) : "");
  if (!todos.some((t) => t.id === id)) return [...todos];
  if (input["status"] === "deleted") return todos.filter((t) => t.id !== id);
  const status = input["status"];
  const subject = str(input, "subject").trim();
  return todos.map((t) => (t.id !== id ? t : { ...t, ...(isStatus(status) ? { status } : {}), ...(subject ? { subject } : {}) }));
}

export function todoWritten(input: Record<string, unknown>): RunTodo[] | null {
  const raw = input["todos"];
  if (!Array.isArray(raw)) return null;
  const out: RunTodo[] = [];
  raw.forEach((t: unknown, i) => {
    if (!isRecord(t)) return;
    const subject = str(t, "content").trim();
    if (!subject) return;
    const active = str(t, "activeForm").trim();
    const status = t["status"];
    out.push({ id: String(i + 1), subject, status: isStatus(status) ? status : "pending", ...(active ? { active } : {}) });
  });
  return out;
}

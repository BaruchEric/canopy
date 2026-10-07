import { describe, expect, test } from "bun:test";
import { todoCreated, todoUpdated, todoWritten } from "./todos";

describe("the agent's checklist", () => {
  test("a create takes its id from the result text", () => {
    const t = todoCreated([], { subject: "Edit math.ts", activeForm: "Editing math.ts" }, "Task #4 created successfully: Edit math.ts");
    expect(t).toEqual([{ id: "4", subject: "Edit math.ts", status: "pending", active: "Editing math.ts" }]);
  });
  test("a result without an id adds nothing", () => {
    expect(todoCreated([], { subject: "x" }, "something else")).toEqual([]);
  });
  test("an update moves the status; deleted drops it; an unknown id is ignored", () => {
    const one = [{ id: "1", subject: "a", status: "pending" as const }];
    expect(todoUpdated(one, { taskId: "1", status: "in_progress" })[0]?.status).toBe("in_progress");
    expect(todoUpdated(one, { taskId: "1", status: "deleted" })).toEqual([]);
    expect(todoUpdated(one, { taskId: "9", status: "completed" })).toEqual(one);
    expect(todoUpdated(one, { taskId: "1", status: "bogus" })).toEqual(one);
  });
  test("TodoWrite replaces the list, ids by position", () => {
    expect(todoWritten({ todos: [{ content: "a", status: "completed", activeForm: "Aing" }, { content: "b", status: "pending" }] })).toEqual([
      { id: "1", subject: "a", status: "completed", active: "Aing" },
      { id: "2", subject: "b", status: "pending" },
    ]);
    expect(todoWritten({ todos: "nope" })).toBeNull();
  });
});

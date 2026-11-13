/**
 * The equip sheet as drawn from the store: the loadouts offered, a server
 * this backend refuses disabled, and a Codex loadout greying the skills.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoordTask, Loadout, Run } from "../../../src/core/types";
import { registry, setRegistry } from "../registry";
import { useStore } from "../store";
import { EquipSheet } from "./EquipSheet";

const pristine = useStore.getState();
const pristineRegistry = registry();
afterEach(() => {
  useStore.setState({ kit: pristine.kit });
  setRegistry(pristineRegistry.home, [...pristineRegistry.names]);
});

function renderCurrent(node: ReactNode): string {
  const initial = useStore.getInitialState();
  const before = { ...initial };
  Object.assign(initial, useStore.getState());
  try {
    return renderToStaticMarkup(node);
  } finally {
    Object.assign(initial, before);
  }
}

const L = (over: Partial<Loadout>): Loadout => ({ name: "x", note: "", harness: "claude", model: "default", effort: "default", skills: [], mcp: [], canopyTools: false, ...over });
const loadouts = [
  L({ name: "quick", note: "small fixes", model: "haiku", effort: "low", mcp: ["github"] }),
  L({ name: "build", model: "opus", effort: "high" }),
  L({ name: "fast", harness: "codex", model: "gpt-5.5" }),
];

function seed(servers: { name: string; here: boolean }[]): void {
  setRegistry("mac", ["mac"]);
  useStore.setState({ kit: { ...pristine.kit, mac: { ...pristine.kit.mac, loadouts: { base: [], loadouts, errors: [], servers } } } as typeof pristine.kit });
}

const coord = { id: "c1", repoId: "canopy", action: "coordinate" } as Run;
const task = (over: Partial<CoordTask> = {}): CoordTask => ({ id: "t4", title: "Write the rule", repo: "canopy", note: "n", action: "ask", state: "queued", ...over });

describe("EquipSheet", () => {
  test("it lists the loadouts, the card's id and the queued note", () => {
    seed([{ name: "github", here: true }]);
    const html = renderCurrent(<EquipSheet run={coord} task={task()} onDone={() => {}} />);
    for (const n of ["quick", "build", "fast"]) expect(html).toContain(`>${n}</button>`);
    expect(html).toContain("apply to t4");
    expect(html).toContain("takes the change when it starts");
  });
  test("a propose card is offered no codex loadout", () => {
    seed([]);
    const html = renderCurrent(<EquipSheet run={coord} task={task({ action: "propose" })} onDone={() => {}} />);
    expect(html).not.toContain(">fast</button>");
  });
  test("a server this backend refuses is disabled and says where it is missing", () => {
    seed([{ name: "github", here: true }, { name: "executor", here: false }]);
    const html = renderCurrent(<EquipSheet run={coord} task={task({ equip: { loadout: "quick" } })} onDone={() => {}} />);
    expect(html).toMatch(/<input[^>]*disabled[^>]*value="executor"|<input[^>]*value="executor"[^>]*disabled/);
    expect(html).toContain("not on mac");
    expect(html).not.toMatch(/<input[^>]*value="github"[^>]*disabled/);
  });
  test("a codex loadout greys skills and servers and keeps model and effort", () => {
    seed([{ name: "github", here: true }]);
    const html = renderCurrent(<EquipSheet run={coord} task={task({ equip: { loadout: "fast" } })} onDone={() => {}} />);
    expect(html).toContain("A Codex worker takes model and effort only");
    expect(html).toContain("gpt-5.5");
    expect(html).not.toContain('value="github"');
  });
  test("the card's saved override shows as the picked model", () => {
    seed([]);
    const html = renderCurrent(<EquipSheet run={coord} task={task({ equip: { loadout: "quick", model: "sonnet" } })} onDone={() => {}} />);
    expect(html).toMatch(/aria-pressed="true"[^>]*>sonnet</);
    expect(html).toContain("Changed from quick");
  });
});

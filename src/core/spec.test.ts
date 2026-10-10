import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findBlock,
  loadSpec,
  managedFiles,
  parseRecord,
  planSync,
  renderBlock,
  repoSpecState,
  specState,
  syncRepo,
  upsertBlock,
  type Spec,
} from "./spec";

const spec: Spec = {
  version: "1.0.0",
  blocks: { "SPEC.md": "keep seven sections", "AGENTS.md": "read SPEC.md", "CLAUDE.md": "read SPEC.md" },
  design: "---\nname: x\n---\n## Overview\n",
  template: "# {{name}}\n\n{{block}}\n\n## What it is\n",
};
const next: Spec = { ...spec, version: "1.1.0", blocks: { ...spec.blocks, "SPEC.md": "keep eight sections" } };

describe("blocks", () => {
  test("upsert appends a block once, then replaces it in place", () => {
    const block = renderBlock(spec, "AGENTS.md");
    const once = upsertBlock("# Agents\n\nhouse rules\n", block);
    expect(once).toBe(`# Agents\n\nhouse rules\n\n${block}\n`);
    const newer = renderBlock(next, "AGENTS.md");
    const twice = upsertBlock(once, newer);
    expect(twice).toBe(`# Agents\n\nhouse rules\n\n${newer}\n`);
    expect(findBlock(twice)).toBe(newer);
  });

  test("a replacement is taken literally, $ and all", () => {
    const odd: Spec = { ...spec, blocks: { "AGENTS.md": "costs $& and $1" } };
    const text = upsertBlock(upsertBlock("", renderBlock(spec, "AGENTS.md")), renderBlock(odd, "AGENTS.md"));
    expect(text).toContain("costs $& and $1");
  });

  test("the pointer goes where the agent files are, or into a new AGENTS.md", () => {
    expect(managedFiles(["doc"], () => false)).toEqual(["SPEC.md", "AGENTS.md"]);
    expect(managedFiles(["doc"], (f) => f === "CLAUDE.md")).toEqual(["SPEC.md", "CLAUDE.md"]);
    expect(managedFiles(["doc", "visual"], () => true)).toEqual(["SPEC.md", "AGENTS.md", "CLAUDE.md", "DESIGN.md"]);
  });
});

describe("planSync and specState", () => {
  const empty = { "SPEC.md": null, "AGENTS.md": null, "CLAUDE.md": null, "DESIGN.md": null };

  test("a new repo gets SPEC.md from the template and the doc half only", () => {
    const { writes, record } = planSync(spec, empty, ["doc"], "app");
    expect(Object.keys(writes)).toEqual(["SPEC.md", "AGENTS.md"]);
    expect(writes["SPEC.md"]).toStartWith("# app\n\n<!-- spec:begin v1.0.0 -->\nkeep seven sections\n<!-- spec:end -->");
    expect(record).toMatchObject({ version: "1.0.0", halves: ["doc"] });
    expect(specState(spec, record, { ...empty, ...writes })).toBe("in-sync");
  });

  test("not adopted, in sync, behind and drifted", () => {
    expect(specState(spec, null, empty)).toBe("not-adopted");
    const { writes, record } = planSync(spec, empty, ["doc", "visual"], "app");
    const files = { ...empty, ...writes };
    expect(specState(spec, record, files)).toBe("in-sync");
    expect(specState(next, record, files)).toBe("behind");
    // text outside the block is the repo's own
    expect(specState(spec, record, { ...files, "SPEC.md": `${files["SPEC.md"]}\nour notes\n` })).toBe("in-sync");
    const edited = (files["AGENTS.md"] ?? "").replace("read SPEC.md", "skim SPEC.md");
    expect(specState(next, record, { ...files, "AGENTS.md": edited })).toBe("drifted");
    expect(specState(spec, record, { ...files, "DESIGN.md": `${spec.design}\nmore` })).toBe("drifted");
    expect(specState(spec, record, { ...files, "DESIGN.md": null })).toBe("drifted");
  });

  test("a second sync with nothing changed writes nothing", () => {
    const first = planSync(spec, empty, ["doc"], "app");
    const again = planSync(spec, { ...empty, ...first.writes }, ["doc"], "app");
    expect(again.writes).toEqual({});
    expect(again.record).toEqual(first.record);
  });

  test("a record that is not one reads as not adopted", () => {
    expect(parseRecord("{")).toBeNull();
    expect(parseRecord('{"version":"1.0.0"}')).toBeNull();
    expect(parseRecord(null)).toBeNull();
  });
});

describe("on disk", () => {
  test("sync writes the files and the record, keeps the halves, and check sees drift", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-spec-"));
    await writeFile(join(dir, "CLAUDE.md"), "# CLAUDE.md\n\nown rules\n");
    expect(await repoSpecState(dir, spec)).toBe("not-adopted");

    const first = await syncRepo(dir, { spec, halves: ["doc", "visual"] });
    expect(first.written.sort()).toEqual(["CLAUDE.md", "DESIGN.md", "SPEC.md"]);
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toStartWith("# CLAUDE.md\n\nown rules\n\n<!-- spec:begin v1.0.0 -->");
    expect(await repoSpecState(dir, spec)).toBe("in-sync");
    expect(await repoSpecState(dir, next)).toBe("behind");

    const upgraded = await syncRepo(dir, { spec: next });
    expect(upgraded.record.halves).toEqual(["doc", "visual"]);
    expect(upgraded.written).toEqual(["SPEC.md", "CLAUDE.md"]); // the markers name the version
    expect(await repoSpecState(dir, next)).toBe("in-sync");

    await writeFile(join(dir, "DESIGN.md"), "hand-made\n");
    expect(await repoSpecState(dir, next)).toBe("drifted");
  });

  test("going back to the doc half removes the DESIGN.md it wrote, never one edited since", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-spec-"));
    await syncRepo(dir, { spec, halves: ["doc", "visual"] });
    const back = await syncRepo(dir, { spec, halves: ["doc"] });
    expect(back.removed).toEqual(["DESIGN.md"]);
    expect(back.record.blocks["DESIGN.md"]).toBeUndefined();
    expect(await Bun.file(join(dir, "DESIGN.md")).exists()).toBe(false);
    expect(await repoSpecState(dir, spec)).toBe("in-sync");

    await syncRepo(dir, { spec, halves: ["doc", "visual"] });
    await writeFile(join(dir, "DESIGN.md"), "the repo's own now\n");
    const kept = await syncRepo(dir, { spec, halves: ["doc"] });
    expect(kept.removed).toEqual([]);
    expect(await readFile(join(dir, "DESIGN.md"), "utf8")).toBe("the repo's own now\n");
    expect(await repoSpecState(dir, spec)).toBe("in-sync");
  });
});

describe("the bundled spec", () => {
  test("has a semver version and a block for every file it manages", async () => {
    const s = await loadSpec();
    expect(s.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const f of ["SPEC.md", "AGENTS.md", "CLAUDE.md"]) {
      expect(s.blocks[f]).toContain(s.version);
      expect(s.blocks[f]).not.toContain("{{");
    }
    expect(s.template).toContain("{{block}}");
  });

  test("keeps to its length budget", async () => {
    const s = await loadSpec();
    const lines = (t: string) => t.trimEnd().split("\n").length;
    expect(lines(s.design)).toBeLessThanOrEqual(150);
    expect(lines(s.blocks["SPEC.md"] ?? "")).toBeLessThanOrEqual(25);
    expect(lines(s.blocks["AGENTS.md"] ?? "")).toBeLessThanOrEqual(8);
    const sections = s.template.split("\n").filter((l) => l.startsWith("## "));
    expect(sections).toEqual([
      "## What it is",
      "## Who uses it",
      "## Stack and versions",
      "## How it is built and run",
      "## Data and state",
      "## Decisions",
      "## Out of scope",
    ]);
  });

  test("every token a DESIGN.md component names is defined", async () => {
    const { design } = await loadSpec();
    const front = design.split("\n---\n")[0] ?? "";
    for (const m of front.matchAll(/\{(colors|typography|rounded|spacing)\.([a-z0-9-]+)\}/g)) {
      expect(front).toMatch(new RegExp(`^  ${m[2]}:`, "m"));
    }
    const dos = design.slice(design.indexOf("## Do's and Don'ts")).split("\n").filter((l) => l.startsWith("- "));
    expect(dos.length).toBeLessThanOrEqual(10);
  });
});

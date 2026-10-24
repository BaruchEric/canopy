import { describe, expect, test } from "bun:test";
import {
  adoptDoc,
  canonical,
  docOf,
  type Entries,
  fileOf,
  flatten,
  hashOf,
  type LibFile,
  type LibFiles,
  massDeletion,
  merge,
  newer,
  parseSyncDoc,
  parseSyncState,
  seedState,
  stampPass,
  type SyncState,
  unflatten,
} from "./libsync";

const fixture = (): LibFiles => ({
  categories: {
    version: 1,
    _comment: "local only",
    stale_days: 120,
    host_root: "/home/eric/dev",
    github_login: "BaruchEric",
    helper_port: 7333,
    trusted_origins: [],
    terminal_app: "Terminal",
    ignore: ["skills", "references"],
    categories: {
      "web-apps": { label: "Web apps", blurb: "Apps.", keywords: ["react"] },
      "dev-tools": { label: "Dev tools", blurb: "Tools.", keywords: ["cli"] },
    },
    overrides: { canopy: "dev-tools" },
    links: { ripe: { deployed: "https://ripe.fit", dev_port: 6101 } },
    notes: { canopy: "the workbench" },
    archived: ["old"],
    favorites: ["ripe"],
    pinned: ["canopy"],
    dev_port_base: 6100,
  },
  references: [
    { id: "aa", type: "link", url: "https://a.example", title: "A", category: "notes" },
    { type: "link", url: "https://no-id.example", title: "no id" },
    { id: "bb", type: "youtube", url: "https://b.example", title: "B", category: "ai-tools" },
  ],
  tags: { ripe: ["firebase", "react"], canopy: ["cli"] },
  relations: { pairs: [["project:canopy", "project:ripe"]] },
  health: { "https://ripe.fit": { status: 200, ok: true, checked: "2026-10-01T00:00:00-07:00" } },
});

const ALL: ReadonlySet<LibFile> = new Set(["categories", "references", "tags", "relations", "health"]);

const joined = (entries: SyncState["entries"] = {}, tombs: SyncState["tombs"] = {}): SyncState => ({
  v: 1,
  joined: { how: "seed", at: 1 },
  entries,
  tombs,
});

/** a backend's stamped values, every entry stamped at `at` by `by` */
function backend(values: Entries, at: number, by: string): { state: SyncState; values: Entries } {
  return { state: stampPass(joined(), values, ALL, at, by).state, values };
}

describe("flatten", () => {
  test("every shared section becomes keyed entries, and the host keys stay out", () => {
    const e = flatten(fixture());
    expect(e["cat:web-apps"]).toEqual({ label: "Web apps", blurb: "Apps.", keywords: ["react"] });
    expect(e["ovr:canopy"]).toBe("dev-tools");
    expect(e["link:ripe"]).toEqual({ deployed: "https://ripe.fit", dev_port: 6101 });
    expect(e["note:canopy"]).toBe("the workbench");
    expect(e["arch:old"]).toBe(true);
    expect(e["fav:ripe"]).toBe(true);
    expect(e["pin:canopy"]).toBe(true);
    expect(e["ign:skills"]).toBe(true);
    expect(e["set:stale_days"]).toBe(120);
    expect(e["set:github_login"]).toBe("BaruchEric");
    expect(e["set:dev_port_base"]).toBe(6100);
    expect(e["ref:aa"]).toMatchObject({ url: "https://a.example" });
    expect(e["tag:ripe"]).toEqual(["firebase", "react"]);
    expect(e["rel:project:canopy|project:ripe"]).toEqual(["project:canopy", "project:ripe"]);
    expect(e["health:https://ripe.fit"]).toMatchObject({ status: 200 });
    const keys = Object.keys(e).join(" ");
    for (const host of ["host_root", "helper_port", "trusted_origins", "terminal_app", "version", "_comment", "no-id"]) {
      expect(keys).not.toContain(host);
    }
  });

  test("a legacy bare-list relations file and an unsorted pair read the same", () => {
    expect(flatten({ relations: [["b", "a"]] })).toEqual({ "rel:a|b": ["a", "b"] });
  });

  test("every key maps back to its file", () => {
    for (const key of Object.keys(flatten(fixture()))) expect(fileOf(key)).not.toBeNull();
    expect(fileOf("place:canopy")).toBeNull();
  });
});

describe("unflatten", () => {
  test("the files' own entries change nothing", () => {
    const files = fixture();
    expect(unflatten(flatten(files), files)).toEqual({});
  });

  test("keeps the host keys and the base's order, appends new names and drops deleted ones", () => {
    const files = fixture();
    const e = flatten(files);
    e["cat:ai-tools"] = { label: "AI tools", blurb: "", keywords: [] };
    delete e["cat:web-apps"];
    e["fav:canopy"] = true;
    e["set:stale_days"] = 90;
    e["tag:canopy"] = ["cli", "bun"];
    e["ref:cc"] = { id: "cc", url: "https://c.example" };
    delete e["ref:aa"];
    delete e["health:https://ripe.fit"];
    const out = unflatten(e, files);
    const cfg = out.categories as Record<string, unknown>;
    expect(cfg["host_root"]).toBe("/home/eric/dev");
    expect(cfg["helper_port"]).toBe(7333);
    expect(cfg["_comment"]).toBe("local only");
    expect(Object.keys(cfg["categories"] as object)).toEqual(["dev-tools", "ai-tools"]);
    expect(cfg["favorites"]).toEqual(["ripe", "canopy"]);
    expect(cfg["stale_days"]).toBe(90);
    // the reference with no id stays where it was
    expect((out.references as { url: string }[]).map((r) => r.url)).toEqual([
      "https://no-id.example",
      "https://b.example",
      "https://c.example",
    ]);
    expect((out.tags as Record<string, string[]>)["canopy"]).toEqual(["cli", "bun"]);
    expect(out.health).toEqual({});
    expect(out.relations).toBeUndefined();
  });

  test("a shared setting deleted on the other side is deleted here", () => {
    const files = fixture();
    const e = flatten(files);
    delete e["set:dev_port_base"];
    expect("dev_port_base" in (unflatten(e, files).categories as object)).toBe(false);
  });

  test("a missing file is written only once it has entries", () => {
    const files: LibFiles = { categories: { categories: {} } };
    expect(unflatten(flatten(files), files)).toEqual({});
    expect(unflatten({ "tag:x": ["a"] }, files).tags).toEqual({ x: ["a"] });
  });
});

describe("stampPass", () => {
  test("stamps a change, tombstones a delete, and leaves the unchanged alone", () => {
    const e = flatten(fixture());
    const first = stampPass(joined(), e, ALL, 100, "mac").state;
    const next: Entries = { ...e, "tag:ripe": ["firebase"] };
    delete next["note:canopy"];
    const { state, changed } = stampPass(first, next, ALL, 200, "mac");
    expect(changed.sort()).toEqual(["note:canopy", "tag:ripe"]);
    expect(state.entries["tag:ripe"]).toMatchObject({ at: 200, by: "mac" });
    expect(state.entries["ovr:canopy"]).toMatchObject({ at: 100 });
    expect(state.tombs["note:canopy"]).toEqual({ at: 200, by: "mac" });
    expect(state.entries["note:canopy"]).toBeUndefined();
  });

  test("a file outside the scope, as one that did not parse, keeps its stamps", () => {
    const e = flatten(fixture());
    const first = stampPass(joined(), e, ALL, 100, "mac").state;
    const noTags = Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith("tag:")));
    const scope = new Set<LibFile>(["categories", "references", "relations", "health"]);
    const { state, changed } = stampPass(first, noTags, scope, 200, "mac");
    expect(changed).toEqual([]);
    expect(state.entries["tag:ripe"]).toMatchObject({ at: 100 });
  });

  test("a key ordering change is no change", () => {
    const first = stampPass(joined(), { "link:x": { a: 1, b: 2 } }, ALL, 100, "mac").state;
    expect(stampPass(first, { "link:x": { b: 2, a: 1 } }, ALL, 200, "mac").changed).toEqual([]);
    expect(canonical({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  test("a value written back after a tombstone is stamped again", () => {
    const first = stampPass(joined(), { "fav:x": true }, ALL, 100, "mac").state;
    const gone = stampPass(first, {}, ALL, 200, "mac").state;
    const back = stampPass(gone, { "fav:x": true }, ALL, 300, "mac").state;
    expect(back.entries["fav:x"]).toMatchObject({ at: 300 });
    expect(back.tombs["fav:x"]).toBeUndefined();
  });
});

describe("seed and adopt", () => {
  test("a seed stamps each entry at its file's time", () => {
    const e = flatten(fixture());
    const s = seedState(e, { categories: 5000.7, tags: 7000 }, "mac", 9000);
    expect(s.joined).toEqual({ how: "seed", at: 9000 });
    expect(s.entries["tag:ripe"]).toMatchObject({ at: 7000, by: "mac" });
    expect(s.entries["ovr:canopy"]).toMatchObject({ at: 5000 });
    expect(s.entries["ref:aa"]).toMatchObject({ at: 9000 });
  });

  test("an adopt takes the other backend's values and stamps whole", () => {
    const mac = backend({ "tag:ripe": ["a"], "fav:x": true }, 100, "mac");
    const doc = docOf("mac", { ...mac.state, tombs: { "note:gone": { at: 50, by: "mac" } } }, mac.values);
    const { values, state } = adoptDoc(doc, 999);
    expect(values).toEqual(mac.values);
    expect(state.joined).toEqual({ how: "adopt", from: "mac", at: 999 });
    expect(state.entries["fav:x"]).toEqual(mac.state.entries["fav:x"]!);
    expect(state.tombs["note:gone"]).toEqual({ at: 50, by: "mac" });
  });
});

describe("merge", () => {
  test("a newer entry from the peer is taken, an older one is not", () => {
    const mini = backend({ "tag:ripe": ["old"], "note:x": "mine" }, 100, "mini");
    const mac = backend({ "tag:ripe": ["new"], "note:x": "theirs" }, 50, "mac");
    mac.state.entries["tag:ripe"]!.at = 200;
    const r = merge(mini, docOf("mac", mac.state, mac.values));
    expect(r.held).toBeNull();
    expect(r.taken).toEqual(["tag:ripe"]);
    expect(r.values["tag:ripe"]).toEqual(["new"]);
    expect(r.values["note:x"]).toBe("mine");
    expect(r.state.entries["tag:ripe"]).toMatchObject({ at: 200, by: "mac" });
  });

  test("a new key from the peer is taken; one this side never had is unknown, not deleted", () => {
    const mini = backend({ "fav:a": true }, 100, "mini");
    const mac = backend({ "fav:b": true }, 50, "mac");
    const r = merge(mini, docOf("mac", mac.state, mac.values));
    expect(r.values).toEqual({ "fav:a": true, "fav:b": true });
    expect(r.deleted).toEqual([]);
  });

  test("a tie goes to the greater backend name", () => {
    expect(newer({ at: 1, by: "mini" }, { at: 1, by: "mac" })).toBe(true);
    expect(newer({ at: 1, by: "mac" }, { at: 1, by: "mini" })).toBe(false);
    expect(newer({ at: 1, by: "mac" }, undefined)).toBe(true);
  });

  test("a peer's tombstone deletes an older value and loses to a newer one", () => {
    const mini = backend({ "note:x": "kept", "note:y": "goes" }, 100, "mini");
    mini.state.entries["note:x"]!.at = 300;
    const doc = { backend: "mac", ready: true as const, entries: {}, tombs: { "note:x": { at: 200, by: "mac" }, "note:y": { at: 200, by: "mac" } } };
    const r = merge(mini, doc);
    expect(r.deleted).toEqual(["note:y"]);
    expect(r.values).toEqual({ "note:x": "kept" });
    expect(r.state.tombs["note:y"]).toEqual({ at: 200, by: "mac" });
  });

  test("the same value with a newer stamp only restamps", () => {
    const mini = backend({ "tag:ripe": ["a"] }, 100, "mini");
    const mac = backend({ "tag:ripe": ["a"] }, 200, "mac");
    const r = merge(mini, docOf("mac", mac.state, mac.values));
    expect(r.taken).toEqual([]);
    expect(r.restamped).toEqual(["tag:ripe"]);
    expect(r.state.entries["tag:ripe"]).toMatchObject({ at: 200, by: "mac" });
  });

  test("a category whose folder still has projects keeps its tombstone back", () => {
    const mini = backend({ "cat:web-apps": { label: "W" }, "cat:empty": { label: "E" } }, 100, "mini");
    const tombs = { "cat:web-apps": { at: 200, by: "mac" }, "cat:empty": { at: 200, by: "mac" } };
    const r = merge(mini, { backend: "mac", ready: true, entries: {}, tombs }, { keepCategory: (n) => n === "web-apps" });
    expect(r.keptCategories).toEqual(["cat:web-apps"]);
    expect(r.deleted).toEqual(["cat:empty"]);
    expect(r.values["cat:web-apps"]).toEqual({ label: "W" });
    expect(r.state.entries["cat:web-apps"]).toMatchObject({ at: 100 });
  });

  test("a mass deletion holds the whole merge until accepted", () => {
    const values: Entries = {};
    for (let i = 0; i < 30; i++) values[`fav:p${i}`] = true;
    const mini = backend(values, 100, "mini");
    const tombs = Object.fromEntries(Object.keys(values).map((k) => [k, { at: 200, by: "mac" }]));
    const doc = { backend: "mac", ready: true as const, entries: { "note:new": { v: "n", at: 200, by: "mac" } }, tombs };
    const held = merge(mini, doc);
    expect(held.held).toBe("mac would delete 30 of 30 entries");
    expect(held.values).toBe(mini.values);
    expect(held.state).toBe(mini.state);
    const accepted = merge(mini, doc, { accept: true });
    expect(accepted.held).toBeNull();
    expect(accepted.values).toEqual({ "note:new": "n" });
  });

  test("the mass-deletion line", () => {
    expect(massDeletion(21, 10_000)).toBe(true);
    expect(massDeletion(20, 10_000)).toBe(false);
    expect(massDeletion(5, 24)).toBe(true);
    expect(massDeletion(4, 10)).toBe(false);
    expect(massDeletion(5, 25)).toBe(false);
  });

  test("keys of no known file are ignored either way", () => {
    const mini = backend({}, 100, "mini");
    const r = merge(mini, { backend: "mac", ready: true, entries: { "place:x": { v: 1, at: 200, by: "mac" } }, tombs: { "bogus": { at: 1, by: "mac" } } });
    expect(r.values).toEqual({});
    expect(r.state.tombs).toEqual({});
  });
});

describe("parsing", () => {
  test("a doc and a state survive the wire and the disk", () => {
    const mac = backend(flatten(fixture()), 100, "mac");
    const doc = docOf("mac", mac.state, mac.values);
    expect(parseSyncDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(parseSyncState(JSON.parse(JSON.stringify(mac.state)))).toEqual(mac.state);
    expect(parseSyncDoc({ backend: "mac", ready: false })).toEqual({ backend: "mac", ready: false });
  });

  test("anything else is refused", () => {
    expect(parseSyncState(null)).toBeNull();
    expect(parseSyncState({ v: 2, joined: { how: "seed", at: 1 }, entries: {}, tombs: {} })).toBeNull();
    expect(parseSyncState({ v: 1, joined: { how: "guess", at: 1 } })).toBeNull();
    expect(parseSyncDoc({ ready: true })).toBeNull();
    expect(parseSyncDoc({ backend: "mac", ready: true, entries: {} })).toBeNull();
  });

  test("hashes ignore key order", () => {
    expect(hashOf({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashOf({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });
});

describe("stamps and a clock behind", () => {
  test("an edit is stamped after the stamp it replaces, even with the clock behind it", () => {
    const seeded = seedState({ "tag:x": ["a"], "note:y": "n" }, { tags: 9_000, categories: 9_000 }, "mac", 9_500);
    const { state } = stampPass(seeded, { "tag:x": ["a", "b"] }, ALL, 100, "mac");
    expect(state.entries["tag:x"]).toMatchObject({ at: 9_001, by: "mac" });
    expect(state.tombs["note:y"]).toEqual({ at: 9_001, by: "mac" });
  });
});

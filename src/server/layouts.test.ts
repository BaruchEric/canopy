import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index";
import { parseKept } from "./layouts";
import { PRESETS } from "../core/screenlayouts";
import type { ScreenProfile } from "../core/types";

let scratch: string;
let server: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};
const base = () => `http://127.0.0.1:${server.port}/api/layouts`;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-layouts-"));
  for (const k of ["CANOPY_CONFIG_DIR", "CANOPY_TMUX"]) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CANOPY_TMUX"] = "0";
  await mkdir(join(scratch, "root"), { recursive: true });
  server = await startServer({ root: join(scratch, "root"), port: 0, chan: null });
});

afterAll(async () => {
  server.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

const send = (method: string, url: string, body?: unknown) =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

const mine = { name: "desk", device: "Studio Display", width: 5120, height: 2880, dpr: 2, layout: { arrange: "columns", columnWidth: 640 } };

describe("/api/layouts", () => {
  test("lists the presets before anything is kept", async () => {
    const res = await fetch(base());
    expect(res.status).toBe(200);
    const { profiles } = (await res.json()) as { profiles: ScreenProfile[] };
    expect(profiles.map((p) => p.id)).toEqual(PRESETS.map((p) => p.id));
    expect(profiles.every((p) => p.builtin)).toBe(true);
  });

  test("creates, reads, updates and deletes a profile of the user's own", async () => {
    const made = await send("POST", base(), { profile: mine });
    expect(made.status).toBe(201);
    const { profile } = (await made.json()) as { profile: ScreenProfile };
    expect(profile.id).toMatch(/^p-[0-9a-f]{12}$/);
    expect(profile.builtin).toBeUndefined();
    expect(profile.layout).toEqual({ arrange: "columns", columnWidth: 640 });
    // kept on disk as the list says
    const file = JSON.parse(await readFile(join(scratch, "config", "screen-layouts.json"), "utf8")) as { profiles: { id: string }[] };
    expect(file.profiles.map((p) => p.id)).toEqual([profile.id]);

    const put = await send("PUT", `${base()}?id=${profile.id}`, { profile: { ...mine, name: "desk, left" } });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { profile: ScreenProfile }).profile.name).toBe("desk, left");

    const gone = await send("DELETE", `${base()}?id=${profile.id}`);
    expect(gone.status).toBe(200);
    const { profiles } = (await gone.json()) as { profiles: ScreenProfile[] };
    expect(profiles.some((p) => p.id === profile.id)).toBe(false);
    expect((await send("DELETE", `${base()}?id=${profile.id}`)).status).toBe(404);
  });

  test("a preset can be changed and reset, not deleted", async () => {
    const id = "preset-1920x1080";
    const put = await send("PUT", `${base()}?id=${id}`, { profile: { name: "office", device: "Dell", width: 1920, height: 1080, layout: { carousel: true } } });
    expect(put.status).toBe(200);
    const changed = ((await put.json()) as { profile: ScreenProfile }).profile;
    expect(changed).toMatchObject({ id, name: "office", builtin: true, edited: true, layout: { carousel: true } });
    expect((await send("DELETE", `${base()}?id=${id}`)).status).toBe(400);
    const reset = await send("POST", `${base()}/reset?id=${id}`);
    expect(reset.status).toBe(200);
    const back = ((await reset.json()) as { profiles: ScreenProfile[] }).profiles.find((p) => p.id === id);
    expect(back).toEqual(PRESETS.find((p) => p.id === id));
  });

  test("duplicates a preset as a profile of the user's own", async () => {
    const res = await send("POST", base(), { from: "preset-7680x2160" });
    expect(res.status).toBe(201);
    const { profile } = (await res.json()) as { profile: ScreenProfile };
    const preset = PRESETS.find((p) => p.id === "preset-7680x2160");
    expect(profile).toMatchObject({ name: `${preset?.name} copy`, width: 7680, height: 2160, layout: preset?.layout ?? {} });
    expect(profile.builtin).toBeUndefined();
    // a user profile does not reset
    expect((await send("POST", `${base()}/reset?id=${profile.id}`)).status).toBe(400);
    expect((await send("DELETE", `${base()}?id=${profile.id}`)).status).toBe(200);
  });

  test("refuses a profile that does not check out and an unknown id", async () => {
    expect((await send("POST", base(), { profile: { ...mine, name: "" } })).status).toBe(400);
    expect((await send("POST", base(), { profile: { ...mine, width: 1.5 } })).status).toBe(400);
    expect((await send("POST", base(), { profile: { ...mine, layout: { panelZoom: 9 } } })).status).toBe(400);
    expect((await send("POST", base(), { from: "nope" })).status).toBe(404);
    expect((await send("PUT", `${base()}?id=p-000000000000`, { profile: mine })).status).toBe(404);
    expect((await send("POST", `${base()}/reset?id=nope`)).status).toBe(404);
    const bad = await fetch(base(), { method: "POST", body: "{" });
    expect(bad.status).toBe(400);
  });
});

describe("parseKept", () => {
  test("keeps what checks out and drops the rest", () => {
    const kept = parseKept(
      JSON.stringify({
        profiles: [
          { id: "p-0123456789ab", ...mine },
          { id: "not-an-id", ...mine },
          { id: "p-0123456789ac", ...mine, height: -1 },
        ],
        presets: { "preset-1280x800": { ...mine, width: 1280, height: 800 }, "preset-1x1": mine },
      }),
    );
    expect(kept.profiles.map((p) => p.id)).toEqual(["p-0123456789ab"]);
    expect(Object.keys(kept.presets)).toEqual(["preset-1280x800"]);
    expect(parseKept("not json")).toEqual({ profiles: [], presets: {} });
  });
});

/**
 * The screen layout profiles this backend keeps for its pages:
 * `<config dir>/screen-layouts.json`, the user's own profiles and the
 * presets they changed. The presets themselves are code
 * (`core/screenlayouts.ts`), so a reset only drops the change.
 *
 *   GET    /api/layouts              { profiles }: the presets, changed ones as changed, then the user's
 *   POST   /api/layouts              { profile } or { from: id } (a copy of any profile): 201 with { profile, profiles }
 *   PUT    /api/layouts?id=          { profile }: a preset's change or a user profile replaced
 *   DELETE /api/layouts?id=          a user profile; 400 for a preset, which resets instead
 *   POST   /api/layouts/reset?id=    a preset back as it ships; 400 for a user profile
 *
 * 404 for an unknown id, 400 for a profile that does not check out.
 */

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { PRESETS, isPresetId, parseProfile, type ProfileFields } from "../core/screenlayouts";
import { configDir } from "../core/store";
import type { ScreenProfile } from "../core/types";

/** what the file holds */
interface Kept {
  profiles: ScreenProfile[];
  presets: Record<string, ProfileFields>;
}

/** the most profiles of their own a user keeps */
const MOST = 200;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The file read back, every entry checked again; one that fails is left
 *  out rather than failing the rest. */
export function parseKept(raw: string): Kept {
  const out: Kept = { profiles: [], presets: {} };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isRecord(v)) return out;
  if (Array.isArray(v["profiles"])) {
    for (const p of v["profiles"]) {
      if (!isRecord(p) || typeof p["id"] !== "string" || !/^p-[0-9a-f]{12}$/.test(p["id"])) continue;
      const got = parseProfile(p);
      if ("profile" in got && !out.profiles.some((x) => x.id === p["id"])) out.profiles.push({ id: p["id"], ...got.profile });
    }
  }
  if (isRecord(v["presets"])) {
    for (const [id, p] of Object.entries(v["presets"])) {
      const got = parseProfile(p);
      if (isPresetId(id) && "profile" in got) out.presets[id] = got.profile;
    }
  }
  return out;
}

/** a reply in JSON */
const json = (body: unknown, status = 200): Response => Response.json(body, { status });

export class ScreenLayouts {
  private kept: Kept;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string = join(configDir(), "screen-layouts.json")) {
    let raw: string | null = null;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      raw = null;
    }
    this.kept = raw === null ? { profiles: [], presets: {} } : parseKept(raw);
  }

  /** the presets, changed ones as changed, then the user's own */
  list(): ScreenProfile[] {
    const presets = PRESETS.map((p): ScreenProfile => {
      const own = this.kept.presets[p.id];
      return own ? { ...own, id: p.id, builtin: true, edited: true } : p;
    });
    return [...presets, ...this.kept.profiles];
  }

  /** One change after another, written through a temp file and a rename,
   *  and taken into memory only once the write succeeds. */
  private update<T>(change: (kept: Kept) => { next: Kept; out: T }): Promise<T> {
    const run = this.chain
      .catch(() => {})
      .then(async () => {
        const { next, out } = change(this.kept);
        const dir = dirname(this.file);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const tmp = join(dir, `.${basename(this.file)}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`);
        await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await rename(tmp, this.file);
        this.kept = next;
        return out;
      });
    this.chain = run;
    return run;
  }

  private find(id: string): ScreenProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/layouts" && path !== "/api/layouts/reset") return null;
    const method = req.method;
    const id = url.searchParams.get("id") ?? "";
    if (path === "/api/layouts" && method === "GET") return json({ profiles: this.list() });
    if (path === "/api/layouts/reset" && method === "POST") {
      if (!this.find(id)) return json({ error: "no such layout" }, 404);
      if (!isPresetId(id)) return json({ error: "only a built-in layout resets; delete your own instead" }, 400);
      await this.update((k) => {
        const { [id]: _gone, ...presets } = k.presets;
        return { next: { ...k, presets }, out: null };
      });
      return json({ profiles: this.list() });
    }
    if (path !== "/api/layouts") return null;
    if (method === "DELETE") {
      if (!this.find(id)) return json({ error: "no such layout" }, 404);
      if (isPresetId(id)) return json({ error: "a built-in layout is reset, not deleted" }, 400);
      await this.update((k) => ({ next: { ...k, profiles: k.profiles.filter((p) => p.id !== id) }, out: null }));
      return json({ profiles: this.list() });
    }
    if (method !== "POST" && method !== "PUT") return null;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "the body is not JSON" }, 400);
    }
    if (!isRecord(body)) return json({ error: "the body is an object" }, 400);
    if (method === "POST") {
      let fields: ProfileFields;
      if (typeof body["from"] === "string") {
        const from = this.find(body["from"]);
        if (!from) return json({ error: "no such layout to copy" }, 404);
        const { id: _id, builtin: _b, edited: _e, ...rest } = from;
        fields = { ...rest, name: `${rest.name} copy`.slice(0, 60) };
      } else {
        const got = parseProfile(body["profile"]);
        if ("error" in got) return json({ error: got.error }, 400);
        fields = got.profile;
      }
      if (this.kept.profiles.length >= MOST) return json({ error: `at most ${MOST} layouts of your own` }, 400);
      const profile: ScreenProfile = { id: `p-${randomBytes(6).toString("hex")}`, ...fields };
      await this.update((k) => ({ next: { ...k, profiles: [...k.profiles, profile] }, out: null }));
      return json({ profile, profiles: this.list() }, 201);
    }
    const got = parseProfile(body["profile"]);
    if ("error" in got) return json({ error: got.error }, 400);
    if (!this.find(id)) return json({ error: "no such layout" }, 404);
    const fields = got.profile;
    await this.update((k) =>
      isPresetId(id)
        ? { next: { ...k, presets: { ...k.presets, [id]: fields } }, out: null }
        : { next: { ...k, profiles: k.profiles.map((p) => (p.id === id ? { id, ...fields } : p)) }, out: null },
    );
    return json({ profile: this.find(id), profiles: this.list() });
  }
}

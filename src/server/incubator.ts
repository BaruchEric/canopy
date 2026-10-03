/**
 * The incubator's routes (core/incubator.ts does the work). Intake is
 * multipart so a voice memo or an image comes in as it is; the rest is JSON.
 *
 * Only the server holding the flows lock owns the incubator, since a stage
 * is a flow and only that server keeps flow records. Any other server (a
 * scratch or dev server on the same config dir) lists the owner's records
 * read-only and answers every write with 503.
 */
import { INPUT_TOTAL_MAX, inputsIndex, isSeedRepoId, isSproutId } from "../core/sprout";
import { IncubatorError, type Incubator, type Intake, type IntakeFile } from "../core/incubator";
import type { Flow, IncubatorStages, Sprout, SproutDetail } from "../core/types";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (vs: readonly unknown[]): string[] => vs.filter((v): v is string => typeof v === "string");

/** a little over the inputs' cap, for the form's own framing */
export const BODY_MAX = INPUT_TOTAL_MAX + 1024 * 1024;

/** how many links, and how many files, one intake may carry */
export const INTAKE_FIELDS_MAX = 50;
/** a file's name as canopy keeps it, its extension kept */
export const LABEL_MAX = 200;

/** Whether this server keeps the incubator: only once it holds the flows
 *  lock and has taken its sprouts back. */
export type Keeping = { kind: "starting" } | { kind: "owner" } | { kind: "elsewhere"; pid: number } | { kind: "unlocked" };

/** what a write is refused with while this server does not keep the incubator */
export function notKeeping(k: Keeping): string {
  const head = "this canopy is not keeping the incubator right now";
  switch (k.kind) {
    case "starting":
      return `${head}: it is still taking its projects back; try again in a moment`;
    case "elsewhere":
      return `${head}: canopy pid ${k.pid} keeps it for this config folder`;
    case "unlocked":
      return `${head}: it could not lock the flows folder`;
    case "owner":
      return head;
  }
}

/** a name cut to `LABEL_MAX` characters, its extension kept, since the
 *  extension is how a markdown file is told apart */
export function clipLabel(name: string): string {
  if (name.length <= LABEL_MAX) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  return name.slice(0, LABEL_MAX - ext.length) + ext;
}

/** whether the sprout speaks for a flow: one the incubator owns, or any
 *  flow on a seed, which covers one that failed inside Flows.start or came
 *  back from disk before the incubator took its records back */
export const sproutFlow = (flow: Pick<Flow, "id" | "repoId">, owns: (flowId: string) => boolean): boolean =>
  owns(flow.id) || isSeedRepoId(flow.repoId);

export async function readIntake(req: Request): Promise<Intake> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("multipart/form-data")) throw new IncubatorError(415, "send a project as multipart/form-data");
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > BODY_MAX) throw new IncubatorError(413, "a project's inputs come to over 100 MB");
  const form = await req.formData().catch(() => null);
  if (!form) throw new IncubatorError(400, "the form could not be read");
  const fileFields = [...form.getAll("file"), ...form.getAll("files[]")];
  if (fileFields.length > INTAKE_FIELDS_MAX) throw new IncubatorError(400, `at most ${INTAKE_FIELDS_MAX} files at a time`);
  const urls = strings([...form.getAll("url"), ...form.getAll("urls[]")]);
  if (urls.length > INTAKE_FIELDS_MAX) throw new IncubatorError(400, `at most ${INTAKE_FIELDS_MAX} links at a time`);
  const files: IntakeFile[] = [];
  for (const v of fileFields) {
    if (typeof v === "string") continue;
    files.push({ label: clipLabel(v.name || "upload"), type: v.type, data: new Uint8Array(await v.arrayBuffer()) });
  }
  const repo = form.get("repo");
  return {
    text: strings(form.getAll("text")).join("\n\n"),
    urls,
    files,
    ...(typeof repo === "string" && repo.trim() ? { repo } : {}),
    via: form.get("via") === "cli" ? "cli" : "sheet",
  };
}

const isAnswers = (v: unknown): v is Record<string, string> => isObj(v) && Object.values(v).every((x) => typeof x === "string");

export class IncubatorHub {
  /** whether this server keeps the incubator, and if not, why */
  private keeping: Keeping = { kind: "starting" };

  constructor(
    readonly inc: Incubator,
    /** this root's records on disk, what a server without the lock lists */
    private readonly records: () => Promise<Sprout[]>,
    /** where stages run now, which any server can say */
    private readonly stages: () => IncubatorStages,
  ) {}

  onFlow(flow: Flow): void {
    this.inc.onFlow(flow);
  }

  ownsFlow(flowId: string): boolean {
    return this.inc.ownsFlow(flowId);
  }

  /** whether a flow's notices are the sprout's to give */
  speaksFor(flow: Pick<Flow, "id" | "repoId">): boolean {
    return sproutFlow(flow, (id) => this.inc.ownsFlow(id));
  }

  /** only on the server holding the flows lock, after its flows are back */
  async restore(): Promise<void> {
    await this.inc.restore();
    this.keeping = { kind: "owner" };
  }

  /** a server without the flows lock: `holder` is the canopy that has it, 0 when none could be told */
  notKeeping(holder: number): void {
    this.keeping = holder ? { kind: "elsewhere", pid: holder } : { kind: "unlocked" };
  }

  detach(): void {
    this.inc.detach();
  }

  /** the owner's records as they are on disk, newest first */
  private async onDisk(): Promise<Sprout[]> {
    return (await this.records()).sort((a, b) => b.createdAt - a.createdAt);
  }

  private async readOnly(path: string, method: string, id: string): Promise<Response> {
    if (method !== "GET") return json({ error: notKeeping(this.keeping) }, 503);
    if (path === "/api/incubator") return json(await this.onDisk());
    if (path === "/api/incubator/one") {
      const s = isSproutId(id) ? (await this.onDisk()).find((x) => x.id === id) : undefined;
      if (!s) return json({ error: "no such project" }, 404);
      // the seed's own words are the owner's to read; the record is enough here
      const d: SproutDetail = { sprout: s, brief: null, intent: null, inputsIndex: inputsIndex(s.inputs), research: null };
      return json(d);
    }
    return json({ error: "not found" }, 404);
  }

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/incubator" && !path.startsWith("/api/incubator/")) return null;
    const method = req.method;
    const id = url.searchParams.get("id") ?? "";
    if (path === "/api/incubator/stages" && method === "GET") return json(this.stages());
    if (this.keeping.kind !== "owner") return this.readOnly(path, method, id);
    try {
      if (path === "/api/incubator" && method === "GET") return json(this.inc.list());
      if (path === "/api/incubator" && method === "POST") return json(await this.inc.create(await readIntake(req)), 201);
      if (path === "/api/incubator" && method === "DELETE") {
        // waits for the sprout's own work under way (a memo transcribing), and only this request
        await this.inc.dismiss(id);
        return json({ ok: true });
      }
      if (path === "/api/incubator/one" && method === "GET") return json(await this.inc.detail(id));
      if (path === "/api/incubator/input" && method === "POST") return json(await this.inc.addInputs(id, await readIntake(req)));
      if (method === "POST" && (path === "/api/incubator/answer" || path === "/api/incubator/stop" || path === "/api/incubator/resume")) {
        if (path === "/api/incubator/stop") return json(await this.inc.stop(id));
        const b: unknown = await req.json().catch(() => null);
        if (!isObj(b)) return json({ error: "send a JSON object" }, 400);
        if (path === "/api/incubator/resume") {
          const choice = b["choice"];
          if (choice !== "continue" && choice !== "retry") return json({ error: "choice is continue or retry" }, 400);
          return json(await this.inc.resume(id, choice));
        }
        if (b["skip"] === true) return json(await this.inc.answer(id, null));
        const answers = b["answers"];
        if (!isAnswers(answers)) return json({ error: "answers are each question's text to an answer's text" }, 400);
        return json(await this.inc.answer(id, answers));
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof IncubatorError) return json({ error: err.message }, err.status);
      throw err;
    }
  }
}

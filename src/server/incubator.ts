/**
 * The incubator's routes (core/incubator.ts does the work). Intake is
 * multipart so a voice memo or an image comes in as it is; the rest is JSON.
 *
 * Only the server holding the flows lock owns the incubator, since a stage
 * is a flow and only that server keeps flow records. Any other server (a
 * scratch or dev server on the same config dir) lists the owner's records
 * read-only and answers every write with 503.
 */
import { INPUT_TOTAL_MAX, inputsIndex, isSproutId } from "../core/sprout";
import { IncubatorError, type Incubator, type Intake, type IntakeFile } from "../core/incubator";
import type { Flow, Sprout, SproutDetail } from "../core/types";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (vs: readonly unknown[]): string[] => vs.filter((v): v is string => typeof v === "string");

/** a little over the inputs' cap, for the form's own framing */
const BODY_MAX = INPUT_TOTAL_MAX + 1024 * 1024;

export const NOT_OWNER = "another canopy owns the incubator";

export async function readIntake(req: Request): Promise<Intake> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("multipart/form-data")) throw new IncubatorError(415, "send a project as multipart/form-data");
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > BODY_MAX) throw new IncubatorError(413, "a project's inputs come to over 100 MB");
  const form = await req.formData().catch(() => null);
  if (!form) throw new IncubatorError(400, "the form could not be read");
  const files: IntakeFile[] = [];
  for (const v of [...form.getAll("file"), ...form.getAll("files[]")]) {
    if (typeof v === "string") continue;
    files.push({ label: v.name || "upload", type: v.type, data: new Uint8Array(await v.arrayBuffer()) });
  }
  const repo = form.get("repo");
  return {
    text: strings(form.getAll("text")).join("\n\n"),
    urls: strings([...form.getAll("url"), ...form.getAll("urls[]")]),
    files,
    ...(typeof repo === "string" && repo.trim() ? { repo } : {}),
    via: form.get("via") === "cli" ? "cli" : "sheet",
  };
}

const isAnswers = (v: unknown): v is Record<string, string> => isObj(v) && Object.values(v).every((x) => typeof x === "string");

export class IncubatorHub {
  /** true once this server holds the flows lock and has taken its sprouts back */
  private owner = false;

  constructor(
    readonly inc: Incubator,
    /** this root's records on disk, what a server without the lock lists */
    private readonly records: () => Promise<Sprout[]>,
  ) {}

  onFlow(flow: Flow): void {
    this.inc.onFlow(flow);
  }

  ownsFlow(flowId: string): boolean {
    return this.inc.ownsFlow(flowId);
  }

  /** only on the server holding the flows lock, after its flows are back */
  async restore(): Promise<void> {
    await this.inc.restore();
    this.owner = true;
  }

  detach(): void {
    this.inc.detach();
  }

  /** the owner's records as they are on disk, newest first */
  private async onDisk(): Promise<Sprout[]> {
    return (await this.records()).sort((a, b) => b.createdAt - a.createdAt);
  }

  private async readOnly(path: string, method: string, id: string): Promise<Response> {
    if (method !== "GET") return json({ error: NOT_OWNER }, 503);
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
    if (!this.owner) return this.readOnly(path, method, id);
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

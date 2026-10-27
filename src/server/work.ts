/** The work ledger's server half (FR-037): the items, minted at branch start,
 *  the lines the other hubs write on them, the derived state, the routes and
 *  the `work` event. The model is `core/work.ts`; the files are
 *  `core/workstore.ts`. Only the server holding the flows lock writes them
 *  (`adopt`), as with the landing records. */

import type { Run, ServerEvent } from "../core/types";
import { addNote, isWorkId, mintId, stateOf, WORK_STATES, type WorkFacts, type WorkInfo, type WorkItem, type WorkSink, type WorkStart, type WorkState } from "../core/work";
import { readWorkItems, workDir, writeWorkItem } from "../core/workstore";
import type { Caller } from "./callers";

export interface WorkDeps {
  broadcast: (ev: ServerEvent) => void;
  /** what the hubs know of an item's runs and branches, for its state */
  facts: (item: WorkItem) => WorkFacts;
  dir?: string;
  now?: () => number;
  /** the ids minted; `mintId()` unless a test says otherwise */
  mintId?: () => string;
}

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isWorkState = (value: string): value is WorkState => WORK_STATES.some((state) => state === value);

export class WorkHub implements WorkSink {
  private items = new Map<string, WorkItem>();
  private serial: Promise<void> = Promise.resolve();
  private keeping = false;

  constructor(private deps: WorkDeps) {}

  private get dir(): string {
    return this.deps.dir ?? workDir();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Every change derives state, keeps the item, queues its write and publishes the whole list. */
  private set(item: WorkItem, at = this.now()): WorkItem {
    const next: WorkItem = { ...item, state: stateOf(item, this.deps.facts(item)), updatedAt: at };
    this.items.set(next.id, next);
    if (this.keeping) this.persist(next);
    this.publish();
    return next;
  }

  private publish(): void {
    this.deps.broadcast({ type: "work", items: this.info().items });
  }

  private persist(item: WorkItem): void {
    const next = this.serial.then(() => writeWorkItem(this.dir, item)).catch((error: unknown) => {
      console.error(`work: could not write ${item.id}: ${errText(error)}`);
    });
    this.serial = next;
  }

  private missing(id: string, text: string): void {
    console.error(`work: no item ${id} for the line "${text}"`);
  }

  info(repo?: string, state?: WorkState): WorkInfo {
    const items = [...this.items.values()]
      .filter((item) => repo === undefined || item.repos.includes(repo))
      .filter((item) => state === undefined || item.state === state)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { items, archived: 0 };
  }

  get(id: string): WorkItem | undefined {
    return this.items.get(id);
  }

  mint(start: WorkStart & { repos: string[] }): WorkItem {
    const id = (this.deps.mintId ?? mintId)();
    if (!isWorkId(id)) throw new Error(`invalid work id: ${id}`);
    const at = this.now();
    return this.set({
      id,
      title: start.title,
      repos: [...start.repos],
      state: "open",
      from: start.from,
      runs: [],
      branches: [],
      prs: [],
      events: [],
      notes: [],
      createdAt: at,
      updatedAt: at,
    }, at);
  }

  note(id: string, text: string, by = "canopy"): void {
    const item = this.items.get(id);
    if (!item) {
      this.missing(id, text);
      return;
    }
    if (!text.trim()) return;
    const at = this.now();
    this.set({ ...item, notes: addNote(item.notes, { at, by, text }) }, at);
  }

  close(id: string, state: "landed" | "dropped", text: string, by = "canopy"): void {
    this.closeWithReason(id, state, text, text, by);
  }

  private closeWithReason(id: string, state: "landed" | "dropped", text: string, reason: string, by: string): void {
    const item = this.items.get(id);
    if (!item) {
      this.missing(id, text);
      return;
    }
    const at = this.now();
    const closed: WorkItem = {
      ...item,
      state,
      closedAt: at,
      ...(state === "dropped" ? { reason } : {}),
      notes: addNote(item.notes, { at, by, text }),
    };
    if (state === "landed") delete closed.reason;
    this.set(closed, at);
  }

  link(id: string, ref: { pr: { number: number; url: string } } | { event: string }): void {
    const item = this.items.get(id);
    if (!item) {
      this.missing(id, "event" in ref ? `trigger event ${ref.event}` : `PR #${ref.pr.number}`);
      return;
    }
    if ("pr" in ref) {
      if (item.prs.some((pr) => pr.number === ref.pr.number)) return;
      this.set({ ...item, prs: [...item.prs, ref.pr] });
      return;
    }
    if (item.events.includes(ref.event)) return;
    this.set({ ...item, events: [...item.events, ref.event] });
  }

  onRun(run: Run): void {
    const branch = run.branch;
    const id = branch?.work;
    if (!id || !branch) return;
    const item = this.items.get(id);
    if (!item) {
      this.missing(id, `run ${run.id}`);
      return;
    }
    this.set({
      ...item,
      runs: item.runs.includes(run.id) ? item.runs : [...item.runs, run.id],
      branches: item.branches.includes(branch.origin) ? item.branches : [...item.branches, branch.origin],
    });
  }

  recheck(): void {
    for (const item of this.items.values()) {
      if (item.closedAt !== undefined) continue;
      const state = stateOf(item, this.deps.facts(item));
      if (state !== item.state) this.set({ ...item, state });
    }
  }

  async adopt(): Promise<void> {
    const restored = await readWorkItems(this.dir);
    const pending = [...this.items.values()];
    const pendingIds = new Set(pending.map((item) => item.id));
    this.items = new Map(restored.map((item) => [item.id, item]));
    for (const item of pending) this.items.set(item.id, item);
    this.keeping = true;

    for (const item of this.items.values()) {
      const state = stateOf(item, this.deps.facts(item));
      if (pendingIds.has(item.id) || state !== item.state) this.set({ ...item, state });
    }
    this.publish();
  }

  detach(): void {
    this.keeping = false;
  }

  async idle(): Promise<void> {
    await this.serial;
  }

  async handle(req: Request, url: URL, caller: Caller | null): Promise<Response | null> {
    const path = url.pathname;
    if (path !== "/api/work" && !path.startsWith("/api/work/")) return null;

    if (req.method === "GET" && path === "/api/work") {
      const state = url.searchParams.get("state");
      if (state !== null && !isWorkState(state)) return json({ error: `state must be one of ${WORK_STATES.join(", ")}` }, 400);
      return json(this.info(url.searchParams.get("repo") || undefined, state ?? undefined));
    }

    if (req.method === "GET" && path === "/api/work/one") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id is required" }, 400);
      const item = this.get(id);
      return item ? json(item) : json({ error: "no work item by that id" }, 404);
    }

    if (req.method === "POST" && path === "/api/work/note") {
      const body = await this.body(req);
      if (!body || typeof body["id"] !== "string" || typeof body["text"] !== "string") return json({ error: "id and text are required" }, 400);
      const item = this.get(body["id"]);
      if (!item) return json({ error: "no work item by that id" }, 404);
      this.note(item.id, body["text"], caller?.label || "eric");
      return json(this.get(item.id) ?? item);
    }

    if (req.method === "POST" && path === "/api/work/close") {
      const body = await this.body(req);
      const state = body?.["state"];
      if (state !== "landed" && state !== "dropped") return json({ error: "state must be landed or dropped" }, 400);
      if (typeof body?.["id"] !== "string" || !body["id"]) return json({ error: "id is required" }, 400);
      const item = this.get(body["id"]);
      if (!item) return json({ error: "no work item by that id" }, 404);
      if (this.deps.facts(item).active) return json({ error: "a run on it is still going" }, 409);
      const givenReason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
      const line = `closed by hand as ${state}${givenReason ? `: ${givenReason}` : ""}`;
      this.closeWithReason(item.id, state, line, givenReason || line, caller?.label || "eric");
      return json(this.get(item.id) ?? item);
    }

    return json({ error: "not found" }, 404);
  }

  private async body(req: Request): Promise<Record<string, unknown> | null> {
    try {
      const body: unknown = await req.json();
      return isRecord(body) ? body : null;
    } catch {
      return null;
    }
  }
}

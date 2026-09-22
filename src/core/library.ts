import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./store";

const adapter = join(import.meta.dir, "../../lib/devhub/canopy.py");

export async function libraryArgs(root: string): Promise<string[]> {
  const canonical = await realpath(root);
  const id = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  return [adapter, "--root", canonical, "--state", join(configDir(), "library", id), "--"];
}

function python(): string {
  const bin = Bun.which("python3");
  if (!bin) throw new Error("Library features require Python 3.10 or newer. Install python3 and retry.");
  return bin;
}

export async function libraryCommand(root: string, args: string[]): Promise<number> {
  const child = Bun.spawn([python(), ...await libraryArgs(root), ...args], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  return child.exited;
}

/** Whether a request's host is one the tailnet edge vouches for: a tailnet
 *  address literal (100.64.0.0/10), a MagicDNS name (`*.ts.net`, or a bare
 *  machine name with no dots, which no public resolver can point elsewhere).
 *  A dotted public name is not, since an attacker's domain could resolve to
 *  the same address (DNS rebinding) and carry a matching Origin. */
export function tailnetHost(hostname: string): boolean {
  const ip = /^100\.(\d+)\.\d+\.\d+$/.exec(hostname);
  if (ip) {
    const second = Number(ip[1]);
    return second >= 64 && second <= 127;
  }
  return hostname.endsWith(".ts.net") || (!hostname.includes(".") && hostname.length > 0);
}

/** Public access is opt-in for one HTTPS origin behind an authenticated reverse
 * proxy. Forwarded protocol is trusted only because Bun binds to loopback.
 * `open` is the shared-backend case: the server was told to listen beyond
 * loopback (`CANOPY_BIND`) because the tailnet is the trust edge, so a
 * same-origin request by a tailnet name is as good as one by localhost. */
export function libraryOriginAllowed(req: Request, publicOrigin?: string, open = false): boolean {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  if (local && (!origin || origin === url.origin)) return true;
  if (open && tailnetHost(url.hostname) && (!origin || origin === url.origin)) return true;
  if (!publicOrigin) return false;
  try {
    const configured = new URL(publicOrigin);
    return configured.protocol === "https:" && configured.origin === publicOrigin &&
      url.host === configured.host && req.headers.get("x-forwarded-proto") === "https" &&
      (!origin || origin === configured.origin);
  } catch {
    return false;
  }
}

/** whether the server listens beyond loopback: `CANOPY_BIND` names an address
 *  that is not a loopback one */
export function openBind(bind = process.env["CANOPY_BIND"]): boolean {
  return !!bind && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(bind);
}

/** One lazy, authenticated library worker per Canopy server. No separate setup,
 *  fixed helper port, source checkout, or macOS LaunchAgent is required. */
export class Library {
  private pending: Promise<number> | null = null;
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private token = randomBytes(32).toString("hex");
  private stopped = false;
  private error = "";

  constructor(
    private root: string,
    private publicOrigin = process.env["CANOPY_PUBLIC_ORIGIN"],
    private open = openBind(),
  ) {}

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
    this.pending = null;
  }

  private start(): Promise<number> {
    if (this.stopped) return Promise.reject(new Error("Library stopped"));
    if (this.pending) return this.pending;
    this.pending = this.launch().catch((error: unknown) => {
      this.pending = null;
      this.child?.kill();
      this.child = null;
      throw error;
    });
    return this.pending;
  }

  private async launch(): Promise<number> {
    const argv = [python(), "-u", ...await libraryArgs(this.root), "__serve"];
    if (this.stopped) throw new Error("Library stopped");
    const child = Bun.spawn(argv, {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, CANOPY_LIBRARY_TOKEN: this.token, PYTHONDONTWRITEBYTECODE: "1" },
    });
    this.child = child;
    this.error = "";
    void (async () => {
      for await (const bytes of child.stderr) {
        this.error = (this.error + new TextDecoder().decode(bytes)).slice(-4000);
      }
    })().catch(() => {});
    return new Promise<number>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error("Library scan timed out. Retry or use a smaller workspace folder."));
      }, 180_000);
      void (async () => {
        let buffer = "";
        for await (const bytes of child.stdout) {
          buffer += new TextDecoder().decode(bytes);
          const match = buffer.match(/CANOPY_LIBRARY_READY (\d+)\n/);
          if (!ready && match?.[1]) {
            ready = true;
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
          buffer = buffer.slice(-4000);
        }
      })().catch(reject);
      void child.exited.then((code) => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          this.pending = null;
        }
        if (!ready) reject(new Error(this.error.trim() || `Library exited (${code})`));
      });
    });
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!libraryOriginAllowed(req, this.publicOrigin, this.open)) {
      return Response.json({ error: "Foreign origin" }, { status: 403 });
    }
    if (!["GET", "POST"].includes(req.method)) {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    try {
      const port = await this.start();
      if (url.pathname === "/api/library") return Response.json({ ready: true, root: this.root });
      const path = url.pathname.replace(/^\/library(?=\/|$)/, "") || "/";
      const headers = new Headers({ "X-Canopy-Library": this.token });
      if (req.headers.has("content-type")) headers.set("Content-Type", req.headers.get("content-type")!);
      const response = await fetch(`http://127.0.0.1:${port}${path}${url.search}`, {
        method: req.method, headers,
        ...(req.method === "POST" ? { body: await req.arrayBuffer() } : {}),
        signal: AbortSignal.timeout(180_000), redirect: "manual",
      });
      const outputHeaders = new Headers({
        "Content-Type": response.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
        "X-Frame-Options": "SAMEORIGIN",
      });
      return new Response(response.body, { status: response.status, headers: outputHeaders });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
    }
  }
}

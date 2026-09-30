import { describe, expect, test } from "bun:test";
import { LineSplitter, parseMessage, RpcClient, RpcClosed, RpcError, stderrTail, type RpcProc } from "./codexrpc";

/** A child process made of in-memory pipes: `emit` writes what the server
 *  would print, `sent` is what the client wrote, `exit` ends it. */
function fakeProc() {
  const enc = new TextEncoder();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  let exited!: (code: number | null) => void;
  const sent: Record<string, unknown>[] = [];
  let partial = "";
  let ended = false;
  let killed = false;
  const proc: RpcProc = {
    stdin: {
      write(chunk: string) {
        partial += chunk;
        let nl = partial.indexOf("\n");
        while (nl !== -1) {
          sent.push(JSON.parse(partial.slice(0, nl)) as Record<string, unknown>);
          partial = partial.slice(nl + 1);
          nl = partial.indexOf("\n");
        }
      },
      end() {
        ended = true;
      },
    },
    stdout: new ReadableStream<Uint8Array>({ start: (c) => void (out = c) }),
    stderr: new ReadableStream<Uint8Array>({ start: (c) => void (err = c) }),
    exited: new Promise((res) => (exited = res)),
    kill() {
      killed = true;
    },
  };
  return {
    proc,
    sent,
    get ended() {
      return ended;
    },
    get killed() {
      return killed;
    },
    emit: (text: string) => out.enqueue(enc.encode(text)),
    emitBytes: (bytes: Uint8Array) => out.enqueue(bytes),
    stderr: (text: string) => err.enqueue(enc.encode(text)),
    exit(code: number | null) {
      out.close();
      err.close();
      exited(code);
    },
  };
}

const tick = () => Bun.sleep(5);

describe("the line framing", () => {
  test("a line split across chunks comes out whole, once", () => {
    const s = new LineSplitter();
    expect(s.push('{"id":1,"res')).toEqual([]);
    expect(s.push('ult":{}}\n{"method":"a"}\n{"meth')).toEqual(['{"id":1,"result":{}}', '{"method":"a"}']);
    expect(s.push('od":"b"}\r\n')).toEqual(['{"method":"b"}']);
    expect(s.flush()).toEqual([]);
  });

  test("a character split across byte chunks survives, and a last line without a newline is kept", () => {
    const s = new LineSplitter();
    const bytes = new TextEncoder().encode('{"t":"é"}\n{"t":"z"}');
    const cut = bytes.indexOf(0xc3) + 1; // inside the two bytes of é
    expect(s.push(bytes.slice(0, cut))).toEqual([]);
    expect(s.push(bytes.slice(cut))).toEqual(['{"t":"é"}']);
    expect(s.flush()).toEqual(['{"t":"z"}']);
  });
});

describe("message classification", () => {
  test("requests, notifications, results and errors, with or without jsonrpc", () => {
    expect(parseMessage('{"id":0,"method":"item/tool/requestUserInput","params":{"a":1}}')).toEqual({
      kind: "request",
      id: 0,
      method: "item/tool/requestUserInput",
      params: { a: 1 },
    });
    expect(parseMessage('{"method":"turn/started","params":{},"emittedAtMs":5}')).toEqual({
      kind: "notification",
      method: "turn/started",
      params: {},
    });
    expect(parseMessage('{"jsonrpc":"2.0","id":3,"result":null}')).toEqual({ kind: "response", id: 3, result: null });
    expect(parseMessage('{"id":"x","error":{"code":-32600,"message":"bad","data":{"k":1}}}')).toEqual({
      kind: "error",
      id: "x",
      code: -32600,
      message: "bad",
      data: { k: 1 },
    });
  });

  test("anything else is not a message", () => {
    for (const line of ["", "WARNING: failed to clean up", "[1,2]", '{"id":1}', '{"result":1}', "{broken"]) {
      expect(parseMessage(line)).toBeNull();
    }
  });

  test("stderr loses its colour codes and keeps its end", () => {
    expect(stderrTail("\x1b[2m2026\x1b[0m \x1b[31mERROR\x1b[0m boom\n")).toBe("2026 ERROR boom");
    expect(stderrTail("abcdef", 3)).toBe("def");
  });
});

describe("the client", () => {
  test("answers are matched by id, in any order, and errors reject with the server's words", async () => {
    const f = fakeProc();
    const rpc = new RpcClient(f.proc);
    const a = rpc.request("thread/start", { cwd: "/r" });
    const b = rpc.request("turn/start");
    expect(f.sent).toEqual([
      { id: 1, method: "thread/start", params: { cwd: "/r" } },
      { id: 2, method: "turn/start" },
    ]);
    f.emit('{"id":2,"result":{"turn":{"id":"t"}}}\n{"id":1,"error":{"code":-32600,"message":"no such model"}}\n');
    expect(await b).toEqual({ turn: { id: "t" } });
    const err = await a.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).message).toBe("no such model");
    expect((err as RpcError).code).toBe(-32600);
    expect((err as RpcError).method).toBe("thread/start");
    f.exit(0);
    await rpc.done;
  });

  test("notifications go to their handler; a notification carries no id", async () => {
    const f = fakeProc();
    const rpc = new RpcClient(f.proc);
    const got: [string, unknown][] = [];
    rpc.onNotification((m, p) => got.push([m, p]));
    rpc.notify("initialized");
    expect(f.sent).toEqual([{ method: "initialized" }]);
    f.emit('{"method":"item/started","params":{"item":{"id":"i"}}}\nnot json\n{"method":"turn/com');
    f.emit('pleted","params":{}}\n');
    await tick();
    expect(got).toEqual([
      ["item/started", { item: { id: "i" } }],
      ["turn/completed", {}],
    ]);
    f.exit(0);
    await rpc.done;
  });

  test("a server request under id 0 is answered under id 0, with a result or an error", async () => {
    const f = fakeProc();
    const rpc = new RpcClient(f.proc);
    rpc.onRequest((req) => {
      if (req.method === "item/commandExecution/requestApproval") rpc.reply(req.id, { decision: "accept" });
      else rpc.replyError(req.id, -32000, "no");
    });
    f.emit('{"id":0,"method":"item/commandExecution/requestApproval","params":{}}\n{"id":1,"method":"other","params":{}}\n');
    await tick();
    expect(f.sent).toEqual([
      { id: 0, result: { decision: "accept" } },
      { id: 1, error: { code: -32000, message: "no" } },
    ]);
    f.exit(0);
    await rpc.done;
  });

  test("without a request handler the server is told the method is not handled, not left waiting", async () => {
    const f = fakeProc();
    const rpc = new RpcClient(f.proc);
    f.emit('{"id":7,"method":"attestation/generate","params":{}}\n');
    await tick();
    expect(f.sent).toEqual([{ id: 7, error: { code: -32601, message: "canopy does not handle attestation/generate" } }]);
    f.exit(0);
    await rpc.done;
  });

  test("a handler that throws answers an internal error and the read loop goes on", async () => {
    const f = fakeProc();
    const rpc = new RpcClient(f.proc);
    const seen: string[] = [];
    rpc.onRequest(() => {
      throw new Error("bug");
    });
    rpc.onNotification((m) => {
      seen.push(m);
      throw new Error("also a bug");
    });
    f.emit('{"id":0,"method":"x","params":{}}\n{"method":"a"}\n{"method":"b"}\n');
    await tick();
    expect(f.sent).toEqual([{ id: 0, error: { code: -32603, message: "bug" } }]);
    expect(seen).toEqual(["a", "b"]);
    f.exit(0);
    await rpc.done;
  });

  test("an exit rejects what still waits, with the code and the stderr tail", async () => {
    const f = fakeProc();
    const rpc = new RpcClient(f.proc);
    const pending = rpc.request("turn/start", {});
    f.stderr("\x1b[31mERROR\x1b[0m not signed in\n");
    f.exit(3);
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcClosed);
    expect((err as RpcClosed).code).toBe(3);
    expect((err as RpcClosed).stderr).toBe("ERROR not signed in");
    expect(await rpc.done).toEqual({ code: 3, stderr: "ERROR not signed in" });
    expect(rpc.closed).toBe(true);
    // after the end, a request fails at once rather than hanging
    expect(await rpc.request("turn/start").catch((e: unknown) => e)).toBeInstanceOf(RpcClosed);
  });

  test("end closes stdin and kill kills", async () => {
    const f = fakeProc();
    const rpc = new RpcClient(f.proc);
    rpc.end();
    expect(f.ended).toBe(true);
    rpc.kill();
    expect(f.killed).toBe(true);
    f.exit(null);
    expect((await rpc.done).code).toBeNull();
  });
});

// The adapter against fakes of the two browser APIs it uses (XMLHttpRequest,
// fetch), installed on globalThis: no injection in production code.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BackendError, type ConvertEvents, type ErrorKind, type LogEntry, type Phase } from "../backend.js";
import { createBackend, kindFor } from "./vd-oprezer.js";

const BASE = "https://h.example/api";
const ID = "9f1c";
const KEY = "s3cret";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const job = (fields: Record<string, unknown> = {}) => ({ id: ID, status: "queued", filename: "clip-web.mp4", progress: 0, createdAt: "t", ...fields });

class FakeXHR {
  static last: FakeXHR | undefined;
  method = "";
  url = "";
  body: unknown;
  aborted = false;
  status = 0;
  responseText = "";
  headers: Record<string, string> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  send(body: unknown) {
    this.body = body;
    FakeXHR.last = this;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  // Test controls:
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true });
  }
  respond(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
  fail() {
    this.onerror?.();
  }
}

/** A text/event-stream body the test writes to. Like real fetch, aborting the request's signal errors it. */
class FakeStream {
  static all: FakeStream[] = [];
  private cancelled = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly response: Response;

  constructor(readonly init?: RequestInit) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
    const signal = init?.signal;
    signal?.addEventListener("abort", () => this.controller.error(signal.reason), { once: true });
    this.response = new Response(body, { headers: { "content-type": "text/event-stream" } });
    FakeStream.all.push(this);
  }
  /** The adapter is done with it: it cancelled the body or aborted the request. */
  get closed() {
    return this.cancelled || Boolean(this.init?.signal?.aborted);
  }
  // Test controls:
  emit(type: string, data: unknown) {
    this.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  write(text: string) {
    this.controller.enqueue(new TextEncoder().encode(text));
  }
  /** The server (shutting down) or a proxy (timeout) ended the stream before the job finished. */
  end() {
    this.controller.close();
  }
}

let calls: { method: string; url: string; init?: RequestInit }[];
let routes: Map<string, (init?: RequestInit) => Response>;
const originals = { XMLHttpRequest: globalThis.XMLHttpRequest, fetch: globalThis.fetch };
const EVENTS = `GET ${BASE}/jobs/${ID}/events`;

beforeEach(() => {
  calls = [];
  routes = new Map<string, (init?: RequestInit) => Response>([
    [`GET ${BASE}/jobs/${ID}/output`, () => new Response("abcd")],
    [`DELETE ${BASE}/jobs/${ID}`, () => new Response(null, { status: 204 })],
    [EVENTS, (init) => new FakeStream(init).response],
  ]);
  FakeXHR.last = undefined;
  FakeStream.all = [];
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push({ method, url, init });
    if (init?.signal?.aborted) throw init.signal.reason;
    const route = routes.get(`${method} ${url}`);
    if (!route) throw new TypeError("fetch failed");
    return route(init);
  };
});

afterEach(() => Object.assign(globalThis, originals));

/** Starts a conversion; the result promise is pre-handled so a rejection waits for its assert. */
function start(signal = new AbortController().signal, key?: string) {
  const phases: [Phase, number | undefined][] = [];
  const logs: LogEntry[] = [];
  const events: ConvertEvents = { progress: (phase, fraction) => phases.push([phase, fraction]), log: (entry) => logs.push(entry) };
  const result = createBackend(`${BASE}/`, key).convert(new File(["video"], "clip.mov"), "web", events, signal);
  result.catch(() => {});
  return { result, phases, logs };
}

/** Starts a conversion and gets it past the upload, watching the event stream. */
async function toStream(signal?: AbortSignal) {
  const run = start(signal);
  FakeXHR.last!.respond(202, JSON.stringify(job()));
  await tick();
  return { ...run, stream: FakeStream.all.at(-1)! };
}

const kind = (expected: ErrorKind, message?: string) => (error: unknown) =>
  error instanceof BackendError && error.kind === expected && (message === undefined || error.message === message);

const deleted = () => calls.some((c) => c.method === "DELETE" && c.url === `${BASE}/jobs/${ID}`);

describe("presets", () => {
  it("GETs <base>/presets, keeping a path prefix, with labels made from ids", async () => {
    routes.set(`GET ${BASE}/presets`, () => Response.json({ web: { description: "W" }, "instagram-reel": { description: "R" } }));
    const presets = await createBackend(`${BASE}/`).presets();
    assert.equal(calls[0]?.url, `${BASE}/presets`);
    assert.deepEqual(presets, [
      { id: "web", label: "Web", description: "W" },
      { id: "instagram-reel", label: "Instagram reel", description: "R" },
    ]);
  });

  it("rejects with a BackendError when the server can't be reached", async () => {
    await assert.rejects(createBackend(BASE).presets(), kind("unreachable"));
    routes.set(`GET ${BASE}/presets`, () => new Response("<html>Bad Gateway</html>", { status: 502 }));
    await assert.rejects(createBackend(BASE).presets(), kind("unreachable", "HTTP 502"));
  });
});

describe("kindFor", () => {
  it("maps HTTP statuses and error codes to error kinds", () => {
    assert.equal(kindFor(413), "too_large");
    assert.equal(kindFor(503, "QUEUE_FULL"), "busy");
    assert.equal(kindFor(503, "FFMPEG_NOT_FOUND"), "failed");
    assert.equal(kindFor(422), "unsupported");
    assert.equal(kindFor(400), "rejected");
    assert.equal(kindFor(404), "expired");
    for (const status of [0, 502, 504]) assert.equal(kindFor(status), "unreachable");
    assert.equal(kindFor(401), "unauthorized");
    assert.equal(kindFor(500), "failed");
  });
});

describe("convert", () => {
  it("uploads, follows the job, downloads the result, then deletes the job", async () => {
    const { result, phases, logs } = start();
    const xhr = FakeXHR.last!;
    assert.equal(xhr.method, "POST");
    assert.equal(xhr.url, `${BASE}/jobs`);
    const form = xhr.body as FormData;
    assert.deepEqual([...form.keys()], ["preset", "file"]);
    assert.equal(form.get("preset"), "web");
    assert.ok(form.get("file") instanceof File);

    xhr.progress(5, 10);
    xhr.respond(202, JSON.stringify(job()));
    await tick();
    const stream = FakeStream.all.at(-1)!;
    assert.ok(calls.some((c) => `${c.method} ${c.url}` === EVENTS));
    stream.write(": keep-alive\n\n");
    stream.emit("job", job());
    stream.emit("job", job({ status: "running", progress: 50 }));
    stream.emit("job", job({ status: "done", progress: 100, sizeBytes: 4 }));

    const { blob, filename } = await result;
    assert.equal(blob.size, 4);
    assert.equal(filename, "clip-web.mp4");
    await tick();
    assert.equal(stream.closed, true);
    assert.deepEqual(phases, [
      ["uploading", 0.5],
      ["queued", undefined],
      ["converting", 0.5],
      ["downloading", 0],
      ["downloading", 1],
    ]);
    assert.deepEqual(
      logs.slice(0, 5).map((l) => l.label),
      ["POST /jobs", "job queued", "job running 50%", "job done", `GET /jobs/${ID}/output`],
    );
    assert.equal(calls.at(-1)?.method, "DELETE");
    assert.equal(calls.at(-1)?.url, `${BASE}/jobs/${ID}`);
  });

  it("rejects upload errors with the right kind, including proxy HTML pages", async () => {
    let run = start();
    FakeXHR.last!.respond(502, "<html>Bad Gateway</html>");
    await assert.rejects(run.result, kind("unreachable", "HTTP 502"));

    run = start();
    FakeXHR.last!.respond(413, JSON.stringify({ error: "FST_REQ_FILE_TOO_LARGE", message: "request file too large" }));
    await assert.rejects(run.result, kind("too_large", "request file too large"));

    run = start();
    FakeXHR.last!.respond(503, JSON.stringify({ error: "QUEUE_FULL", message: "Too many encodes waiting; try again later." }));
    await assert.rejects(run.result, kind("busy"));

    run = start();
    FakeXHR.last!.respond(401, JSON.stringify({ error: "UNAUTHORIZED", message: "Missing or wrong key." }));
    await assert.rejects(run.result, kind("unauthorized"));

    run = start();
    FakeXHR.last!.fail();
    await assert.rejects(run.result, kind("unreachable"));
    assert.equal(FakeStream.all.length, 0);
  });

  it("maps a failed job, a rejected input and a deleted job", async () => {
    let run = await toStream();
    run.stream.emit("job", job({ status: "failed", error: { code: "FFMPEG_FAILED", message: "Encoding failed." } }));
    await assert.rejects(run.result, kind("failed"));
    await tick();
    assert.equal(run.stream.closed, true);

    // Jobs probe the upload after the 202, so an unreadable file arrives as a job error, not a 422.
    run = await toStream();
    run.stream.emit("job", job({ status: "failed", error: { code: "PROBE_FAILED", message: "The upload is not a readable video file." } }));
    await assert.rejects(run.result, kind("unsupported"));

    const reason = 'Input is 2.1s long; "instagram-reel" accepts 3s to 900s.';
    run = await toStream();
    run.stream.emit("job", job({ status: "failed", error: { code: "INVALID_ARGUMENT", message: reason } }));
    await assert.rejects(run.result, kind("rejected", reason));

    run = await toStream();
    run.stream.emit("deleted", { id: ID });
    await assert.rejects(run.result, kind("expired"));
    await tick();
    assert.equal(run.stream.closed, true);
  });

  it("a refused stream is final: 404 expired, 401 unauthorized, a proxy's 502 unreachable (job deleted)", async () => {
    const refused = async (response: () => Response, expected: ErrorKind) => {
      routes.set(EVENTS, response);
      const run = start();
      FakeXHR.last!.respond(202, JSON.stringify(job()));
      await assert.rejects(run.result, kind(expected));
      assert.ok(run.logs.some((l) => l.label === `GET /jobs/${ID}/events` && l.status === response().status));
    };
    await refused(() => Response.json({ error: "NOT_FOUND", message: "No such job (finished jobs expire)." }, { status: 404 }), "expired");
    await refused(() => Response.json({ error: "UNAUTHORIZED", message: "Missing or wrong key." }, { status: 401 }), "unauthorized");
    assert.equal(deleted(), false);
    await refused(() => new Response("<html>Bad Gateway</html>", { status: 502 }), "unreachable");
    assert.equal(deleted(), true);
  });

  it("a network drop during the download is unreachable, and the job is deleted", async () => {
    routes.set(`GET ${BASE}/jobs/${ID}/output`, () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.error(new TypeError("network error"));
        },
      });
      return new Response(body);
    });
    const run = await toStream();
    run.stream.emit("job", job({ status: "done", progress: 100, sizeBytes: 4 }));
    await assert.rejects(run.result, kind("unreachable"));
    assert.equal(deleted(), true);
  });

  it("reconnects a dropped stream; 30 s without a connection → unreachable + DELETE", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const run = await toStream();
    let settled = false;
    run.result.then(
      () => (settled = true),
      () => (settled = true),
    );
    const wait = async (ms: number) => {
      for (let i = 0; i < ms / 1000; i++) {
        t.mock.timers.tick(1000);
        await tick();
      }
    };

    run.stream.end(); // e.g. a proxy timeout
    await tick();
    await wait(1000);
    assert.equal(FakeStream.all.length, 2, "reconnected");
    FakeStream.all[1]!.emit("job", job({ status: "running", progress: 10 }));
    await tick();
    assert.deepEqual(run.phases.at(-1), ["converting", 0.1]);

    routes.delete(EVENTS); // the server is gone: every reconnect fails
    FakeStream.all[1]!.end();
    await tick();
    await wait(29_000);
    assert.equal(settled, false);
    await wait(1000);
    assert.equal(settled, true, "gives up 30 s after the drop");
    await assert.rejects(run.result, kind("unreachable"));
    assert.deepEqual(
      run.logs.filter((l) => l.label.startsWith("stream")).map((l) => l.label),
      ["stream reconnecting", "stream reconnecting", "stream lost"],
    );
    assert.equal(deleted(), true);
  });

  it("abort while uploading: aborts the upload, sends no DELETE (no job yet)", async () => {
    const controller = new AbortController();
    const run = start(controller.signal);
    controller.abort();
    await assert.rejects(run.result, { name: "AbortError" });
    assert.equal(FakeXHR.last!.aborted, true);
    assert.equal(calls.some((c) => c.method === "DELETE"), false);
  });

  it("abort while converting: closes the stream and deletes the job", async () => {
    const controller = new AbortController();
    const run = await toStream(controller.signal);
    controller.abort();
    await assert.rejects(run.result, { name: "AbortError" });
    assert.equal(run.stream.closed, true);
    assert.equal(deleted(), true);
  });

  it("abort while waiting to reconnect: stops retrying and deletes the job", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const controller = new AbortController();
    const run = await toStream(controller.signal);
    run.stream.end();
    await tick();
    controller.abort();
    await assert.rejects(run.result, { name: "AbortError" });
    t.mock.timers.tick(5_000);
    await tick();
    assert.equal(FakeStream.all.length, 1, "no reconnect after the abort");
    assert.equal(deleted(), true);
  });

  it("sends the key on every request when it has one, and none otherwise", async () => {
    const auth = (headers?: HeadersInit) => new Headers(headers).get("authorization");
    routes.set(`GET ${BASE}/presets`, () => Response.json({}));
    await createBackend(BASE, KEY).presets();
    assert.equal(auth(calls[0]?.init?.headers), `Bearer ${KEY}`);

    const { result } = start(undefined, KEY);
    assert.equal(FakeXHR.last!.headers.authorization, `Bearer ${KEY}`);
    FakeXHR.last!.respond(202, JSON.stringify(job()));
    await tick();
    FakeStream.all[0]!.emit("job", job({ status: "done", progress: 100, sizeBytes: 4 }));
    await result;
    await tick();
    const sent = calls.slice(1).map((c) => [`${c.method} ${c.url.slice(BASE.length)}`, auth(c.init?.headers)]);
    assert.deepEqual(sent, [
      [`GET /jobs/${ID}/events`, `Bearer ${KEY}`],
      [`GET /jobs/${ID}/output`, `Bearer ${KEY}`],
      [`DELETE /jobs/${ID}`, `Bearer ${KEY}`],
    ]);

    calls = [];
    await createBackend(BASE).presets();
    assert.equal(auth(calls[0]?.init?.headers), null);
    start();
    assert.deepEqual(FakeXHR.last!.headers, {});
  });

  it("rejects at once when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(start(controller.signal).result, { name: "AbortError" });
    assert.equal(FakeXHR.last, undefined);
  });
});

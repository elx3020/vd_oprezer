// The adapter against fakes of the three browser APIs it uses (XMLHttpRequest,
// EventSource, fetch), installed on globalThis: no injection in production code.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BackendError, type ConvertEvents, type ErrorKind, type LogEntry, type Phase } from "../backend.js";
import { createBackend, kindFor } from "./vd-oprezer.js";

const BASE = "https://h.example/api";
const ID = "9f1c";
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
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
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

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: FakeEventSource | undefined;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  // Test controls:
  emit(type: string, data?: unknown) {
    if (type === "open") this.readyState = FakeEventSource.OPEN;
    for (const listener of this.listeners.get(type) ?? []) listener({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
  /** Connection dropped: EventSource retries by itself. */
  drop() {
    this.readyState = FakeEventSource.CONNECTING;
    this.emit("error");
  }
  /** Non-200 answer (404): EventSource gives up for good. */
  gone() {
    this.readyState = FakeEventSource.CLOSED;
    this.emit("error");
  }
}

let calls: { method: string; url: string; init?: RequestInit }[];
let routes: Map<string, () => Response>;
const originals = { XMLHttpRequest: globalThis.XMLHttpRequest, EventSource: globalThis.EventSource, fetch: globalThis.fetch };

beforeEach(() => {
  calls = [];
  routes = new Map([
    [`GET ${BASE}/jobs/${ID}/output`, () => new Response("abcd")],
    [`DELETE ${BASE}/jobs/${ID}`, () => new Response(null, { status: 204 })],
  ]);
  FakeXHR.last = undefined;
  FakeEventSource.last = undefined;
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push({ method, url, init });
    if (init?.signal?.aborted) throw init.signal.reason;
    const route = routes.get(`${method} ${url}`);
    if (!route) throw new TypeError("fetch failed");
    return route();
  };
});

afterEach(() => Object.assign(globalThis, originals));

/** Starts a conversion; the result promise is pre-handled so a rejection waits for its assert. */
function start(signal = new AbortController().signal) {
  const phases: [Phase, number | undefined][] = [];
  const logs: LogEntry[] = [];
  const events: ConvertEvents = { progress: (phase, fraction) => phases.push([phase, fraction]), log: (entry) => logs.push(entry) };
  const result = createBackend(`${BASE}/`).convert(new File(["video"], "clip.mov"), "web", events, signal);
  result.catch(() => {});
  return { result, phases, logs };
}

/** Starts a conversion and gets it past the upload, watching the event stream. */
async function toStream(signal?: AbortSignal) {
  const run = start(signal);
  FakeXHR.last!.respond(202, JSON.stringify(job()));
  await tick();
  return { ...run, stream: FakeEventSource.last! };
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
    const stream = FakeEventSource.last!;
    assert.equal(stream.url, `${BASE}/jobs/${ID}/events`);
    stream.emit("open");
    stream.emit("job", job());
    stream.emit("job", job({ status: "running", progress: 50 }));
    stream.emit("job", job({ status: "done", progress: 100, sizeBytes: 4 }));

    const { blob, filename } = await result;
    assert.equal(blob.size, 4);
    assert.equal(filename, "clip-web.mp4");
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
    FakeXHR.last!.fail();
    await assert.rejects(run.result, kind("unreachable"));
    assert.equal(FakeEventSource.last, undefined);
  });

  it("maps a failed job, a rejected input, a deleted job and a 404 stream", async () => {
    let run = await toStream();
    run.stream.emit("job", job({ status: "failed", error: { code: "FFMPEG_FAILED", message: "Encoding failed." } }));
    await assert.rejects(run.result, kind("failed"));
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
    assert.equal(run.stream.closed, true);

    routes.set(`GET ${BASE}/jobs/${ID}`, () => Response.json({ error: "NOT_FOUND", message: "No such job (finished jobs expire)." }, { status: 404 }));
    run = await toStream();
    run.stream.gone();
    await assert.rejects(run.result, kind("expired"));
    assert.equal(run.stream.closed, true);
  });

  it("a refused stream asks the job why: a proxy's 502 means unreachable, not expired", async () => {
    routes.set(`GET ${BASE}/jobs/${ID}`, () => new Response("<html>Bad Gateway</html>", { status: 502 }));
    const run = await toStream();
    run.stream.gone();
    await assert.rejects(run.result, kind("unreachable", "HTTP 502"));
    assert.equal(run.stream.closed, true);
    assert.ok(run.logs.some((l) => l.label === `GET /jobs/${ID}` && l.status === 502));
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

  it("waits for a dropped stream to reconnect; 30 s without reconnecting → unreachable + DELETE", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const run = await toStream();
    let settled = false;
    run.result.then(
      () => (settled = true),
      () => (settled = true),
    );

    run.stream.drop();
    t.mock.timers.tick(29_000);
    run.stream.emit("open"); // reconnected in time
    t.mock.timers.tick(5_000);
    await tick();
    assert.equal(settled, false);

    run.stream.drop();
    t.mock.timers.tick(20_000);
    run.stream.drop(); // another failed retry doesn't restart the clock
    t.mock.timers.tick(10_000);
    await tick();
    assert.equal(settled, true, "gives up 30 s after the first drop");
    await assert.rejects(run.result, kind("unreachable"));
    assert.equal(run.stream.closed, true);
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

  it("rejects at once when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(start(controller.signal).result, { name: "AbortError" });
    assert.equal(FakeXHR.last, undefined);
  });
});

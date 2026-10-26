// Adapter for vd-oprezer's HTTP API (docs/DECISIONS.md, 6–8 and 11):
// POST /jobs, GET /jobs/:id/events (SSE), GET /jobs/:id/output, DELETE /jobs/:id.
import { BackendError, type ConvertEvents, type CreateBackend, type ErrorKind } from "../backend.js";

/** The server's Job, as far as this adapter reads it. */
interface Job {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  filename: string;
  progress: number;
  sizeBytes?: number;
  error?: { code: string; message: string };
}

/** Job error codes that mean something to visitors; the rest are "failed". Jobs probe after the 202, so these arrive in the job, not as HTTP statuses. */
const JOB_ERRORS: Record<string, ErrorKind> = { INVALID_ARGUMENT: "rejected", PROBE_FAILED: "unsupported" };

/** A dropped event stream that hasn't reconnected by then counts as lost. */
const RECONNECT_MS = 30_000;

export function kindFor(status: number, code?: string): ErrorKind {
  switch (status) {
    case 413:
      return "too_large";
    case 503:
      return code === "QUEUE_FULL" ? "busy" : "failed";
    case 422:
      return "unsupported";
    case 400:
      return "rejected";
    case 404:
      return "expired";
    case 0:
    case 502:
    case 504:
      return "unreachable";
    default:
      return "failed";
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The server answers { error, message }; a proxy in front of it may answer an HTML page. */
function httpError(status: number, text: string): BackendError {
  const body = parse(text) as { error?: unknown; message?: unknown } | undefined;
  const code = typeof body?.error === "string" ? body.error : undefined;
  const message = typeof body?.message === "string" ? body.message : `HTTP ${status}`;
  return new BackendError(kindFor(status, code), message);
}

const since = (start: number) => Math.round(performance.now() - start);

/** "instagram-reel" → "Instagram reel" */
function label(id: string): string {
  const words = id.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const createBackend: CreateBackend = (baseUrl) => {
  // Joined as strings, not new URL(path, base), so a path prefix (https://host/api/) survives.
  const url = (path: string) => baseUrl.replace(/\/+$/, "") + path;

  /** fetch that turns network errors and non-2xx answers into BackendErrors, logging failures. */
  async function request(path: string, init: RequestInit = {}, events?: ConvertEvents): Promise<Response> {
    const method = init.method ?? "GET";
    const start = performance.now();
    let res: Response;
    try {
      res = await fetch(url(path), init);
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
      events?.log({ label: `${method} ${path}`, status: "network error", ms: since(start) });
      throw new BackendError("unreachable", (error as Error).message);
    }
    if (res.ok) return res;
    const text = await res.text();
    events?.log({ label: `${method} ${path}`, status: res.status, ms: since(start), data: parse(text) ?? text });
    throw httpError(res.status, text);
  }

  function upload(file: File, presetId: string, events: ConvertEvents, signal: AbortSignal): Promise<Job> {
    const body = new FormData();
    body.append("preset", presetId);
    body.append("file", file);
    // XMLHttpRequest, not fetch: fetch can't report upload progress.
    const xhr = new XMLHttpRequest();
    const start = performance.now();
    return new Promise((resolve, reject) => {
      const onAbort = () => xhr.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const settle = () => signal.removeEventListener("abort", onAbort);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) events.progress("uploading", e.loaded / e.total);
      };
      xhr.onload = () => {
        settle();
        const job = parse(xhr.responseText) as Job | undefined;
        events.log({ label: "POST /jobs", status: xhr.status, ms: since(start), data: job ?? xhr.responseText });
        if (xhr.status >= 200 && xhr.status < 300 && job?.id) resolve(job);
        else reject(httpError(xhr.status, xhr.responseText));
      };
      xhr.onerror = () => {
        settle();
        events.log({ label: "POST /jobs", status: "network error", ms: since(start) });
        reject(new BackendError("unreachable", "Network error during the upload."));
      };
      xhr.onabort = () => {
        settle();
        reject(signal.reason);
      };
      xhr.open("POST", url("/jobs"));
      xhr.send(body);
    });
  }

  /** Follows the job's event stream until it's done; rejects if it fails, disappears or the stream is lost. */
  function watch(id: string, events: ConvertEvents, signal: AbortSignal): Promise<Job> {
    return new Promise((resolve, reject) => {
      const source = new EventSource(url(`/jobs/${id}/events`));
      let lost: ReturnType<typeof setTimeout> | undefined;
      // Always close: EventSource reconnects whenever a stream ends.
      const end = (finish: () => void) => {
        source.close();
        clearTimeout(lost);
        signal.removeEventListener("abort", onAbort);
        finish();
      };
      const onAbort = () => end(() => reject(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });

      source.addEventListener("job", (e) => {
        const job = JSON.parse(e.data as string) as Job;
        events.log({ label: `job ${job.status}${job.status === "running" ? ` ${job.progress}%` : ""}`, data: job });
        if (job.status === "queued") events.progress("queued");
        else if (job.status === "running") events.progress("converting", job.progress / 100);
        else if (job.status === "done") end(() => resolve(job));
        else end(() => reject(new BackendError(JOB_ERRORS[job.error?.code ?? ""] ?? "failed", job.error?.message ?? "The job failed.")));
      });
      source.addEventListener("deleted", () => {
        events.log({ label: "job deleted" });
        end(() => reject(new BackendError("expired", "The job was deleted on the server.")));
      });
      source.addEventListener("open", () => {
        clearTimeout(lost);
        lost = undefined;
      });
      source.addEventListener("error", () => {
        // CLOSED: a non-200 answer, and EventSource gave up. It doesn't say which status, so ask
        // the job: 404 = gone (expired), 502/504 = a proxy with the server down (unreachable).
        if (source.readyState === EventSource.CLOSED) {
          events.log({ label: "stream refused" });
          void request(`/jobs/${id}`, { signal }, events).then(
            () => end(() => reject(new BackendError("failed", "The server refused the progress stream."))),
            (error: unknown) => end(() => reject(error)),
          );
          return;
        }
        // CONNECTING: dropped, and EventSource retries by itself. Not a plain idle timer:
        // a queued job gets no events while it waits.
        if (lost !== undefined) return;
        events.log({ label: "stream reconnecting" });
        lost = setTimeout(() => {
          events.log({ label: "stream lost" });
          end(() => reject(new BackendError("unreachable", "Lost the connection to the server.")));
        }, RECONNECT_MS);
      });
    });
  }

  async function download(job: Job, events: ConvertEvents, signal: AbortSignal): Promise<Blob> {
    const path = `/jobs/${job.id}/output`;
    const start = performance.now();
    events.progress("downloading", 0);
    const res = await request(path, { signal }, events);
    // getReader(), not for-await: Safari can't async-iterate streams.
    const reader = res.body!.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        chunks.push(next.value);
        received += next.value.length;
        if (job.sizeBytes) events.progress("downloading", received / job.sizeBytes);
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      events.log({ label: `GET ${path}`, status: "network error", ms: since(start), data: { bytes: received } });
      throw new BackendError("unreachable", (error as Error).message);
    }
    events.log({ label: `GET ${path}`, status: res.status, ms: since(start), data: { bytes: received } });
    return new Blob(chunks, { type: "video/mp4" });
  }

  /** Best effort: frees the server's copy now instead of after its expiry. */
  function remove(id: string, events: ConvertEvents): void {
    const path = `/jobs/${id}`;
    // keepalive: still sent if the visitor closes the tab.
    fetch(url(path), { method: "DELETE", keepalive: true }).then(
      (res) => events.log({ label: `DELETE ${path}`, status: res.status }),
      () => events.log({ label: `DELETE ${path}`, status: "network error" }),
    );
  }

  return {
    async presets() {
      const res = await request("/presets");
      const body = (await res.json()) as Record<string, { description: string }>;
      return Object.entries(body).map(([id, preset]) => ({ id, label: label(id), description: preset.description }));
    },

    async convert(file, presetId, events, signal) {
      signal.throwIfAborted();
      const job = await upload(file, presetId, events, signal);
      try {
        signal.throwIfAborted();
        const done = await watch(job.id, events, signal);
        const blob = await download(done, events, signal);
        remove(job.id, events);
        return { blob, filename: done.filename };
      } catch (error) {
        if (signal.aborted || (error instanceof BackendError && error.kind === "unreachable")) remove(job.id, events);
        throw error;
      }
    },
  };
};

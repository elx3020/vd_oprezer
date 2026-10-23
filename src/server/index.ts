// Public API of the server module: createApp(config) builds the HTTP app
// without listening or reading env, so tests can run it in-process.
// main.ts reads env, listens and handles shutdown.
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { PRESETS, buildArgs, createEngine, parseEncodeOptions, type EncodeOptions, type EngineConfig } from "#core";
import { HttpError, publicError } from "./errors.js";
import { createJobs, type Job } from "./jobs.js";
import { createLimiter } from "./queue.js";

export type { Job, JobStatus } from "./jobs.js";

export interface ServerConfig extends EngineConfig {
  /** Largest accepted upload in bytes. Default: 2 GiB. */
  maxUploadBytes?: number;
  /** Uploads, outputs and jobs live in <workDir>/vd-oprezer/. One server per workDir. Default: the OS temp dir. */
  workDir?: string;
  /** Encodes running at once. Default: 1 (x264 already uses every core). */
  concurrency?: number;
  /** Encodes allowed to wait for a slot (jobs and /convert); more get 503. Default: 20. */
  maxQueued?: number;
  /** How long a finished job and its output are kept. Default: 1 hour. */
  jobTtlMs?: number;
  /** Aborted on shutdown: cancels every encode. */
  signal?: AbortSignal;
  /** Fastify's logger option. Default: false. */
  logger?: FastifyServerOptions["logger"];
}

export function createApp(config: ServerConfig = {}): FastifyInstance {
  const { maxUploadBytes = 2 * 1024 ** 3, workDir = tmpdir(), concurrency = 1, maxQueued = 20, jobTtlMs = 60 * 60_000, logger = false } = config;
  const engine = createEngine(config);
  const app = Fastify({ logger });
  const root = path.join(workDir, "vd-oprezer");
  const stopped = new AbortController();
  const signal = config.signal ? AbortSignal.any([config.signal, stopped.signal]) : stopped.signal;
  const limiter = createLimiter(concurrency);
  const jobs = createJobs({ engine, limiter, dir: path.join(root, "jobs"), ttlMs: jobTtlMs, signal, log: app.log });

  // Jobs live in memory, so files left by a previous run are orphans.
  // ponytail: jobs don't survive restarts; to add that, save Job records and reload them here instead of wiping.
  app.addHook("onReady", async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(path.join(root, "jobs"), { recursive: true });
    await mkdir(path.join(root, "convert"), { recursive: true });
  });
  // preClose runs before Fastify waits for open requests, so event streams end and encodes stop first.
  app.addHook("preClose", () => stopped.abort());
  app.addHook("onClose", async () => {
    await jobs.settled();
    await rm(root, { recursive: true, force: true });
  });

  void app.register(multipart, {
    // One file plus a few short option fields; anything bigger is not a real client.
    limits: { files: 1, fileSize: maxUploadBytes, fields: 10, fieldSize: 1024, parts: 12 },
  });

  app.setErrorHandler((error, req, reply) => {
    // Cancelled encode: either we're shutting down, or the client left and won't read this anyway.
    if ((error as Error).name === "AbortError") {
      const shuttingDown = signal.aborted;
      return reply.status(shuttingDown ? 503 : 499).send({ error: "ABORTED", message: shuttingDown ? "Server is shutting down." : "Client closed the request." });
    }
    const { status, code, message } = publicError(error);
    if (status >= 500) req.log.error(error);
    return reply.status(status).send({ error: code, message });
  });

  /** Streams the multipart upload to `input` and validates the option fields (any order). */
  async function receive(req: FastifyRequest, input: string): Promise<{ filename: string; options: EncodeOptions }> {
    let name: string | undefined;
    const fields: Record<string, unknown> = {};
    for await (const part of req.parts()) {
      if (part.type === "field") {
        fields[part.fieldname] = part.value;
      } else if (part.fieldname !== "file") {
        throw new HttpError(400, "BAD_REQUEST", `Unexpected file field "${part.fieldname}"; send the video as "file".`);
      } else {
        // The client's filename only names the download; it never touches the disk path.
        name = path.parse(part.filename).name;
        await pipeline(part.file, createWriteStream(input));
        if (part.file.truncated) throw new app.multipartErrors.RequestFileTooLargeError();
      }
    }
    if (name === undefined) throw new HttpError(400, "BAD_REQUEST", 'No upload: send the video as multipart field "file".');
    const options = parseEncodeOptions(fields);
    return { filename: `${name.replace(/[^\w.-]+/g, "_") || "video"}-${options.preset}.mp4`, options };
  }

  function sendFile(reply: FastifyReply, file: string, filename: string, onClosed?: () => void) {
    const stream = createReadStream(file);
    // Run onClosed once the response is done and the file is closed (Windows can't delete open files).
    if (onClosed) reply.raw.once("close", () => (stream.closed ? onClosed() : stream.destroy().once("close", onClosed)));
    return reply.type("video/mp4").header("content-disposition", `attachment; filename="${filename}"`).send(stream);
  }

  // Checked before reading the upload, so a full server doesn't fill its disk.
  // ponytail: uploads in progress aren't counted yet, so a burst can pass maxQueued by the number of concurrent uploads.
  function assertRoom() {
    if (limiter.waiting >= maxQueued) throw new HttpError(503, "QUEUE_FULL", "Too many encodes waiting; try again later.");
  }

  function findJob(id: string): Job {
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, "NOT_FOUND", "No such job (finished jobs expire).");
    return job;
  }

  app.get("/health", async () => engine.versions());

  app.get("/presets", () => PRESETS);

  // Synchronous: upload, wait for the encode (queued like jobs), get the MP4 back.
  app.post("/convert", async (req, reply) => {
    assertRoom();
    // Client gone = kill FFmpeg. "close" also fires after a normal response, when there is nothing left to abort.
    const client = new AbortController();
    reply.raw.once("close", () => client.abort());
    const reqSignal = AbortSignal.any([signal, client.signal]);

    const dir = await mkdtemp(path.join(root, "convert", "c-"));
    const cleanup = () => void rm(dir, { recursive: true, force: true });
    const input = path.join(dir, "upload");
    const output = path.join(dir, "output.mp4");
    try {
      const { filename, options } = await receive(req, input);
      await limiter.run(() => engine.transcode({ input, output, args: (info) => buildArgs(options, info), signal: reqSignal }), reqSignal);
      return sendFile(reply, output, filename, cleanup);
    } catch (error) {
      cleanup();
      throw error;
    }
  });

  // Asynchronous: upload, get a job id back at once, poll GET /jobs/:id, download when done.
  app.post("/jobs", async (req, reply) => {
    assertRoom();
    const id = randomUUID();
    const { dir, upload } = jobs.paths(id);
    await mkdir(dir);
    try {
      const { filename, options } = await receive(req, upload);
      return reply.status(202).header("location", `/jobs/${id}`).send(jobs.submit({ id, options, filename }));
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/jobs/:id", (req) => findJob(req.params.id));

  app.get<{ Params: { id: string } }>("/jobs/:id/output", (req, reply) => {
    const job = findJob(req.params.id);
    if (job.status !== "done") throw new HttpError(409, "NOT_READY", `The job is ${job.status}.`);
    return sendFile(reply, jobs.paths(job.id).output, job.filename);
  });

  // Server-Sent Events: the job now, then again on every change (status, whole
  // percent). The stream ends when the job is done, failed or deleted.
  // EventSource reconnects whenever a stream ends, so browser clients should
  // close() it on done/failed; once a job expires, reconnects get 404 and stop.
  app.get<{ Params: { id: string } }>("/jobs/:id/events", (req, reply) => {
    const job = findJob(req.params.id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      // Tells nginx not to buffer the stream.
      "x-accel-buffering": "no",
    });
    const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    const finished = (j: Job) => j.status === "done" || j.status === "failed";

    let unsubscribe = () => {};
    // A comment line keeps proxies from closing a quiet connection.
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    const end = () => {
      clearInterval(keepAlive);
      unsubscribe();
      signal.removeEventListener("abort", end);
      if (!res.writableEnded) res.end();
    };

    event("job", job);
    if (finished(job)) return end();
    unsubscribe = jobs.subscribe(job.id, (changed) => {
      if (!changed) {
        event("deleted", { id: job.id });
        return end();
      }
      event("job", changed);
      if (finished(changed)) end();
    });
    res.once("close", end);
    signal.addEventListener("abort", end, { once: true });
  });

  app.delete<{ Params: { id: string } }>("/jobs/:id", async (req, reply) => {
    if (!(await jobs.remove(req.params.id))) findJob(req.params.id);
    return reply.status(204).send();
  });

  return app;
}

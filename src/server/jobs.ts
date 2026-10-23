// Async encoding jobs, kept in memory. Each job's files live in
// <dir>/<id>/: "upload" until the encode ends, then "output.mp4" until the
// job expires or is deleted.
import { rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { buildArgs, type EncodeOptions, type Engine } from "#core";
import { publicError } from "./errors.js";
import type { Limiter } from "./queue.js";

export type JobStatus = "queued" | "running" | "done" | "failed";

/**
 * A job as clients see it (GET /jobs/:id). Plain JSON-serialisable data on
 * purpose: it is what a store would save if jobs must survive restarts.
 */
export interface Job {
  id: string;
  status: JobStatus;
  options: EncodeOptions;
  /** Download name for the output. */
  filename: string;
  /** 0–100. */
  progress: number;
  createdAt: string;
  finishedAt?: string;
  sizeBytes?: number;
  error?: { code: string; message: string };
}

export interface JobsConfig {
  engine: Engine;
  limiter: Limiter;
  /** Parent directory of the per-job directories. */
  dir: string;
  /** How long a finished job and its output are kept. */
  ttlMs: number;
  /** Aborted on shutdown: stops every job. */
  signal: AbortSignal;
  log: FastifyBaseLogger;
}

export type Jobs = ReturnType<typeof createJobs>;

interface Entry {
  job: Job;
  controller: AbortController;
  /** Settles once the job has stopped, i.e. FFmpeg has exited. */
  done: Promise<void>;
  expiry?: NodeJS.Timeout;
}

export function createJobs({ engine, limiter, dir, ttlMs, signal, log }: JobsConfig) {
  const entries = new Map<string, Entry>();

  /** Only called with ids of known jobs (random UUIDs), never with raw client input. */
  const paths = (id: string) => ({
    dir: path.join(dir, id),
    upload: path.join(dir, id, "upload"),
    output: path.join(dir, id, "output.mp4"),
  });

  /** Cancels the job if it's still running and deletes it with its files. */
  async function remove(id: string): Promise<boolean> {
    const entry = entries.get(id);
    if (!entry) return false;
    entries.delete(id);
    clearTimeout(entry.expiry);
    entry.controller.abort();
    // Wait for FFmpeg to exit: Windows can't delete files it still has open.
    await entry.done;
    await rm(paths(id).dir, { recursive: true, force: true });
    return true;
  }

  /** Queues a job whose upload is already at paths(id).upload. */
  function submit(init: Pick<Job, "id" | "options" | "filename">): Job {
    const job: Job = { ...init, status: "queued", progress: 0, createdAt: new Date().toISOString() };
    const controller = new AbortController();
    const jobSignal = AbortSignal.any([signal, controller.signal]);
    const { upload, output } = paths(job.id);

    const encode = async () => {
      job.status = "running";
      const res = await engine.transcode({
        input: upload,
        output,
        args: (info) => buildArgs(job.options, info),
        signal: jobSignal,
        onProgress: (p) => {
          if (p.percent !== undefined) job.progress = Math.floor(p.percent);
        },
      });
      Object.assign(job, { status: "done", progress: 100, sizeBytes: res.sizeBytes });
    };

    const entry: Entry = { job, controller, done: Promise.resolve() };
    entry.done = limiter
      .run(encode, jobSignal)
      .catch((error: unknown) => {
        if (jobSignal.aborted) return; // deleted, or shutting down
        const { status, code, message } = publicError(error);
        if (status >= 500) log.error({ err: error, jobId: job.id }, "job failed");
        Object.assign(job, { status: "failed", error: { code, message } });
      })
      .then(async () => {
        if (jobSignal.aborted) return;
        job.finishedAt = new Date().toISOString();
        entry.expiry = setTimeout(() => void remove(job.id), ttlMs).unref();
        await rm(upload, { force: true });
      })
      .catch((error: unknown) => log.error({ err: error, jobId: job.id }, "job cleanup failed"));

    entries.set(job.id, entry);
    return job;
  }

  return {
    get: (id: string): Job | undefined => entries.get(id)?.job,
    paths,
    submit,
    remove,
    /** Resolves once every job has stopped; call after aborting `signal`. */
    settled: () => Promise.allSettled([...entries.values()].map((e) => e.done)),
  };
}

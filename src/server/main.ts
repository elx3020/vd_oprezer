// Composition root for the server: the only file that reads env vars and
// process signals.
import { createApp } from "./index.js";

const controller = new AbortController();
const env = process.env;

const app = createApp({
  ffmpegPath: env.FFMPEG_PATH,
  ffprobePath: env.FFPROBE_PATH,
  maxUploadBytes: env.MAX_UPLOAD_MB ? Number(env.MAX_UPLOAD_MB) * 1024 ** 2 : undefined,
  workDir: env.WORK_DIR,
  concurrency: env.CONCURRENCY ? Number(env.CONCURRENCY) : undefined,
  maxQueued: env.MAX_QUEUED ? Number(env.MAX_QUEUED) : undefined,
  jobTtlMs: env.JOB_TTL_MIN ? Number(env.JOB_TTL_MIN) * 60_000 : undefined,
  corsOrigins: env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
  signal: controller.signal,
  logger: true,
});

// Ctrl+C / `docker stop`: cancel running encodes, finish responses, stop listening.
// A client that stops reading its download would keep close() waiting forever,
// so exit anyway after a grace period (docker stop kills after 10 s).
const shutdown = () => {
  if (controller.signal.aborted) return;
  controller.abort();
  setTimeout(() => process.exit(1), 5_000).unref();
  void app.close();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Safety net: FFmpeg must never outlive us (it ignores SIGPIPE).
process.on("exit", () => controller.abort());

// Localhost by default; the Docker image sets HOST=0.0.0.0.
await app.listen({ host: env.HOST ?? "127.0.0.1", port: Number(env.PORT ?? 3000) });

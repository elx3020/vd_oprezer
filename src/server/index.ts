// Public API of the server module: createApp(config) builds the HTTP app
// without listening or reading env, so tests can run it in-process.
// main.ts reads env, listens and handles shutdown.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { PRESETS, buildArgs, createEngine, isVdError, parseEncodeOptions, type EngineConfig, type VdErrorCode } from "#core";

export interface ServerConfig extends EngineConfig {
  /** Largest accepted upload in bytes. Default: 2 GiB. */
  maxUploadBytes?: number;
  /** Where uploads and outputs live while a request runs. Default: the OS temp dir. */
  workDir?: string;
  /** Aborted on shutdown: cancels every running encode. */
  signal?: AbortSignal;
  /** Fastify's logger option. Default: false. */
  logger?: FastifyServerOptions["logger"];
}

// Status per core error. Messages are replaced where the original could
// leak server paths or FFmpeg output; INVALID_ARGUMENT messages are ours
// and describe the client's mistake.
const ERRORS: Record<VdErrorCode, { status: number; message?: string }> = {
  INVALID_ARGUMENT: { status: 400 },
  PROBE_FAILED: { status: 422, message: "The upload is not a readable video file." },
  FFMPEG_FAILED: { status: 500, message: "Encoding failed." },
  FFMPEG_NOT_FOUND: { status: 503, message: "FFmpeg is not available." },
  INPUT_NOT_FOUND: { status: 500, message: "Internal error." },
  OUTPUT_EXISTS: { status: 500, message: "Internal error." },
};

export function createApp(config: ServerConfig = {}): FastifyInstance {
  const { maxUploadBytes = 2 * 1024 ** 3, workDir = tmpdir(), logger = false } = config;
  const engine = createEngine(config);
  const app = Fastify({ logger });

  void app.register(multipart, {
    // One file plus a few short option fields; anything bigger is not a real client.
    limits: { files: 1, fileSize: maxUploadBytes, fields: 10, fieldSize: 1024, parts: 12 },
  });

  app.setErrorHandler((error, req, reply) => {
    // Cancelled encode: either we're shutting down, or the client left and won't read this anyway.
    if ((error as Error).name === "AbortError") {
      const shuttingDown = config.signal?.aborted === true;
      return reply.status(shuttingDown ? 503 : 499).send({ error: "ABORTED", message: shuttingDown ? "Server is shutting down." : "Client closed the request." });
    }
    const vd = isVdError(error) ? ERRORS[error.code] : undefined;
    const status = vd?.status ?? (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(error);
    const code = isVdError(error) ? error.code : ((error as { code?: string }).code ?? "INTERNAL");
    const message = vd ? (vd.message ?? (error as Error).message) : status >= 500 ? "Internal error." : (error as Error).message;
    return reply.status(status).send({ error: code, message });
  });

  app.get("/health", async () => engine.versions());

  app.get("/presets", () => PRESETS);

  // Upload a file (multipart field "file") plus option fields (preset, crf,
  // maxSize) in any order; responds with the encoded MP4.
  // ponytail: synchronous and unbounded, every request encodes at once; decision 7 adds jobs and a queue.
  app.post("/convert", async (req, reply) => {
    // Client gone (or server shutting down) = kill FFmpeg. "close" also
    // fires after a normal response, when there is nothing left to abort.
    const controller = new AbortController();
    reply.raw.once("close", () => controller.abort());
    const signal = config.signal ? AbortSignal.any([config.signal, controller.signal]) : controller.signal;

    const dir = await mkdtemp(path.join(workDir, "vd-"));
    const cleanup = () => rm(dir, { recursive: true, force: true });
    const input = path.join(dir, "upload");
    const output = path.join(dir, "output.mp4");
    let name: string | undefined;
    const fields: Record<string, unknown> = {};

    try {
      for await (const part of req.parts()) {
        if (part.type === "field") {
          fields[part.fieldname] = part.value;
        } else if (part.fieldname !== "file") {
          throw new BadRequest(`Unexpected file field "${part.fieldname}"; send the video as "file".`);
        } else {
          // The client's filename only names the download; it never touches the disk path.
          name = path.parse(part.filename).name;
          await pipeline(part.file, createWriteStream(input));
          if (part.file.truncated) throw new app.multipartErrors.RequestFileTooLargeError();
        }
      }
      if (name === undefined) throw new BadRequest('No upload: send the video as multipart field "file".');

      const options = parseEncodeOptions(fields);
      await engine.transcode({ input, output, args: (info) => buildArgs(options, info), signal });

      const stream = createReadStream(output);
      // Delete the work dir once the response is done and the file is closed (Windows can't delete open files).
      reply.raw.once("close", () => (stream.closed ? void cleanup() : stream.destroy().once("close", () => void cleanup())));
      const download = `${name.replace(/[^\w.-]+/g, "_") || "video"}-${options.preset}.mp4`;
      return reply.type("video/mp4").header("content-disposition", `attachment; filename="${download}"`).send(stream);
    } catch (error) {
      await cleanup();
      throw error;
    }
  });

  return app;
}

class BadRequest extends Error {
  statusCode = 400;
  code = "BAD_REQUEST";
}

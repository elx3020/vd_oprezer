import { isVdError, type VdErrorCode } from "#core";

/** An error with an HTTP status and a code clients can rely on. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Status per core error. Messages are replaced where the original could
// leak server paths or FFmpeg output; INVALID_ARGUMENT messages are ours
// and describe the client's mistake.
const CORE_ERRORS: Record<VdErrorCode, { status: number; message?: string }> = {
  INVALID_ARGUMENT: { status: 400 },
  PROBE_FAILED: { status: 422, message: "The upload is not a readable video file." },
  FFMPEG_FAILED: { status: 500, message: "Encoding failed." },
  FFMPEG_NOT_FOUND: { status: 503, message: "FFmpeg is not available." },
  INPUT_NOT_FOUND: { status: 500, message: "Internal error." },
  OUTPUT_EXISTS: { status: 500, message: "Internal error." },
};

/** What a client may see about `error`: HTTP status, stable code, safe message. */
export function publicError(error: unknown): { status: number; code: string; message: string } {
  if (isVdError(error)) {
    const { status, message } = CORE_ERRORS[error.code];
    return { status, code: error.code, message: message ?? error.message };
  }
  if (error instanceof HttpError) return { status: error.statusCode, code: error.code, message: error.message };
  // Fastify's and @fastify/multipart's errors carry statusCode; anything else is a bug (500).
  const { statusCode = 500, code = "INTERNAL", message = "" } = error as { statusCode?: number; code?: string; message?: string };
  return statusCode >= 500 ? { status: statusCode, code: "INTERNAL", message: "Internal error." } : { status: statusCode, code, message };
}

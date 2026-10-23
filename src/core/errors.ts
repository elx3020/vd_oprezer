export type VdErrorCode =
  /** ffmpeg/ffprobe binary not found at the configured path. */
  | "FFMPEG_NOT_FOUND"
  /** Input is missing or not a regular file. */
  | "INPUT_NOT_FOUND"
  /** Output exists and `overwrite` was not set. */
  | "OUTPUT_EXISTS"
  /** Options don't make sense (e.g. input and output are the same file). */
  | "INVALID_ARGUMENT"
  /** ffprobe couldn't read the input (corrupt or not a media file). */
  | "PROBE_FAILED"
  /** ffmpeg exited with a non-zero code. */
  | "FFMPEG_FAILED";

export interface VdErrorDetails {
  /** The command that failed, for logs. */
  command?: string;
  exitCode?: number | null;
  /** Last part of the tool's stderr, which usually holds the actual reason. */
  stderr?: string;
}

/**
 * Every expected failure in core is a VdError with a stable `code`, so the
 * CLI can pick an exit code and the server an HTTP status without parsing
 * messages. Cancellation is NOT a VdError: it rejects with `signal.reason`
 * (an AbortError, or a TimeoutError when using AbortSignal.timeout()).
 */
export class VdError extends Error {
  override name = "VdError";
  code: VdErrorCode;
  details: VdErrorDetails;

  constructor(code: VdErrorCode, message: string, details: VdErrorDetails = {}, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.details = details;
  }
}

export function isVdError(error: unknown, code?: VdErrorCode): error is VdError {
  return error instanceof VdError && (code === undefined || error.code === code);
}

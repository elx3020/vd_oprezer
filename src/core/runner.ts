import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface RunOptions {
  /** Abort to kill the process. The promise then rejects with `signal.reason`. */
  signal?: AbortSignal;
  /** Receive stdout line by line instead of collecting it (used for progress). */
  onStdoutLine?: (line: string) => void;
}

export interface RunResult {
  exitCode: number | null;
  /** Full stdout, or "" when `onStdoutLine` was given. */
  stdout: string;
  /** Last STDERR_TAIL_CHARS characters of stderr. */
  stderr: string;
}

/**
 * Runs a command. Resolves when it exits (whatever the exit code) and
 * rejects only when it can't be started (e.g. ENOENT) or when aborted.
 *
 * It's a plain function type so tests can pass a fake instead of spawning
 * real FFmpeg.
 */
export type Runner = (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

const STDERR_TAIL_CHARS = 16_000;

export const spawnRunner: Runner = (command, args, { signal, onStdoutLine } = {}) =>
  new Promise<RunResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    // Kill immediately: a cancelled job's output is thrown away, so letting
    // FFmpeg finish gracefully (it flushes encoders and writes the trailer,
    // which can take a while) only wastes time. This is synchronous, so it
    // also works from a process "exit" handler.
    // We only settle once the process has really exited, so callers can
    // safely delete its output file afterwards (matters on Windows).
    const onAbort = () => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });

    if (onStdoutLine) {
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", onStdoutLine);
    } else {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }

    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (exitCode) =>
      settle(() => {
        if (signal?.aborted) reject(abortReason(signal));
        else resolve({ exitCode, stdout, stderr });
      }),
    );
  });

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

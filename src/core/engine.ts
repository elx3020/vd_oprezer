import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { VdError } from "./errors.js";
import { parseProbeOutput, type MediaInfo } from "./probe.js";
import { createProgressParser, type Progress } from "./progress.js";
import { spawnRunner, type RunResult, type Runner } from "./runner.js";

export interface EngineConfig {
  /** Path or name of the ffmpeg binary. Default: "ffmpeg" (looked up on PATH). */
  ffmpegPath?: string;
  /** Path or name of the ffprobe binary. Default: "ffprobe". */
  ffprobePath?: string;
  /** Swap in a fake for tests. Default: spawns real processes. */
  runner?: Runner;
}

export interface CallOptions {
  /** Abort to cancel. Combine with AbortSignal.timeout(ms) for timeouts. */
  signal?: AbortSignal;
}

export interface TranscodeOptions extends CallOptions {
  /** Local file path. URLs and other FFmpeg protocols are rejected on purpose. */
  input: string;
  output: string;
  /** Encoding arguments placed between the input and the output (codecs, filters, bitrate...). */
  args: readonly string[];
  /** Replace `output` if it exists. Default: false. */
  overwrite?: boolean;
  onProgress?: (progress: Progress) => void;
}

export interface TranscodeResult {
  output: string;
  sizeBytes: number;
  elapsedMs: number;
  /** What ffprobe reported about the input. */
  input: MediaInfo;
}

export interface EngineVersions {
  ffmpeg: string;
  ffprobe: string;
}

export interface Engine {
  /** First line of `ffmpeg -version` / `ffprobe -version`. Good for health checks. */
  versions(options?: CallOptions): Promise<EngineVersions>;
  probe(input: string, options?: CallOptions): Promise<MediaInfo>;
  /**
   * Encodes `input` into `output`. FFmpeg writes to a temporary file next to
   * `output`, which is renamed into place only on success, so a failed or
   * cancelled job never leaves a half-written file under the real name.
   */
  transcode(options: TranscodeOptions): Promise<TranscodeResult>;
}

export function createEngine(config: EngineConfig = {}): Engine {
  const ffmpeg = config.ffmpegPath ?? "ffmpeg";
  const ffprobe = config.ffprobePath ?? "ffprobe";
  const run = config.runner ?? spawnRunner;

  async function exec(bin: string, args: string[], options: Parameters<Runner>[2]): Promise<RunResult> {
    try {
      return await run(bin, args, options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new VdError(
          "FFMPEG_NOT_FOUND",
          `Could not run "${bin}". Install FFmpeg or configure the path to the binary.`,
          { command: bin },
          { cause: error },
        );
      }
      throw error;
    }
  }

  async function version(bin: string, signal?: AbortSignal): Promise<string> {
    const res = await exec(bin, ["-version"], { signal });
    if (res.exitCode !== 0) throw failed("FFMPEG_FAILED", bin, ["-version"], res);
    return res.stdout.split(/\r?\n/, 1)[0] ?? "";
  }

  async function probe(input: string, { signal }: CallOptions = {}): Promise<MediaInfo> {
    await assertInputFile(input);
    const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", input];
    const res = await exec(ffprobe, args, { signal });
    if (res.exitCode !== 0) throw failed("PROBE_FAILED", ffprobe, args, res);
    try {
      return parseProbeOutput(res.stdout);
    } catch (error) {
      throw new VdError("PROBE_FAILED", `Could not parse ffprobe output for "${input}".`, {}, { cause: error });
    }
  }

  async function transcode(options: TranscodeOptions): Promise<TranscodeResult> {
    const { input, output, args, overwrite = false, signal, onProgress } = options;
    const started = performance.now();

    if (path.resolve(input) === path.resolve(output)) {
      throw new VdError("INVALID_ARGUMENT", "Input and output must be different files.");
    }
    if (!overwrite && (await exists(output))) {
      throw new VdError("OUTPUT_EXISTS", `Output already exists: "${output}". Pass overwrite to replace it.`);
    }

    const info = await probe(input, { signal });

    const dir = path.dirname(output);
    const ext = path.extname(output);
    // Same directory (so rename is atomic) and same extension (FFmpeg picks the container from it).
    const temp = path.join(dir, `.${path.basename(output, ext)}.${randomUUID().slice(0, 8)}.partial${ext}`);
    await mkdir(dir, { recursive: true });

    const ffArgs = [
      "-hide_banner",
      "-nostdin",
      "-nostats",
      "-loglevel", "warning",
      "-progress", "pipe:1",
      "-y",
      "-i", input,
      ...args,
      temp,
    ];

    try {
      const res = await exec(ffmpeg, ffArgs, {
        signal,
        onStdoutLine: onProgress ? createProgressParser(info.durationMs, onProgress) : undefined,
      });
      if (res.exitCode !== 0) throw failed("FFMPEG_FAILED", ffmpeg, ffArgs, res);
      await rename(temp, output);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }

    const { size } = await stat(output);
    return { output, sizeBytes: size, elapsedMs: Math.round(performance.now() - started), input: info };
  }

  return {
    versions: async ({ signal } = {}) => {
      const [ffmpegVersion, ffprobeVersion] = await Promise.all([version(ffmpeg, signal), version(ffprobe, signal)]);
      return { ffmpeg: ffmpegVersion, ffprobe: ffprobeVersion };
    },
    probe,
    transcode,
  };
}

async function assertInputFile(input: string): Promise<void> {
  const s = await stat(input).catch(() => undefined);
  if (!s?.isFile()) throw new VdError("INPUT_NOT_FOUND", `Input file not found: "${input}".`);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

function failed(code: "FFMPEG_FAILED" | "PROBE_FAILED", bin: string, args: readonly string[], res: RunResult): VdError {
  const lines = res.stderr.trim().split(/\r?\n/).filter(Boolean);
  const reason = lines.at(-1) ?? "no error output";
  return new VdError(code, `${path.basename(bin)} exited with code ${res.exitCode}: ${reason}`, {
    command: [bin, ...args].join(" "),
    exitCode: res.exitCode,
    stderr: res.stderr,
  });
}

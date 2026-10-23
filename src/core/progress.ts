// Parses FFmpeg's machine-readable progress (`-progress pipe:1`).
// FFmpeg prints blocks of key=value lines, each ending with
// `progress=continue` or `progress=end`:
//
//   frame=240
//   fps=48.1
//   bitrate=1520.3kbits/s
//   total_size=1900544
//   out_time_us=10000000
//   speed=2.01x
//   progress=continue

export interface Progress {
  /** How far into the media FFmpeg has written, in ms. */
  outTimeMs: number;
  /** Input duration, if known (from ffprobe). */
  durationMs: number | undefined;
  /** 0–100, if the duration is known. */
  percent: number | undefined;
  /** Encoding speed relative to real time (2 = twice as fast as playback). */
  speed: number | undefined;
  /** Estimated wall-clock time remaining, in ms. */
  etaMs: number | undefined;
  frame: number | undefined;
  fps: number | undefined;
  /** Output bytes written so far. */
  totalSizeBytes: number | undefined;
  bitrateKbps: number | undefined;
  /** True on the final report. */
  done: boolean;
}

/** Returns a line handler that calls `onProgress` once per complete block. */
export function createProgressParser(
  durationMs: number | undefined,
  onProgress: (progress: Progress) => void,
): (line: string) => void {
  let block = new Map<string, string>();

  return (line) => {
    const eq = line.indexOf("=");
    if (eq === -1) return;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    block.set(key, value);
    if (key !== "progress") return;

    const done = value === "end";
    const outTimeUs = num(block.get("out_time_us")) ?? num(block.get("out_time_ms"));
    const outTimeMs = outTimeUs === undefined ? 0 : Math.max(0, Math.round(outTimeUs / 1000));
    const speed = num(block.get("speed")?.replace(/x$/, ""));
    const hasDuration = durationMs !== undefined && durationMs > 0;

    const percent = done ? 100 : hasDuration ? clamp((outTimeMs / durationMs) * 100, 0, 100) : undefined;
    const etaMs = done
      ? 0
      : hasDuration && speed !== undefined && speed > 0
        ? Math.max(0, Math.round((durationMs - outTimeMs) / speed))
        : undefined;

    onProgress({
      outTimeMs,
      durationMs,
      percent,
      speed,
      etaMs,
      frame: num(block.get("frame")),
      fps: num(block.get("fps")),
      totalSizeBytes: num(block.get("total_size")),
      bitrateKbps: num(block.get("bitrate")?.replace(/kbits\/s$/, "")),
      done,
    });
    block = new Map();
  };
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === "" || value === "N/A") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

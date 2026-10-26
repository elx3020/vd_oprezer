// Presets: named encoding recipes, plus the one schema that CLI flags and
// HTTP bodies are validated against. All presets produce H.264/AAC MP4.
import * as z from "zod";
import { VdError } from "./errors.js";
import type { MediaInfo, VideoStreamInfo } from "./probe.js";

export interface Preset {
  description: string;
  /** x264 constant rate factor: lower means better quality and bigger files. */
  crf: number;
  /** x264 speed: slower gives smaller files at the same quality. */
  speed: "veryfast" | "fast" | "medium" | "slow" | "slower";
  /** Downscale so the short side is at most this many pixels ("720p" also for portrait). Never upscales. */
  maxSize?: number;
  /** Lower the frame rate to this when the input is faster. */
  maxFps?: number;
  /** Caps bitrate peaks, for platforms with a bitrate limit. */
  maxBitrateKbps?: number;
  /** Keyframe interval in seconds. Default: x264's. */
  gopSeconds?: number;
  /** Consecutive B-frames. Default: x264's (3). */
  bframes?: number;
  /** AAC bitrate, or false to drop audio. */
  audioKbps: number | false;
  /** Remove metadata, such as the recording location phones add. */
  stripMetadata?: boolean;
  /** Reject inputs outside this duration before encoding. */
  durationS?: { min: number; max: number };
}

export const PRESETS = {
  web: {
    description: "General web playback: up to 1080p, AAC 128k, fast start",
    crf: 23,
    speed: "medium",
    maxSize: 1080,
    audioKbps: 128,
    stripMetadata: true,
  },
  ecommerce: {
    description: "Silent product videos for cards and half-width sections: up to 720p, 30 fps, no audio, fast start",
    crf: 22,
    speed: "slow",
    maxSize: 720,
    maxFps: 30,
    audioKbps: false,
    stripMetadata: true,
  },
  // https://support.google.com/youtube/answer/1722171
  youtube: {
    description: "YouTube upload: source size and frame rate, high quality, closed GOP of half the frame rate, AAC 384k",
    crf: 18,
    speed: "slow",
    gopSeconds: 0.5,
    bframes: 2,
    audioKbps: 384,
  },
  // https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
  "instagram-reel": {
    description: "Instagram Reel: short side up to 1080 (1080x1920 portrait), max 60 fps and 25 Mbps, 3 s to 15 min",
    crf: 20,
    speed: "medium",
    maxSize: 1080,
    maxFps: 60,
    maxBitrateKbps: 25_000,
    audioKbps: 128,
    durationS: { min: 3, max: 900 },
  },
} as const satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;

/**
 * What a user may choose. Numbers are coerced because CLI flags and
 * multipart form fields arrive as strings. Raw FFmpeg arguments are
 * deliberately not part of this: only the CLI may pass those.
 */
export const encodeOptionsSchema = z.strictObject({
  preset: z.enum(Object.keys(PRESETS) as [PresetName, ...PresetName[]]).default("web"),
  crf: z.coerce.number().int().min(0).max(51).optional(),
  maxSize: z.coerce.number().int().min(16).max(8192).optional(),
});

export type EncodeOptions = z.output<typeof encodeOptionsSchema>;

/** Validates untrusted input; throws INVALID_ARGUMENT listing every problem. */
export function parseEncodeOptions(input: unknown): EncodeOptions {
  const res = encodeOptionsSchema.safeParse(input);
  if (!res.success) throw new VdError("INVALID_ARGUMENT", `Invalid options:\n${z.prettifyError(res.error)}`);
  return res.data;
}

/** FFmpeg encoding arguments for `options`, adapted to the probed input. */
export function buildArgs(options: EncodeOptions, input: MediaInfo): string[] {
  const p: Preset = PRESETS[options.preset];
  const v = input.video;
  if (!v) throw new VdError("INVALID_ARGUMENT", "Input has no video stream.");

  const limit = p.durationS;
  if (limit && input.durationMs !== undefined) {
    const s = input.durationMs / 1000;
    if (s < limit.min || s > limit.max) {
      throw new VdError("INVALID_ARGUMENT", `Input is ${s.toFixed(1)}s long; "${options.preset}" accepts ${limit.min}s to ${limit.max}s.`);
    }
  }

  const filters: string[] = [];
  const size = outputSize(v, options.maxSize ?? p.maxSize);
  if (size) filters.push(`scale=${size.width}:${size.height}`);
  const fps = p.maxFps && v.fps && v.fps > p.maxFps ? p.maxFps : v.fps;
  if (fps !== v.fps) filters.push(`fps=${fps}`);

  const args = ["-c:v", "libx264", "-preset", p.speed, "-crf", String(options.crf ?? p.crf), "-pix_fmt", "yuv420p"];
  if (filters.length) args.push("-vf", filters.join(","));
  if (p.maxBitrateKbps) args.push("-maxrate", `${p.maxBitrateKbps}k`, "-bufsize", `${p.maxBitrateKbps * 2}k`);
  if (p.gopSeconds && fps) args.push("-g", String(Math.max(1, Math.round(fps * p.gopSeconds))));
  if (p.bframes !== undefined) args.push("-bf", String(p.bframes));
  args.push(...(p.audioKbps === false ? ["-an"] : ["-c:a", "aac", "-b:a", `${p.audioKbps}k`, "-ar", "48000"]));
  if (p.stripMetadata) args.push("-map_metadata", "-1");
  // Index at the front, so browsers can start playing before the download ends.
  args.push("-movflags", "+faststart");
  return args;
}

/** The displayed size the encode produces: the scaled size, or the input's when it is kept. */
export function outputDimensions(options: EncodeOptions, input: MediaInfo): { width: number; height: number } {
  const v = input.video;
  if (!v) throw new VdError("INVALID_ARGUMENT", "Input has no video stream.");
  const p: Preset = PRESETS[options.preset];
  const scaled = outputSize(v, options.maxSize ?? p.maxSize);
  if (scaled) return scaled;
  return v.rotation % 180 === 90 ? { width: v.height, height: v.width } : { width: v.width, height: v.height };
}

/**
 * Output size, or undefined to keep the input's. Shrinks the short side to
 * `maxSize` and rounds to even numbers, which yuv420p requires.
 */
function outputSize(v: VideoStreamInfo, maxSize: number | undefined): { width: number; height: number } | undefined {
  // FFmpeg applies rotation before filters, so work with the displayed size.
  const [w, h] = v.rotation % 180 === 90 ? [v.height, v.width] : [v.width, v.height];
  const short = Math.min(w, h);
  const k = maxSize && short > maxSize ? maxSize / short : 1;
  const even = (n: number) => Math.max(2, 2 * Math.floor(Math.round(n) / 2));
  const width = even(w * k);
  const height = even(h * k);
  return width === w && height === h ? undefined : { width, height };
}

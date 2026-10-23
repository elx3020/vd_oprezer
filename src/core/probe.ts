// Turns `ffprobe -print_format json -show_format -show_streams` output into
// the small, typed subset we actually use.

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  fps: number | undefined;
  bitRate: number | undefined;
  pixFmt: string | undefined;
  /** Rotation metadata in degrees (phones record portrait as landscape + rotation). */
  rotation: number;
}

export interface AudioStreamInfo {
  codec: string;
  channels: number | undefined;
  sampleRate: number | undefined;
  bitRate: number | undefined;
}

export interface MediaInfo {
  /** e.g. "mov,mp4,m4a,3gp,3g2,mj2" */
  formatName: string;
  durationMs: number | undefined;
  sizeBytes: number | undefined;
  /** Overall bit rate in bits/s. */
  bitRate: number | undefined;
  /** First video stream, if any. */
  video: VideoStreamInfo | undefined;
  /** First audio stream, if any. */
  audio: AudioStreamInfo | undefined;
  streamCount: number;
}

// Only the ffprobe fields we read. Everything comes back as strings or numbers.
interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  pix_fmt?: string;
  channels?: number;
  sample_rate?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}

interface RawProbe {
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
  streams?: RawStream[];
}

export function parseProbeOutput(json: string): MediaInfo {
  const raw = JSON.parse(json) as RawProbe;
  const streams = raw.streams ?? [];
  // Cover art in audio files shows up as a "video" stream; skip it.
  const v = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const a = streams.find((s) => s.codec_type === "audio");
  const durationS = num(raw.format?.duration);

  return {
    formatName: raw.format?.format_name ?? "unknown",
    durationMs: durationS === undefined ? undefined : Math.round(durationS * 1000),
    sizeBytes: num(raw.format?.size),
    bitRate: num(raw.format?.bit_rate),
    video:
      v && v.width && v.height
        ? {
            codec: v.codec_name ?? "unknown",
            width: v.width,
            height: v.height,
            fps: frameRate(v.avg_frame_rate) ?? frameRate(v.r_frame_rate),
            bitRate: num(v.bit_rate),
            pixFmt: v.pix_fmt,
            rotation: rotation(v),
          }
        : undefined,
    audio: a
      ? {
          codec: a.codec_name ?? "unknown",
          channels: a.channels,
          sampleRate: num(a.sample_rate),
          bitRate: num(a.bit_rate),
        }
      : undefined,
    streamCount: streams.length,
  };
}

/** "30000/1001" → 29.97 */
function frameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [n, d] = value.split("/").map(Number);
  if (n === undefined || !Number.isFinite(n) || n === 0) return undefined;
  const fps = d ? n / d : n;
  return Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : undefined;
}

function rotation(s: RawStream): number {
  const fromSideData = s.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation;
  const deg = fromSideData ?? num(s.tags?.rotate) ?? 0;
  return ((Math.round(deg) % 360) + 360) % 360;
}

function num(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "" || value === "N/A") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

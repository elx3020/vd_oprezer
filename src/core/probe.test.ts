import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProbeOutput } from "./probe.js";

// Trimmed real output of `ffprobe -print_format json -show_format -show_streams`
// for a 1080p30 h264/aac clip.
const MP4_1080P = {
  streams: [
    {
      codec_name: "h264",
      codec_type: "video",
      width: 1920,
      height: 1080,
      pix_fmt: "yuv420p",
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
      bit_rate: "2400000",
      disposition: { attached_pic: 0 },
    },
    {
      codec_name: "aac",
      codec_type: "audio",
      sample_rate: "44100",
      channels: 2,
      bit_rate: "128000",
      disposition: { attached_pic: 0 },
    },
  ],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "5.000000", size: "1625000", bit_rate: "2600000" },
};

const parse = (raw: unknown) => parseProbeOutput(JSON.stringify(raw));

describe("parseProbeOutput", () => {
  it("reads format, first video and first audio stream", () => {
    assert.deepEqual(parse(MP4_1080P), {
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      durationMs: 5_000,
      sizeBytes: 1_625_000,
      bitRate: 2_600_000,
      video: { codec: "h264", width: 1920, height: 1080, fps: 30, bitRate: 2_400_000, pixFmt: "yuv420p", rotation: 0 },
      audio: { codec: "aac", channels: 2, sampleRate: 44_100, bitRate: 128_000 },
      streamCount: 2,
    });
  });

  it("rounds fractional frame rates and falls back to r_frame_rate", () => {
    const ntsc = { streams: [{ codec_type: "video", width: 2, height: 2, avg_frame_rate: "30000/1001" }] };
    assert.equal(parse(ntsc).video?.fps, 29.97);
    const noAvg = { streams: [{ codec_type: "video", width: 2, height: 2, avg_frame_rate: "0/0", r_frame_rate: "25/1" }] };
    assert.equal(parse(noAvg).video?.fps, 25);
  });

  it("reads rotation from side data or the legacy tag, normalised to 0–359", () => {
    const sideData = { streams: [{ codec_type: "video", width: 2, height: 2, side_data_list: [{}, { rotation: -90 }] }] };
    assert.equal(parse(sideData).video?.rotation, 270);
    const tag = { streams: [{ codec_type: "video", width: 2, height: 2, tags: { rotate: "90" } }] };
    assert.equal(parse(tag).video?.rotation, 90);
  });

  it("skips cover art, which ffprobe lists as a video stream", () => {
    const mp3 = {
      streams: [
        { codec_type: "audio", codec_name: "mp3" },
        { codec_type: "video", codec_name: "mjpeg", width: 500, height: 500, disposition: { attached_pic: 1 } },
      ],
    };
    const info = parse(mp3);
    assert.equal(info.video, undefined);
    assert.equal(info.audio?.codec, "mp3");
    assert.equal(info.streamCount, 2);
  });

  it("treats missing and N/A values as unknown", () => {
    assert.deepEqual(parse({ format: { duration: "N/A", size: "" } }), {
      formatName: "unknown",
      durationMs: undefined,
      sizeBytes: undefined,
      bitRate: undefined,
      video: undefined,
      audio: undefined,
      streamCount: 0,
    });
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseProbeOutput("not json"), SyntaxError);
  });
});

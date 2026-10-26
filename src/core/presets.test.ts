import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MediaInfo, VideoStreamInfo } from "./probe.js";
import { buildArgs, outputDimensions, parseEncodeOptions } from "./presets.js";

function media(video: Partial<VideoStreamInfo> = {}, durationMs = 10_000): MediaInfo {
  return {
    formatName: "mov,mp4",
    durationMs,
    sizeBytes: 1_000_000,
    bitRate: undefined,
    video: { codec: "h264", width: 1920, height: 1080, fps: 30, bitRate: undefined, pixFmt: "yuv420p", rotation: 0, ...video },
    audio: { codec: "aac", channels: 2, sampleRate: 48_000, bitRate: undefined },
    streamCount: 2,
  };
}

const args = (options: unknown, info = media()) => buildArgs(parseEncodeOptions(options), info);
/** Value following `flag`, or undefined when the flag is absent. */
const flag = (list: string[], name: string) => (list.includes(name) ? list[list.indexOf(name) + 1] : undefined);

describe("parseEncodeOptions", () => {
  it("defaults to the web preset and coerces numeric strings", () => {
    assert.deepEqual(parseEncodeOptions({}), { preset: "web" });
    assert.deepEqual(parseEncodeOptions({ preset: "ecommerce", crf: "20", maxSize: "480" }), { preset: "ecommerce", crf: 20, maxSize: 480 });
  });

  it("rejects bad input with INVALID_ARGUMENT, listing every problem", () => {
    assert.throws(() => parseEncodeOptions({ preset: "tiktok", crf: 60, args: ["-f", "x"] }), (error: Error & { code?: string }) => {
      assert.equal(error.code, "INVALID_ARGUMENT");
      assert.match(error.message, /Unrecognized key: "args"/);
      assert.match(error.message, /expected one of "web"\|"ecommerce"\|"youtube"\|"instagram-reel"/);
      assert.match(error.message, /at crf/);
      return true;
    });
    assert.throws(() => parseEncodeOptions({ maxSize: "big" }), { code: "INVALID_ARGUMENT" });
    assert.throws(() => parseEncodeOptions(null), { code: "INVALID_ARGUMENT" });
  });
});

describe("buildArgs", () => {
  it("web: H.264/AAC MP4 at 1080p max, metadata stripped, fast start", () => {
    assert.deepEqual(args({ preset: "web" }, media({ width: 3840, height: 2160 })), [
      "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p",
      "-vf", "scale=1920:1080",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
      "-map_metadata", "-1",
      "-movflags", "+faststart",
    ]);
  });

  it("ecommerce: 720p max, 30 fps max, no audio", () => {
    const a = args({ preset: "ecommerce" }, media({ fps: 60 }));
    assert.equal(flag(a, "-vf"), "scale=1280:720,fps=30");
    assert.ok(a.includes("-an"));
    assert.equal(a.includes("-c:a"), false);
    assert.equal(flag(a, "-preset"), "slow");
    assert.equal(flag(a, "-map_metadata"), "-1");
  });

  it("youtube: keeps size and frame rate, GOP of half the frame rate, 2 B-frames, AAC 384k", () => {
    const a = args({ preset: "youtube" }, media({ width: 3840, height: 2160, fps: 60 }));
    assert.equal(flag(a, "-vf"), undefined);
    assert.equal(flag(a, "-g"), "30");
    assert.equal(flag(a, "-bf"), "2");
    assert.equal(flag(a, "-b:a"), "384k");
    assert.equal(flag(a, "-crf"), "18");
    assert.equal(flag(a, "-map_metadata"), undefined);
  });

  it("instagram-reel: caps bitrate at 25 Mbps and frame rate at 60, 1080 short side", () => {
    const a = args({ preset: "instagram-reel" }, media({ width: 2160, height: 3840, fps: 120 }));
    assert.equal(flag(a, "-vf"), "scale=1080:1920,fps=60");
    assert.equal(flag(a, "-maxrate"), "25000k");
    assert.equal(flag(a, "-bufsize"), "50000k");
  });

  it("instagram-reel: rejects inputs shorter than 3 s or longer than 15 min", () => {
    assert.throws(() => args({ preset: "instagram-reel" }, media({}, 2_000)), { code: "INVALID_ARGUMENT", message: /2\.0s long.*3s to 900s/ });
    assert.throws(() => args({ preset: "instagram-reel" }, media({}, 901_000)), { code: "INVALID_ARGUMENT" });
    assert.doesNotThrow(() => args({ preset: "instagram-reel" }, media({}, 900_000)));
  });

  it("applies maxSize to the short side, for portrait and rotated videos too", () => {
    assert.equal(flag(args({ maxSize: 720 }, media({ width: 1080, height: 1920 })), "-vf"), "scale=720:1280");
    // Stored landscape with rotation 90 = displayed portrait.
    assert.equal(flag(args({ maxSize: 720 }, media({ width: 1920, height: 1080, rotation: 90 })), "-vf"), "scale=720:1280");
    assert.equal(flag(args({ maxSize: 720 }, media({ width: 1440, height: 1080 })), "-vf"), "scale=960:720");
  });

  it("never upscales, and only rounds odd sizes down to even", () => {
    assert.equal(flag(args({ preset: "web" }, media({ width: 640, height: 360 })), "-vf"), undefined);
    assert.equal(flag(args({ preset: "web" }, media({ width: 641, height: 361 })), "-vf"), "scale=640:360");
  });

  it("lets crf and maxSize override the preset", () => {
    const a = args({ preset: "ecommerce", crf: 28, maxSize: 480 });
    assert.equal(flag(a, "-crf"), "28");
    assert.equal(flag(a, "-vf"), "scale=852:480");
  });

  it("fails clearly on an input without video", () => {
    assert.throws(() => buildArgs(parseEncodeOptions({}), { ...media(), video: undefined }), { code: "INVALID_ARGUMENT", message: /no video stream/ });
  });
});

describe("outputDimensions", () => {
  const dims = (options: unknown, info: MediaInfo) => outputDimensions(parseEncodeOptions(options), info);

  it("caps the short side and keeps even numbers", () => {
    assert.deepEqual(dims({ preset: "ecommerce", maxSize: 480 }, media()), { width: 852, height: 480 });
  });

  it("reports the displayed size of a rotated portrait input and never upscales", () => {
    assert.deepEqual(dims({ preset: "ecommerce", maxSize: 1080 }, media({ width: 1280, height: 720, rotation: 90 })), { width: 720, height: 1280 });
  });
});

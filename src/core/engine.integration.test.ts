// The engine against real FFmpeg, on clips generated at test time (lavfi).
// Skipped when ffmpeg/ffprobe aren't on PATH.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { createEngine } from "./engine.js";

const engine = createEngine();
const available = await engine.versions().then(
  () => true,
  () => false,
);
const skip = !available && "ffmpeg/ffprobe not found on PATH; install FFmpeg to run the integration tests";

const ffmpeg = (...args: string[]) => promisify(execFile)("ffmpeg", ["-v", "error", "-y", ...args]);
const X264 = ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"];

describe("engine with real FFmpeg", { skip }, () => {
  let dir: string;
  let hd: string; // 1080p30 h264/aac, 2 s
  let small: string; // 320x240, 2 s, used as transcode input
  const file = (name: string) => path.join(dir, name);
  const partials = async () => (await readdir(dir)).filter((f) => f.includes(".partial"));

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vd-ffmpeg-"));
    hd = file("hd.mp4");
    small = file("small.mp4");
    const lavfi = (size: string) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440"];
    await ffmpeg(...lavfi("1920x1080"), "-t", "2", ...X264, "-shortest", hd);
    await ffmpeg(...lavfi("320x240"), "-t", "2", ...X264, "-shortest", small);
    // FFmpeg 6+ ignores -metadata:s:v rotate=90; -display_rotation writes the display matrix.
    await ffmpeg("-display_rotation", "90", "-i", small, "-c", "copy", file("rotated.mp4"));
    await writeFile(file("text.mp4"), "this is not a video");
  });

  after(() => rm(dir, { recursive: true, force: true }));

  describe("probe", () => {
    it("reads a 1080p30 h264/aac file", async () => {
      const info = await engine.probe(hd);
      assert.match(info.formatName, /mp4/);
      assert.ok(Math.abs((info.durationMs ?? 0) - 2_000) < 100, `durationMs ${info.durationMs}`);
      assert.equal(info.sizeBytes, (await stat(hd)).size);
      assert.deepEqual(
        { codec: info.video?.codec, width: info.video?.width, height: info.video?.height, fps: info.video?.fps, rotation: info.video?.rotation },
        { codec: "h264", width: 1920, height: 1080, fps: 30, rotation: 0 },
      );
      assert.deepEqual({ codec: info.audio?.codec, channels: info.audio?.channels }, { codec: "aac", channels: 1 });
    });

    it("reads display rotation", async () => {
      assert.equal((await engine.probe(file("rotated.mp4"))).video?.rotation, 90);
    });

    it("fails with PROBE_FAILED on a text file named .mp4", async () => {
      await assert.rejects(engine.probe(file("text.mp4")), { code: "PROBE_FAILED", message: /Invalid data found when processing input/ });
    });
  });

  describe("transcode", () => {
    it("writes the output and reports progress ending at 100 %", async () => {
      const out = file("ok.mp4");
      const progress: { percent: number | undefined; done: boolean }[] = [];
      const res = await engine.transcode({ input: small, output: out, args: X264, onProgress: ({ percent, done }) => progress.push({ percent, done }) });

      assert.equal(res.sizeBytes, (await stat(out)).size);
      assert.ok(res.elapsedMs > 0);
      assert.equal(res.input.video?.width, 320);
      assert.deepEqual(progress.at(-1), { percent: 100, done: true });
      assert.equal((await engine.probe(out)).video?.codec, "h264");
      assert.deepEqual(await partials(), []);
    });

    it("leaves an existing output untouched without overwrite, and replaces it with", async () => {
      const out = file("exists.mp4");
      await writeFile(out, "keep me");
      await assert.rejects(engine.transcode({ input: small, output: out, args: X264 }), { code: "OUTPUT_EXISTS" });
      assert.equal(await readFile(out, "utf8"), "keep me");

      await engine.transcode({ input: small, output: out, args: X264, overwrite: true });
      assert.equal((await engine.probe(out)).video?.codec, "h264");
    });

    it("fails with INPUT_NOT_FOUND for a missing input", async () => {
      await assert.rejects(engine.transcode({ input: file("missing.mp4"), output: file("x.mp4"), args: X264 }), { code: "INPUT_NOT_FOUND" });
    });

    it("fails with INVALID_ARGUMENT when input and output are the same file", async () => {
      await assert.rejects(engine.transcode({ input: small, output: small, args: X264, overwrite: true }), { code: "INVALID_ARGUMENT" });
    });

    it("fails with FFMPEG_FAILED on an unknown encoder and leaves no output", async () => {
      const out = file("bad.mp4");
      await assert.rejects(engine.transcode({ input: small, output: out, args: ["-c:v", "not_a_codec"] }), {
        code: "FFMPEG_FAILED",
        message: /Encoder not found/,
      });
      await assert.rejects(stat(out), { code: "ENOENT" });
      assert.deepEqual(await partials(), []);
    });

    it("rejects with TimeoutError on AbortSignal.timeout and deletes the partial file", async () => {
      let started = false;
      // loop=-1 repeats the first frames forever, so only the timeout can end this job.
      const args = ["-vf", "loop=loop=-1:size=30", ...X264];
      await assert.rejects(
        engine.transcode({ input: small, output: file("endless.mp4"), args, signal: AbortSignal.timeout(3_000), onProgress: () => (started = true) }),
        { name: "TimeoutError" },
      );
      assert.ok(started, "ffmpeg never reported progress before the timeout");
      // The runner settles only after FFmpeg's "close" event, so the process is gone by now.
      assert.deepEqual(await partials(), []);
      await assert.rejects(stat(file("endless.mp4")), { code: "ENOENT" });
    });
  });

  it("fails with FFMPEG_NOT_FOUND when the binary path is wrong", async () => {
    await assert.rejects(createEngine({ ffmpegPath: file("no-ffmpeg") }).versions(), { code: "FFMPEG_NOT_FOUND" });
  });
});

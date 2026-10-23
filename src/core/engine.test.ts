// Engine logic with a fake runner: no FFmpeg needed.
// The same behaviours against real FFmpeg live in engine.integration.test.ts.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createEngine } from "./engine.js";
import type { RunResult, Runner } from "./runner.js";

const PROBE_JSON = JSON.stringify({
  format: { format_name: "mov,mp4", duration: "10.0", size: "1000" },
  streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1" }],
});

const result = (exitCode: number, stdout = "", stderr = ""): RunResult => ({ exitCode, stdout, stderr });

/** Behaves like FFmpeg that succeeds: writes the output file and reports progress. */
const encodeOk: Runner = async (_command, args, options) => {
  await writeFile(args.at(-1)!, "encoded");
  for (const line of ["out_time_us=5000000", "progress=continue", "out_time_us=10000000", "progress=end"]) {
    options?.onStdoutLine?.(line);
  }
  return result(0);
};

/** ffprobe answers with PROBE_JSON; ffmpeg calls are handled by `ffmpeg`. */
function fakeRunner(ffmpeg: Runner = encodeOk) {
  return mock.fn<Runner>((command, args, options) =>
    command === "ffprobe" ? Promise.resolve(result(0, PROBE_JSON)) : ffmpeg(command, args, options),
  );
}

let dir: string;
let input: string;
let output: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vd-engine-"));
  input = path.join(dir, "in.mp4");
  output = path.join(dir, "out.mp4");
  await writeFile(input, "source");
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe("transcode", () => {
  it("encodes into a temp file next to the output, then renames it into place", async () => {
    const runner = fakeRunner();
    const res = await createEngine({ runner }).transcode({ input, output, args: ["-c:v", "libx264"] });

    assert.equal(await readFile(output, "utf8"), "encoded");
    assert.deepEqual(await readdir(dir), ["in.mp4", "out.mp4"]);
    assert.equal(res.sizeBytes, "encoded".length);
    assert.equal(res.input.durationMs, 10_000);

    const [probeCall, ffmpegCall] = runner.mock.calls;
    assert.equal(probeCall?.arguments[0], "ffprobe");
    const [command, args] = ffmpegCall?.arguments ?? [];
    assert.equal(command, "ffmpeg");
    const temp = args?.at(-1) ?? "";
    assert.equal(path.dirname(temp), dir);
    assert.match(path.basename(temp), /^\.out\.[0-9a-f]{8}\.partial\.mp4$/);
    assert.deepEqual(args?.slice(-6), ["-y", "-i", input, "-c:v", "libx264", temp]);
    assert.ok(args?.includes("-nostdin"));
    assert.deepEqual(args?.slice(args.indexOf("-progress"), args.indexOf("-progress") + 2), ["-progress", "pipe:1"]);
  });

  it("reports progress against the probed duration", async () => {
    const percents: (number | undefined)[] = [];
    await createEngine({ runner: fakeRunner() }).transcode({ input, output, args: [], onProgress: (p) => percents.push(p.percent) });
    assert.deepEqual(percents, [50, 100]);
  });

  it("fails with FFMPEG_FAILED and the last stderr line, and leaves no files behind", async () => {
    const runner = fakeRunner(async (_command, args) => {
      await writeFile(args.at(-1)!, "half");
      return result(1, "", "[vost#0:0] Unknown encoder 'nope'\nEncoder not found\n");
    });
    await assert.rejects(createEngine({ runner }).transcode({ input, output, args: ["-c:v", "nope"] }), {
      name: "VdError",
      code: "FFMPEG_FAILED",
      message: "ffmpeg exited with code 1: Encoder not found",
    });
    assert.deepEqual(await readdir(dir), ["in.mp4"]);
  });

  it("refuses to replace an existing output unless overwrite is set", async () => {
    await writeFile(output, "keep me");
    const runner = fakeRunner();
    const engine = createEngine({ runner });

    await assert.rejects(engine.transcode({ input, output, args: [] }), { code: "OUTPUT_EXISTS" });
    assert.equal(await readFile(output, "utf8"), "keep me");
    assert.equal(runner.mock.callCount(), 0);

    await engine.transcode({ input, output, args: [], overwrite: true });
    assert.equal(await readFile(output, "utf8"), "encoded");
  });

  it("rejects the same file as input and output, however it is spelled", async () => {
    const sameFile = path.join(dir, ".", "sub", "..", "in.mp4");
    await assert.rejects(createEngine({ runner: fakeRunner() }).transcode({ input, output: sameFile, args: [], overwrite: true }), {
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects a missing input, or one that is a directory, without running anything", async () => {
    const runner = fakeRunner();
    const engine = createEngine({ runner });
    await assert.rejects(engine.transcode({ input: path.join(dir, "missing.mp4"), output, args: [] }), { code: "INPUT_NOT_FOUND" });
    await assert.rejects(engine.transcode({ input: dir, output, args: [] }), { code: "INPUT_NOT_FOUND" });
    assert.equal(runner.mock.callCount(), 0);
  });

  it("rejects with the abort reason (not a VdError) and deletes the temp file when cancelled", async () => {
    const controller = new AbortController();
    const runner = fakeRunner(async (_command, args, options) => {
      await writeFile(args.at(-1)!, "half");
      controller.abort();
      throw options?.signal?.reason;
    });
    await assert.rejects(createEngine({ runner }).transcode({ input, output, args: [], signal: controller.signal }), {
      name: "AbortError",
    });
    assert.deepEqual(await readdir(dir), ["in.mp4"]);
  });
});

describe("probe", () => {
  it("fails with PROBE_FAILED and ffprobe's reason when it exits non-zero", async () => {
    const runner = mock.fn<Runner>(() => Promise.resolve(result(1, "", `${input}: Invalid data found when processing input\n`)));
    await assert.rejects(createEngine({ runner }).probe(input), {
      code: "PROBE_FAILED",
      message: /Invalid data found when processing input$/,
    });
  });

  it("fails with PROBE_FAILED when the output is not JSON", async () => {
    const runner = mock.fn<Runner>(() => Promise.resolve(result(0, "garbage")));
    await assert.rejects(createEngine({ runner }).probe(input), { code: "PROBE_FAILED" });
  });
});

describe("versions", () => {
  it("returns the first line of each -version, using the configured binaries", async () => {
    const runner = mock.fn<Runner>((command) => Promise.resolve(result(0, `${command} version 7.1\r\nbuilt with gcc\n`)));
    const engine = createEngine({ runner, ffmpegPath: "/opt/ff/ffmpeg", ffprobePath: "/opt/ff/ffprobe" });
    assert.deepEqual(await engine.versions(), {
      ffmpeg: "/opt/ff/ffmpeg version 7.1",
      ffprobe: "/opt/ff/ffprobe version 7.1",
    });
  });

  it("maps a binary that can't be started to FFMPEG_NOT_FOUND", async () => {
    const enoent = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    const runner = mock.fn<Runner>(() => Promise.reject(enoent));
    await assert.rejects(createEngine({ runner }).versions(), { code: "FFMPEG_NOT_FOUND", cause: enoent });
  });
});

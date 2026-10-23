// The CLI with a fake runner and captured output: no FFmpeg needed.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { RunResult, Runner } from "#core";
import { EXIT, run, type CliContext } from "./index.js";

const PROBE_JSON = JSON.stringify({
  format: { format_name: "mov,mp4", duration: "10.0", size: "1000" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1", side_data_list: [{ rotation: 90 }] },
    { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" },
  ],
});

const result = (exitCode: number, stdout = "", stderr = ""): RunResult => ({ exitCode, stdout, stderr });

/** ffprobe answers PROBE_JSON, ffmpeg writes its output file, -version prints a banner. */
function fakeRunner() {
  return mock.fn<Runner>(async (command, args) => {
    if (args[0] === "-version") return result(0, `${command} version 9.0\n`);
    if (command === "ffprobe") return result(0, PROBE_JSON);
    await writeFile(args.at(-1)!, "encoded");
    return result(0);
  });
}

let dir: string;
let runner: ReturnType<typeof fakeRunner>;

/** Runs the CLI and captures what it prints. */
async function cli(argv: string[], ctx: CliContext = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    runner,
    version: "1.2.3",
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    ...ctx,
  });
  return { code, stdout, stderr };
}

const file = (name: string) => path.join(dir, name);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vd-cli-"));
  runner = fakeRunner();
  await writeFile(file("a.mov"), "source a");
  await writeFile(file("b.mov"), "source b");
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe("cli", () => {
  it("prints its own and FFmpeg's versions", async () => {
    assert.deepEqual(await cli(["version"]), {
      code: EXIT.ok,
      stdout: "vd-oprezer 1.2.3\nffmpeg version 9.0\nffprobe version 9.0\n",
      stderr: "",
    });
    assert.deepEqual(await cli(["--version"]), { code: EXIT.ok, stdout: "1.2.3\n", stderr: "" });
  });

  it("shows help with exit 0 when asked, and exit 2 on usage errors", async () => {
    const help = await cli(["--help"]);
    assert.equal(help.code, EXIT.ok);
    assert.match(help.stdout, /convert \[options\] <inputs\.\.\.>/);

    assert.equal((await cli([])).code, EXIT.usage);
    const unknown = await cli(["resize"]);
    assert.equal(unknown.code, EXIT.usage);
    assert.match(unknown.stderr, /unknown command 'resize'/);
    assert.equal((await cli(["probe"])).code, EXIT.usage);
    assert.equal(runner.mock.callCount(), 0);
  });

  describe("probe", () => {
    it("prints a summary, or the full result with --json", async () => {
      const { code, stdout } = await cli(["probe", file("a.mov")]);
      assert.equal(code, EXIT.ok);
      assert.equal(
        stdout,
        "format:   mov,mp4\nduration: 10.0s\nsize:     1000 B\nvideo:    h264 640x360 30fps rotated 90°\naudio:    aac 2ch 48000Hz\n",
      );

      const json = await cli(["probe", file("a.mov"), "--json"]);
      assert.equal((JSON.parse(json.stdout) as { video: { width: number } }).video.width, 640);
    });

    it("reports a core error with exit 1", async () => {
      const { code, stderr } = await cli(["probe", file("missing.mov")]);
      assert.equal(code, EXIT.error);
      assert.match(stderr, /^✗ Input file not found: ".*missing\.mov"\.\n$/);
    });
  });

  describe("convert", () => {
    it("passes everything after -- to FFmpeg, not as inputs", async () => {
      const { code, stdout } = await cli(["convert", file("a.mov"), "-o", file("a.mp4"), "--", "-c:v", "libx264", "-crf", "23"]);
      assert.equal(code, EXIT.ok);
      assert.match(stdout, /^✓ .*a\.mp4: 7 B \(1% of input\) in \d+\.\ds\n$/);
      const ffmpegArgs = runner.mock.calls.at(-1)?.arguments[1] ?? [];
      assert.deepEqual(ffmpegArgs.slice(-5, -1), ["-c:v", "libx264", "-crf", "23"]);
    });

    it("writes several inputs into --out-dir, keeping their names", async () => {
      const { code } = await cli(["convert", file("a.mov"), file("b.mov"), "--out-dir", file("out")]);
      assert.equal(code, EXIT.ok);
      assert.deepEqual(await readdir(file("out")), ["a.mov", "b.mov"]);
    });

    it("keeps going after a failed input and exits 1", async () => {
      const { code, stdout, stderr } = await cli(["convert", file("missing.mov"), file("b.mov"), "--out-dir", file("out")]);
      assert.equal(code, EXIT.error);
      assert.match(stderr, /^✗ .*missing\.mov: Input file not found/);
      assert.match(stdout, /^✓ .*b\.mov/);
      assert.deepEqual(await readdir(file("out")), ["b.mov"]);
    });

    it("needs exactly one of --output and --out-dir, and --output only with one input", async () => {
      for (const argv of [
        ["convert", file("a.mov")],
        ["convert", file("a.mov"), "-o", file("x.mp4"), "--out-dir", file("out")],
        ["convert", file("a.mov"), file("b.mov"), "-o", file("x.mp4")],
      ]) {
        const { code, stderr } = await cli(argv);
        assert.equal(code, EXIT.usage, argv.join(" "));
        assert.match(stderr, /^error: /);
      }
      assert.equal(runner.mock.callCount(), 0);
    });

    it("refuses to overwrite unless --overwrite is given", async () => {
      await writeFile(file("a.mp4"), "existing");
      assert.equal((await cli(["convert", file("a.mov"), "-o", file("a.mp4")])).code, EXIT.error);
      assert.equal((await cli(["convert", file("a.mov"), "-o", file("a.mp4"), "--overwrite"])).code, EXIT.ok);
    });

    it("exits 130 when cancelled", async () => {
      const controller = new AbortController();
      runner = mock.fn<Runner>((command, _args, options) => {
        if (command === "ffprobe") return Promise.resolve(result(0, PROBE_JSON));
        controller.abort();
        return Promise.reject(options?.signal?.reason as Error);
      });
      const { code, stderr } = await cli(["convert", file("a.mov"), file("b.mov"), "--out-dir", file("out")], { signal: controller.signal });
      assert.equal(code, EXIT.aborted);
      assert.match(stderr, /✗ cancelled\n$/);
      assert.equal(runner.mock.callCount(), 2, "the second input must not start");
    });
  });
});

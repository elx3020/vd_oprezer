// The HTTP app with a fake runner, over a real socket (fetch), so uploads,
// streaming and client disconnects behave as in production. No FFmpeg needed.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { RunResult, Runner } from "#core";
import { createApp, type ServerConfig } from "./index.js";

const PROBE_JSON = JSON.stringify({
  format: { format_name: "mov,mp4", duration: "10.0", size: "1000" },
  streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" }],
});

const result = (exitCode: number, stdout = "", stderr = ""): RunResult => ({ exitCode, stdout, stderr });

/** ffprobe answers PROBE_JSON, ffmpeg writes "encoded", -version prints a banner. */
const encodeOk: Runner = async (command, args) => {
  if (args[0] === "-version") return result(0, `${command} version 9.0\n`);
  if (command === "ffprobe") return result(0, PROBE_JSON);
  await writeFile(args.at(-1)!, "encoded");
  return result(0);
};

let workDir: string;
let base: string;
let close: () => Promise<void>;

async function start(config: Partial<ServerConfig> = {}) {
  const runner = mock.fn<Runner>(config.runner ?? encodeOk);
  const app = createApp({ workDir, ...config, runner });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
  close = () => app.close();
  return runner;
}

function form(fields: Record<string, string>, file: { name: string; content: string } | null = { name: "clip.mov", content: "video" }) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  if (file) body.append("file", new Blob([file.content]), file.name);
  return body;
}

const convert = (body: FormData, init: RequestInit = {}) => fetch(`${base}/convert`, { method: "POST", body, ...init });

/** Cleanup runs when the response closes, just after the client got it. */
async function workDirEmpty() {
  for (let i = 0; i < 50 && (await readdir(workDir)).length; i++) await sleep(20);
  assert.deepEqual(await readdir(workDir), []);
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "vd-server-"));
});

afterEach(async () => {
  await close();
  await rm(workDir, { recursive: true, force: true });
});

describe("GET /health and /presets", () => {
  it("reports FFmpeg versions, or 503 when FFmpeg is missing", async () => {
    await start();
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ffmpeg: "ffmpeg version 9.0", ffprobe: "ffprobe version 9.0" });
    await close();

    await start({ runner: () => Promise.reject(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })) });
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "FFMPEG_NOT_FOUND", message: "FFmpeg is not available." });
  });

  it("lists the presets", async () => {
    await start();
    assert.deepEqual(Object.keys((await (await fetch(`${base}/presets`)).json()) as object), ["web", "ecommerce", "youtube", "instagram-reel"]);
  });
});

describe("POST /convert", () => {
  it("encodes the upload with the chosen preset and streams back the MP4", async () => {
    const runner = await start();
    const res = await convert(form({ preset: "ecommerce", crf: "26" }));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="clip-ecommerce.mp4"');
    assert.equal(await res.text(), "encoded");
    const args = runner.mock.calls.at(-1)?.arguments[1] ?? [];
    assert.ok(args.includes("-an"));
    assert.equal(args[args.indexOf("-crf") + 1], "26");
    await workDirEmpty();
  });

  it("accepts option fields after the file, and defaults to web", async () => {
    const runner = await start();
    const body = form({}, { name: "a.mov", content: "x" });
    body.append("maxSize", "480");
    const res = await convert(body);
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="a-web.mp4"');
    assert.equal(await res.text(), "encoded");
    const args = runner.mock.calls.at(-1)?.arguments[1] ?? [];
    assert.equal(args[args.indexOf("-vf") + 1], "scale=852:480");
  });

  it("sanitises the download name and never uses it as a path", async () => {
    await start();
    // FormData sends the quotes as %22.
    const res = await convert(form({}, { name: '../../evil "name".mov', content: "x" }));
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="evil_22name_22-web.mp4"');
    await res.arrayBuffer();
    await workDirEmpty();
  });

  it("rejects invalid options and unknown fields (no raw FFmpeg args) with 400, before encoding", async () => {
    const runner = await start();
    for (const fields of [{ preset: "tiktok" }, { crf: "99" }, { args: "-f null" }] as Record<string, string>[]) {
      const res = await convert(form(fields));
      assert.equal(res.status, 400, JSON.stringify(fields));
      const body = (await res.json()) as { error: string; message: string };
      assert.equal(body.error, "INVALID_ARGUMENT");
      assert.match(body.message, /^Invalid options:/);
    }
    assert.equal(runner.mock.callCount(), 0);
    await workDirEmpty();
  });

  it("rejects a request without a file, or with the file in another field", async () => {
    await start();
    const none = await convert(form({ preset: "web" }, null));
    assert.equal(none.status, 400);
    assert.match(((await none.json()) as { message: string }).message, /field "file"/);

    const body = new FormData();
    body.append("video", new Blob(["x"]), "a.mov");
    const wrongField = await convert(body);
    assert.equal(wrongField.status, 400);
    await wrongField.arrayBuffer();
    await workDirEmpty();
  });

  it("rejects uploads over the size limit and more than one file with 413", async () => {
    await start({ maxUploadBytes: 10 });
    const big = await convert(form({}, { name: "a.mov", content: "x".repeat(100) }));
    assert.equal(big.status, 413);
    await big.arrayBuffer();

    const two = form({});
    two.append("file", new Blob(["y"]), "b.mov");
    const res = await convert(two);
    assert.equal(res.status, 413);
    await res.arrayBuffer();
    await workDirEmpty();
  });

  it("answers 422 for files ffprobe can't read, without leaking paths or FFmpeg output", async () => {
    await start({ runner: () => Promise.resolve(result(1, "", "/tmp/vd-abc/upload: Invalid data found when processing input")) });
    const res = await convert(form({}));
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: "PROBE_FAILED", message: "The upload is not a readable video file." });
  });

  it("answers 500 when FFmpeg fails, without leaking its output", async () => {
    await start({ runner: (command) => Promise.resolve(command === "ffprobe" ? result(0, PROBE_JSON) : result(1, "", "secret /srv/path detail")) });
    const res = await convert(form({}));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "FFMPEG_FAILED", message: "Encoding failed." });
    await workDirEmpty();
  });

  it("kills the encode and cleans up when the client disconnects", async () => {
    let encodeAborted: () => void = () => {};
    const aborted = new Promise<void>((resolve) => (encodeAborted = resolve));
    await start({
      runner: (command, args, options) => {
        if (command === "ffprobe") return Promise.resolve(result(0, PROBE_JSON));
        // Behave like a long encode that only ends when aborted.
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener("abort", () => {
            encodeAborted();
            reject(options.signal?.reason as Error);
          }),
        );
      },
    });
    const client = new AbortController();
    const request = convert(form({}), { signal: client.signal });
    // Wait until the upload is on disk and the encode has started.
    for (let i = 0; i < 100 && !(await readdir(workDir)).length; i++) await sleep(10);
    await sleep(50);
    client.abort();
    await assert.rejects(request, { name: "AbortError" });
    await aborted;
    await workDirEmpty();
  });

  it("cancels running encodes on shutdown", async () => {
    const shutdown = new AbortController();
    await start({
      signal: shutdown.signal,
      runner: (command, _args, options) => {
        if (command === "ffprobe") return Promise.resolve(result(0, PROBE_JSON));
        shutdown.abort();
        return Promise.reject(options?.signal?.reason as Error);
      },
    });
    const res = await convert(form({}));
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, "ABORTED");
    await workDirEmpty();
  });
});

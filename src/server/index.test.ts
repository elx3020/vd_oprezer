// The HTTP app with a fake runner, over a real socket (fetch), so uploads,
// streaming and client disconnects behave as in production. No FFmpeg needed.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { RunResult, Runner } from "#core";
import { createApp, type Job, type ServerConfig } from "./index.js";

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

/** What the server still keeps for /convert requests and jobs. */
async function leftovers() {
  const root = path.join(workDir, "vd-oprezer");
  return [...(await readdir(path.join(root, "convert"))), ...(await readdir(path.join(root, "jobs")))];
}

/** Cleanup runs when the response closes, just after the client got it. */
async function workDirEmpty() {
  for (let i = 0; i < 50 && (await leftovers()).length; i++) await sleep(20);
  assert.deepEqual(await leftovers(), []);
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
    for (let i = 0; i < 100 && !(await leftovers()).length; i++) await sleep(10);
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

/** Runner whose encodes report 50 % and then wait for release(); ffprobe answers at once. */
function blockingRunner() {
  const encodes: { release: () => void; aborted: boolean }[] = [];
  const runner: Runner = (command, args, options) => {
    if (command === "ffprobe") return Promise.resolve(result(0, PROBE_JSON));
    return new Promise((resolve, reject) => {
      const encode = {
        aborted: false,
        release: () => void writeFile(args.at(-1)!, "encoded").then(() => resolve(result(0))),
      };
      options?.signal?.addEventListener("abort", () => {
        encode.aborted = true;
        reject(options.signal?.reason as Error);
      });
      for (const line of ["out_time_us=5000000", "progress=continue"]) options?.onStdoutLine?.(line);
      encodes.push(encode);
    });
  };
  return { runner, encodes };
}

const submit = (body: FormData) => fetch(`${base}/jobs`, { method: "POST", body });
const getJob = async (id: string) => (await fetch(`${base}/jobs/${id}`)).json() as Promise<Job>;

async function until(condition: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200 && !(await condition()); i++) await sleep(10);
  assert.ok(await condition(), "condition not reached in time");
}

async function waitForStatus(id: string, status: Job["status"]) {
  await until(async () => (await getJob(id)).status === status);
  return getJob(id);
}

describe("jobs", () => {
  it("runs a job: 202 + id, poll until done, download, delete", async () => {
    await start();
    const res = await submit(form({ preset: "ecommerce" }));
    assert.equal(res.status, 202);
    const created = (await res.json()) as Job;
    assert.equal(res.headers.get("location"), `/jobs/${created.id}`);
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.filename, "clip-ecommerce.mp4");

    const done = await waitForStatus(created.id, "done");
    assert.equal(done.progress, 100);
    assert.equal(done.sizeBytes, "encoded".length);
    assert.deepEqual(done.options, { preset: "ecommerce" });
    assert.ok(done.finishedAt);
    // The upload is deleted once the encode is over; only the output stays.
    await until(async () => (await readdir(path.join(workDir, "vd-oprezer", "jobs", created.id))).length === 1);
    assert.deepEqual(await readdir(path.join(workDir, "vd-oprezer", "jobs", created.id)), ["output.mp4"]);

    const output = await fetch(`${base}/jobs/${created.id}/output`);
    assert.equal(output.headers.get("content-disposition"), 'attachment; filename="clip-ecommerce.mp4"');
    assert.equal(await output.text(), "encoded");

    assert.equal((await fetch(`${base}/jobs/${created.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${base}/jobs/${created.id}`)).status, 404);
    await workDirEmpty();
  });

  it("runs one encode at a time by default; the rest wait in order with their progress", async () => {
    const { runner, encodes } = blockingRunner();
    await start({ runner });
    const first = ((await (await submit(form({}))).json()) as Job).id;
    const second = ((await (await submit(form({}))).json()) as Job).id;
    await until(() => encodes.length === 1);

    const [a, b] = [await getJob(first), await getJob(second)];
    assert.deepEqual([a.status, a.progress, b.status, b.progress], ["running", 50, "queued", 0]);
    const early = await fetch(`${base}/jobs/${first}/output`);
    assert.equal(early.status, 409);
    assert.deepEqual(await early.json(), { error: "NOT_READY", message: "The job is running." });

    encodes[0]?.release();
    await waitForStatus(first, "done");
    await until(() => encodes.length === 2);
    assert.equal((await getJob(second)).status, "running");
    encodes[1]?.release();
    await waitForStatus(second, "done");
  });

  it("answers 503 when maxQueued encodes are already waiting, for jobs and /convert", async () => {
    const { runner, encodes } = blockingRunner();
    await start({ runner, maxQueued: 1 });
    await submit(form({}));
    await until(() => encodes.length === 1);
    await submit(form({})); // waits

    const full = await submit(form({}));
    assert.equal(full.status, 503);
    assert.equal(((await full.json()) as { error: string }).error, "QUEUE_FULL");
    const convertFull = await convert(form({}));
    assert.equal(convertFull.status, 503);
    await convertFull.arrayBuffer();
    assert.equal((await leftovers()).length, 2, "rejected requests leave no files");
  });

  it("marks the job failed with a safe error when the encode fails", async () => {
    await start({ runner: () => Promise.resolve(result(1, "", "/secret/path: Invalid data found when processing input")) });
    const { id } = (await (await submit(form({}))).json()) as Job;
    const failed = await waitForStatus(id, "failed");
    assert.deepEqual(failed.error, { code: "PROBE_FAILED", message: "The upload is not a readable video file." });
    assert.ok(failed.finishedAt);
    assert.equal((await fetch(`${base}/jobs/${id}/output`)).status, 409);
    await until(async () => (await readdir(path.join(workDir, "vd-oprezer", "jobs", id))).length === 0);
  });

  it("rejects invalid options at submit time, without creating a job", async () => {
    const runner = await start();
    const res = await submit(form({ crf: "99" }));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "INVALID_ARGUMENT");
    assert.equal(runner.mock.callCount(), 0);
    await workDirEmpty();
  });

  it("DELETE cancels a running job, kills its encode and removes its files", async () => {
    const { runner, encodes } = blockingRunner();
    await start({ runner });
    const { id } = (await (await submit(form({}))).json()) as Job;
    await until(() => encodes.length === 1);

    assert.equal((await fetch(`${base}/jobs/${id}`, { method: "DELETE" })).status, 204);
    assert.equal(encodes[0]?.aborted, true);
    assert.equal((await fetch(`${base}/jobs/${id}`)).status, 404);
    await workDirEmpty();
  });

  it("expires finished jobs and their output after jobTtlMs", async () => {
    await start({ jobTtlMs: 50 });
    const { id } = (await (await submit(form({}))).json()) as Job;
    await waitForStatus(id, "done");
    await until(async () => (await fetch(`${base}/jobs/${id}`)).status === 404);
    await workDirEmpty();
  });

  it("answers 404 for unknown jobs", async () => {
    await start();
    for (const [method, url] of [["GET", "/jobs/nope"], ["GET", "/jobs/nope/output"], ["DELETE", "/jobs/nope"], ["GET", "/jobs/..%2F..%2Fetc"]] as const) {
      const res = await fetch(`${base}${url}`, { method });
      assert.equal(res.status, 404, `${method} ${url}`);
      assert.equal(((await res.json()) as { error: string }).error, "NOT_FOUND");
    }
  });

  it("wipes files from a previous run at start, and everything at close, stopping running encodes", async () => {
    const stale = path.join(workDir, "vd-oprezer", "jobs", "old-job");
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "upload"), "x");

    const { runner, encodes } = blockingRunner();
    await start({ runner });
    assert.deepEqual(await leftovers(), []);

    await submit(form({}));
    await until(() => encodes.length === 1);
    await close();
    assert.equal(encodes[0]?.aborted, true);
    assert.deepEqual(await readdir(workDir), []);
  });
});

/** Opens a job's event stream; yields its events (keep-alive comments skipped) until the server ends it. */
async function* events(id: string): AsyncGenerator<{ event: string; job: Job }> {
  const res = await fetch(`${base}/jobs/${id}/events`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body!) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith(":")) continue;
      yield { event: /^event: (.*)$/m.exec(block)?.[1] ?? "", job: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null") as Job };
    }
  }
}

describe("GET /jobs/:id/events", () => {
  it("sends the job now and on every change, then ends when it's done", async () => {
    const { runner, encodes } = blockingRunner();
    await start({ runner });
    await submit(form({}));
    const { id } = (await (await submit(form({}))).json()) as Job;
    await until(() => encodes.length === 1);

    const seen: [string, Job["status"], number][] = [];
    for await (const { event, job } of events(id)) {
      seen.push([event, job.status, job.progress]);
      if (seen.length === 1) encodes[0]?.release(); // first job ends, ours starts
      if (job.progress === 50) encodes[1]?.release();
    }
    assert.deepEqual(seen, [
      ["job", "queued", 0],
      ["job", "running", 0],
      ["job", "running", 50],
      ["job", "done", 100],
    ]);
    assert.ok((await getJob(id)).finishedAt);
  });

  it("sends one event and ends at once for a finished job", async () => {
    await start({ runner: () => Promise.resolve(result(1, "", "Invalid data found when processing input")) });
    const { id } = (await (await submit(form({}))).json()) as Job;
    await waitForStatus(id, "failed");
    const all = [];
    for await (const e of events(id)) all.push(e);
    assert.equal(all.length, 1);
    assert.deepEqual([all[0]?.job.status, all[0]?.job.error?.code], ["failed", "PROBE_FAILED"]);
  });

  it("sends 'deleted' and ends when the job is deleted while watched", async () => {
    const { runner, encodes } = blockingRunner();
    await start({ runner });
    const { id } = (await (await submit(form({}))).json()) as Job;
    await until(() => encodes.length === 1);

    const seen: string[] = [];
    for await (const { event } of events(id)) {
      seen.push(event);
      if (seen.length === 1) await fetch(`${base}/jobs/${id}`, { method: "DELETE" });
    }
    assert.deepEqual(seen, ["job", "deleted"]);
  });

  it("answers 404 for unknown jobs, which also stops EventSource from reconnecting", async () => {
    await start();
    const res = await fetch(`${base}/jobs/nope/events`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, "NOT_FOUND");
  });

  it("ends open streams on shutdown instead of keeping the server alive", async () => {
    const { runner, encodes } = blockingRunner();
    await start({ runner });
    const { id } = (await (await submit(form({}))).json()) as Job;
    await until(() => encodes.length === 1);

    const stream = events(id);
    const first = await stream.next();
    assert.equal(first.done ? undefined : first.value.job.status, "running");
    await close();
    assert.equal((await stream.next()).done, true);
  });
});

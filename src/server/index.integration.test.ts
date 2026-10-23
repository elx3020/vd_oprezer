// POST /convert end to end with real FFmpeg. Skipped when FFmpeg isn't on PATH.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { createEngine } from "#core";
import { createApp, type Job } from "./index.js";

const exec = promisify(execFile);
const engine = createEngine();
const available = await engine.versions().then(
  () => true,
  () => false,
);

describe("POST /convert with real FFmpeg", { skip: !available && "ffmpeg/ffprobe not found on PATH" }, () => {
  let dir: string;
  let workDir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vd-server-ffmpeg-"));
    workDir = await mkdtemp(path.join(tmpdir(), "vd-server-work-"));
    const lavfi = ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60", "-f", "lavfi", "-i", "sine=frequency=440"];
    await exec("ffmpeg", ["-v", "error", ...lavfi, "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", path.join(dir, "product.mov")]);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("uploads a 1080p60 clip and gets back a silent 720p30 ecommerce MP4", async () => {
    const server = createApp({ workDir });
    const base = await server.listen({ host: "127.0.0.1", port: 0 });
    try {
      const body = new FormData();
      body.append("preset", "ecommerce");
      body.append("file", new Blob([await readFile(path.join(dir, "product.mov"))]), "product.mov");
      const res = await fetch(`${base}/convert`, { method: "POST", body });
      assert.equal(res.status, 200, await res.clone().text());

      const out = path.join(dir, "out.mp4");
      await writeFile(out, Buffer.from(await res.arrayBuffer()));
      const info = await engine.probe(out);
      assert.deepEqual([info.video?.codec, info.video?.width, info.video?.height, info.video?.fps, info.audio], ["h264", 1280, 720, 30, undefined]);
    } finally {
      await server.close();
    }
    // close() deletes everything the server kept.
    assert.deepEqual(await readdir(workDir), []);
  });

  it("runs the same encode as a job: submit, poll, download", async () => {
    const server = createApp({ workDir });
    const base = await server.listen({ host: "127.0.0.1", port: 0 });
    try {
      const body = new FormData();
      body.append("preset", "ecommerce");
      body.append("file", new Blob([await readFile(path.join(dir, "product.mov"))]), "product.mov");
      const { id } = (await (await fetch(`${base}/jobs`, { method: "POST", body })).json()) as Job;

      let job: Job;
      do {
        await sleep(100);
        job = (await (await fetch(`${base}/jobs/${id}`)).json()) as Job;
      } while (job.status === "queued" || job.status === "running");
      assert.equal(job.status, "done", JSON.stringify(job.error));

      const out = path.join(dir, "job.mp4");
      await writeFile(out, Buffer.from(await (await fetch(`${base}/jobs/${id}/output`)).arrayBuffer()));
      const info = await engine.probe(out);
      assert.deepEqual([info.video?.width, info.video?.height, info.audio], [1280, 720, undefined]);
      assert.equal(info.sizeBytes, job.sizeBytes);
    } finally {
      await server.close();
    }
  });
});

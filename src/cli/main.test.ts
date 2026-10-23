// The real entry point (main.ts) in a child process, run from source.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const main = ["--import", "tsx", "--conditions=source", "src/cli/main.ts"];

it("prints the version from package.json", async () => {
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
  const { stdout } = await exec(process.execPath, [...main, "--version"], { cwd: root });
  assert.equal(stdout, `${version}\n`);
});

const hasFfmpeg = await exec("ffmpeg", ["-version"]).then(
  () => true,
  () => false,
);
const skip =
  process.platform === "win32" ? "Windows can't send SIGINT to a child process" : !hasFfmpeg && "ffmpeg not found on PATH";

describe("Ctrl+C", { skip }, () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vd-main-"));
    const lavfi = ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-t", "2"];
    await exec("ffmpeg", ["-v", "error", ...lavfi, "-c:v", "libx264", "-preset", "ultrafast", path.join(dir, "in.mp4")]);
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it("cancels the job: exit 130, no files left, FFmpeg gone", { timeout: 20_000 }, async () => {
    // loop=-1 makes the job endless, so only Ctrl+C can end it.
    const args = ["convert", path.join(dir, "in.mp4"), "-o", path.join(dir, "out.mp4"), "--", "-vf", "loop=loop=-1:size=30", "-c:v", "libx264"];
    // detached = own process group, so we can signal the CLI and FFmpeg together like a terminal does.
    const child = spawn(process.execPath, [...main, ...args], { cwd: root, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
    const exitCode = new Promise<number | null>((resolve) => child.on("exit", resolve));

    while (!(await readdir(dir)).some((f) => f.includes(".partial"))) await sleep(50);
    process.kill(-child.pid!, "SIGINT");

    assert.equal(await exitCode, 130, stderr);
    assert.deepEqual(await readdir(dir), ["in.mp4"]);
    // Signal 0 only checks existence: ESRCH means no process of the group (FFmpeg included) is left.
    assert.throws(() => process.kill(-child.pid!, 0), { code: "ESRCH" });
  });
});

#!/usr/bin/env node
// Composition root for the CLI: the only file that reads the real process
// (argv, env vars, signals) and turns it into plain arguments for run().
import { readFileSync } from "node:fs";
import { EXIT, run } from "./index.js";

// Same relative path from src/cli/main.ts and dist/cli/main.js.
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

const controller = new AbortController();
let abortedAt = 0;

// Ctrl+C / `docker stop`: cancel the running job; run() then cleans up and returns.
// Signals that arrive right after the first one are ignored (wrappers like tsx
// or npm relay Ctrl+C, so one key press can arrive twice). Pressing again
// later forces an exit.
const onSignal = () => {
  if (!controller.signal.aborted) {
    abortedAt = Date.now();
    controller.abort();
  } else if (Date.now() - abortedAt > 1000) {
    process.exit(EXIT.aborted);
  }
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

// Safety net: if we exit for any other reason (crash, process.exit), kill
// FFmpeg synchronously so it never keeps running as an orphan.
process.on("exit", () => controller.abort());

process.exitCode = await run(process.argv.slice(2), {
  signal: controller.signal,
  version,
  ffmpegPath: process.env.FFMPEG_PATH,
  ffprobePath: process.env.FFPROBE_PATH,
});

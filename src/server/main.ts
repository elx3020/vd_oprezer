// Composition root for the server: the only file that reads env vars.
import { describeServer } from "./index.js";

console.log(
  await describeServer({
    port: Number(process.env.PORT ?? 3000),
    ffmpegPath: process.env.FFMPEG_PATH,
    ffprobePath: process.env.FFPROBE_PATH,
  }),
);

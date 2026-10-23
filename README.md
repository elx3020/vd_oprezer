# vd_oprezer

**V**i**d**eo **op**timizer **re**si**zer**: convert video format, compression,
bitrate and size with presets (web, YouTube, Instagram, ...). It ships as a
CLI, an HTTP service, and a Docker image containing both.

> Status: the FFmpeg engine (probe, transcode, progress, cancel) works. The CLI
> is a temporary minimal version; the real CLI, presets and the HTTP API come
> next, one decision at a time.

## Requirements

- Node.js 24+
- FFmpeg + ffprobe on `PATH`, or set `FFMPEG_PATH` / `FFPROBE_PATH` (the Docker image will include them)

## Quick start

```bash
npm install
npm run dev:cli -- probe input.mp4          # run the CLI from source
npm run dev:cli -- convert in.mov out.mp4 -- -vf scale=-2:720 -c:v libx264 -crf 26 -c:a aac -b:a 128k
npm run dev:server                          # run the server from source (watch mode)
npm run check                               # typecheck + lint + module boundary checks
npm run build                               # compile to dist/
```

## Layout

```
src/core/     library (presets, FFmpeg args, run, probe)
src/cli/      command-line interface
src/server/   HTTP service
modules.config.js   which npm packages each module may use
docs/ARCHITECTURE.md   boundaries, guardrails, and how to split into packages
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before adding code or dependencies.

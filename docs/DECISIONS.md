# Decisions

Each step: compare options → Esteban chooses → implement with tests →
`npm run check` → update this file.

| # | Decision | Status | Choice |
|---|----------|--------|--------|
| 1 | Project shape & language | ✅ done | Single package, TypeScript, Node 24, ESM, npm; boundary guardrails |
| 2 | How core runs FFmpeg | ✅ done | `node:child_process` spawn, no runtime deps |
| 3 | Testing | ✅ done | `node:test` via tsx, no new deps |
| 4 | CLI framework | ✅ done | commander 15 + `@commander-js/extra-typings` |
| 5 | Presets & validation | ✅ done | Presets as typed data in core; zod 4 schema shared by CLI and HTTP |
| 6 | HTTP server & uploads | ✅ done | Fastify 5 + `@fastify/multipart`, uploads streamed to disk |
| 7 | Job queue | ✅ done | In memory, own FIFO limiter, no deps; shaped for persistence later |
| 8 | Progress reporting to HTTP clients | ✅ done | Server-Sent Events, no deps; polling still works |
| 9 | Docker image | ✅ done | Own minimal static FFmpeg + Alpine + node binary + bundled app: 65.5 MB compressed |
| 10 | CI | ✅ done | GitHub Actions, one job: the Docker `test` stage + runtime image, GHA layer cache |
| 11 | CD | ✅ done | Version tags publish the runtime image to GHCR, after the `test` stage |

---

## 1. Project shape & language ✅

One npm package with folders `src/core`, `src/cli`, `src/server`, each written
like a future package. Chosen over a monorepo: less setup now, and the
guardrails in `docs/ARCHITECTURE.md` keep a later split to moving folders and
one find/replace (`"#core"` → `"@vd-oprezer/core"`).

## 2. How core runs FFmpeg ✅

Node's built-in `spawn` (over execa or a wrapper like ffmpeg-forge, which was
created because fluent-ffmpeg is deprecated). Built-in `spawn` covers what we
need, and core keeps zero runtime dependencies. Implemented: `createEngine`
with `versions`, `probe`, `transcode`; progress via `-progress pipe:1`;
cancellation via AbortSignal (instant SIGKILL); temp-file + rename output;
`VdError` codes; injectable `runner`.

The behaviours below were verified by hand. They are now covered by
`src/core/engine.integration.test.ts`, and the last one by `src/cli/main.test.ts`
(decisions 3 and 4):

- probe: 1080p30 h264/aac file → correct duration, size, codecs, fps, channels
- probe: clip with display rotation 90 → `rotation: 90`
- probe: text file named `.mp4` → `PROBE_FAILED` ("Invalid data found when processing input")
- transcode: success writes output, reports progress ending at 100 %, returns size/elapsed
- output exists, no overwrite → `OUTPUT_EXISTS`, existing file untouched
- overwrite → replaced
- missing input → `INPUT_NOT_FOUND`
- input == output → `INVALID_ARGUMENT`
- bad encoder (`-c:v not_a_codec`) → `FFMPEG_FAILED` with "Encoder not found", no output left
- wrong ffmpeg path → `FFMPEG_NOT_FOUND`
- `AbortSignal.timeout(3000)` → rejects with `TimeoutError`, no `.partial` file left, no ffmpeg process left
- CLI Ctrl+C (SIGINT to the whole process group, under tsx and built JS) → exit 130, no partial file, no ffmpeg left

## 3. Testing ✅

Node's built-in `node:test` + `node:assert/strict`, run through tsx (already
installed) with `--conditions=source` so `#core` resolves to source.
Chosen over Vitest: nothing we need is missing (the engine takes an injected
`runner`, so no module mocking), it adds zero dependencies, and test files
only import `node:*`, so the module boundary rules stay as they are. Vitest
was the alternative; switching later means changing the imports in the test
files. Reasons to switch: coverage thresholds in CI, or a slow watch loop.

- `npm test`, `npm run test:watch`; `npm run check` runs the tests last.
- Unit (no FFmpeg): `progress.test.ts`, `probe.test.ts`, `engine.test.ts`
  (fake runner via `mock.fn`).
- Integration: `engine.integration.test.ts` generates clips with lavfi in a
  temp dir and covers the decision-2 list. The whole suite is skipped, with
  a message, when `ffmpeg`/`ffprobe` aren't on PATH. Verified passing on
  Windows with FFmpeg 9.0.2 (`winget install Gyan.FFmpeg`).
- ESLint: `no-floating-promises` allows node:test's `describe`/`it`.
- Not covered yet: "no ffmpeg process left" is implied (the runner settles
  only after the process's `close` event), not checked against the OS
  process list. HTTP tests come with decision 6.

## 4. CLI framework ✅

**commander 15 + @commander-js/extra-typings**: no transitive deps, the
de-facto standard, with subcommands, variadic args, generated help and typed
options. Alternatives considered: `util.parseArgs` (no subcommands or help),
yargs (overlaps with zod, weaker types), citty/clipanion (less familiar).
commander is listed for `cli` as extra-typings' peer; code imports only
`@commander-js/extra-typings`.

Implemented now (presets and their flags wait for decision 5):

```
vd-oprezer convert <inputs...> (-o out.mp4 | --out-dir dir) [--overwrite] [-- ffmpeg args]
vd-oprezer probe <input> [--json]
vd-oprezer version          # also -V/--version, -h/--help
```

- `run(argv, ctx)` stays side-effect free: commander's `exitOverride` throws
  instead of exiting, and output goes to `ctx.stdout`/`ctx.stderr`, so tests
  capture it. Exit codes: 0 ok, 1 a file failed, 2 usage, 130 cancelled.
- Arguments after the first `--` are split off before commander parses, so
  they reach FFmpeg as-is instead of becoming more inputs.
- Several inputs run one after another. A failed file is reported and the
  batch continues (exit 1). Cancelling stops the batch.
- `--output`/`--out-dir` is required for now. `--out-dir` keeps each input's
  file name. Default naming and the output container come with presets.
- Progress line only when stderr is a TTY. `main.ts` reads the version from
  `package.json`, so the Docker image must include that file.
- Tests: `cli/index.test.ts` (fake runner, captured output) and
  `cli/main.test.ts` (spawns `main.ts` from source). The Ctrl+C test sends
  SIGINT to the process group and checks exit 130, no files left and no
  FFmpeg left. Windows can't send SIGINT to a child process, so it skips
  there; it runs and passes in the Docker test stage (decision 9).
- Later, if wanted: `@inquirer/prompts` for interactive prompts.

## 5. Presets & validation ✅

**zod 4** checks what users choose (`encodeOptionsSchema` in
`core/presets.ts`): `preset` (default `web`), `crf` (0–51) and `maxSize`
(16–8192, short side). Unknown keys are rejected and numbers are coerced,
because CLI flags and multipart fields arrive as strings. Chosen over
valibot (less familiar, JSON Schema export is a separate package) and
hand-written checks (type and checks drift apart, no JSON Schema). The cost
is core's first runtime dependency; zod itself has none. `z.toJSONSchema`
can feed the HTTP API docs in decision 6.

- Presets are typed data (`PRESETS`), checked by TypeScript, not at runtime.
- `buildArgs(options, mediaInfo)` turns options plus the probed input into
  FFmpeg arguments. `engine.transcode` accepts `args` as a function of the
  probe result, so this needs no second probe.
- Raw FFmpeg arguments are not in the schema on purpose: only the CLI
  (after `--`) may pass them, never the HTTP API.
- All presets: libx264, yuv420p (4:2:0), MP4 with the index at the front
  (`+faststart`). Sizes are rounded to even numbers. `maxSize` limits the
  short side of the displayed (rotated) picture and never upscales.

| Preset | Settings | Source |
|---|---|---|
| `web` | CRF 23, medium, max 1080, AAC 128k, metadata stripped | — |
| `ecommerce` | CRF 22, slow, max 720, max 30 fps, **no audio**, metadata stripped. For silent product videos in cards and half-width sections (720 covers a ~half-width slot at 2× density) | Esteban's request |
| `youtube` | CRF 18, slow, source size and fps, GOP = fps/2, 2 B-frames, AAC 384k 48 kHz | [YouTube upload settings](https://support.google.com/youtube/answer/1722171) |
| `instagram-reel` | CRF 20, medium, max 1080, max 60 fps, max 25 Mbps, AAC 128k 48 kHz; rejects inputs outside 3 s to 15 min before encoding | [Meta IG media reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/) |

- CLI: `convert -p <preset> [--crf n] [--max-size px]`, plus
  `presets [name]`. Default output is `<name>-<preset>.mp4` next to the
  input; `--out-dir` writes `<name>.mp4`.
- Tests: `presets.test.ts` (schema, args per preset, scaling with rotation,
  duration limits) and an integration test per preset that encodes with
  real FFmpeg and checks the probed result.
- Not done yet: cropping or padding to 9:16 (`--fit`), WebM/AV1 versions for
  the web, a 300 MB size check for Reels, and an `instagram-feed` (4:5) preset.

## 6. HTTP server & uploads ✅

**Fastify 5 + @fastify/multipart.** Chosen over Express 5 + multer (logging,
test requests and graceful shutdown would need 3–4 extra packages), Hono
(its body parser keeps uploads in memory) and `node:http` + busboy (all the
HTTP code by hand).

```
GET  /health    ffmpeg/ffprobe versions; 503 when FFmpeg is missing
GET  /presets   PRESETS
POST /convert   multipart: "file" + preset/crf/maxSize fields, in any order → the MP4
```

- `createApp(config)` in `server/index.ts` never listens or reads env.
  `main.ts` reads `PORT` (3000), `HOST` (127.0.0.1; the Docker image will
  set 0.0.0.0), `MAX_UPLOAD_MB` (2048), `WORK_DIR` (OS temp), `FFMPEG_PATH`
  and `FFPROBE_PATH`.
- The upload streams to `WORK_DIR/vd-*/upload`; the client's filename only
  names the download, sanitised. Limits: 1 file, `MAX_UPLOAD_MB`, 10 short
  fields. The work dir is deleted once the response is done, or on any error.
- Options go through `parseEncodeOptions`, so unknown fields (raw FFmpeg
  args, for example) are rejected with 400.
- Errors: `INVALID_ARGUMENT` 400, too large / more than 1 file 413,
  `PROBE_FAILED` 422, `FFMPEG_FAILED` 500, `FFMPEG_NOT_FOUND` 503. Messages
  for 422/5xx are fixed texts, so FFmpeg output and server paths never reach
  clients; 5xx are logged.
- A client disconnect aborts the encode (FFmpeg killed). Shutdown
  (SIGINT/SIGTERM) aborts every encode (503), closes the server, and exits
  after 5 s at the latest: a client that stops reading its download would
  otherwise keep `close()` waiting forever (seen in testing).
- Tests: `server/index.test.ts` (fake runner over a real socket: uploads,
  limits, field order, sanitising, error mapping, disconnect, shutdown),
  `index.integration.test.ts` (real FFmpeg upload → 720p30 silent MP4) and
  `main.test.ts` (spawns `main.ts`; the SIGTERM part is skipped on Windows
  and passes in the Docker test stage).
- Decision 7 added jobs and a concurrency limit; `/convert` now waits for
  a slot in the same queue.

## 7. Job queue ✅

**In memory, with our own limiter** (`server/queue.ts`, about 40 lines): at
most `concurrency` encodes at once, FIFO order, and a waiting task leaves the
queue when its AbortSignal aborts. Chosen over p-queue (it would save about
15 lines; we don't need priorities, timeouts or events), BullMQ + Redis (a
second service plus shared storage, against the "one image" goal) and
SQLite via `node:sqlite` (experimental, and running encodes restart
anyway).

```
POST   /jobs              multipart, same fields as /convert → 202 Job, Location: /jobs/:id
GET    /jobs/:id          Job: status queued|running|done|failed, progress 0–100, error?, sizeBytes?
GET    /jobs/:id/output   the MP4 once done (409 NOT_READY before)
DELETE /jobs/:id          cancel (kills FFmpeg) and delete files → 204
```

- Settings: `CONCURRENCY` (1, since x264 already uses every core),
  `MAX_QUEUED` (20 waiting encodes, jobs and `/convert` together; more get
  503 `QUEUE_FULL` before the upload is read), `JOB_TTL_MIN` (60: finished
  jobs and outputs are deleted after this, downloaded or not).
- Job ids are random UUIDs, so job URLs can't be guessed (there is no auth).
  Paths are only built from ids of known jobs.
- Files: `WORK_DIR/vd-oprezer/jobs/<id>/upload`, deleted when the encode
  ends, then `output.mp4`. `/convert` uses `WORK_DIR/vd-oprezer/convert/`.
  The whole `vd-oprezer` folder is wiped at startup and on close, so it's
  one server per `WORK_DIR`.
- A failed job keeps a safe `error { code, message }` (same mapping as HTTP
  errors, `server/errors.ts`); 5xx causes are logged with the job id.
- Not handled yet: uploads still in progress don't count toward
  `MAX_QUEUED`, so a burst can go over it by the number of concurrent uploads.

**Adding restart persistence later.** It was a requirement to leave room for this:
- `Job` is plain JSON-serialisable data, and it's what a store would save.
- Job files already sit at fixed paths derived from the id.
- All job state changes happen in `server/jobs.ts`.

To add it: save the `Job` on each change (a JSON file per job dir, or
`node:sqlite`), and in the `onReady` hook in `server/index.ts` reload saved
jobs instead of wiping the folder: re-queue `queued`/`running` ones, keep
`done`/`failed` ones and restart their expiry timers. Clients and the HTTP
API don't change. Several workers would also need shared storage plus
BullMQ or similar, which is a bigger step.

- Tests: `server/queue.test.ts` (limit, FIFO, abort while waiting, failures
  free the slot), jobs in `server/index.test.ts` (lifecycle, one-at-a-time
  with progress, queue full, failed job, invalid options, DELETE while
  running, expiry, 404s, wipe at start and close) and a real-FFmpeg job in
  `index.integration.test.ts`.

## 8. Progress reporting to HTTP clients ✅

**Server-Sent Events, written ourselves** (about 30 lines, no dependency):
`GET /jobs/:id/events`. Chosen over polling only (still works, but updates
come only as often as clients ask), WebSocket (two-way isn't needed; a
dependency plus a protocol upgrade proxies must allow) and webhooks (the
server would call client-chosen URLs: an SSRF risk that breaks the "never
fetch arbitrary URLs" rule; worth it later, with an allowlist, if a
backend client needs it).

```
event: job
data: {"id":"…","status":"running","progress":42,…}     ← the full Job, same as GET /jobs/:id
```

- The full job is sent on connect, then again on every status change and
  every whole-percent step. The stream ends after `done`/`failed`, or with
  `event: deleted` when the job is deleted or expires.
- A `: keep-alive` comment every 15 s keeps proxies from closing quiet
  streams. `X-Accel-Buffering: no` keeps nginx from buffering.
- Browser clients: `EventSource` reconnects whenever a stream ends, so call
  `close()` on `done`/`failed`. Unknown or expired jobs answer 404, which
  stops reconnecting for good.
- Shutdown ends all streams: the abort moved to Fastify's `preClose` hook,
  since `close()` waits for open requests first (verified: with the abort
  in `onClose`, close hangs).
- Bug found by watching a real encode: FFmpeg sometimes reports
  `out_time` as N/A while flushing near the end, and the parser turned that
  into 0 %, so progress went 98 → 0 → 100. The parser now keeps the last
  known time (`core/progress.ts`, with a test).
- Tests: 5 SSE tests in `server/index.test.ts` (live sequence queued →
  running → 50 % → done, finished job, deleted while watched, 404,
  shutdown ends streams).

## 9. Docker image ✅

Goal: as small as possible. **Our own minimal static FFmpeg** (option D)
was chosen over Debian's FFmpeg on `node:24-slim` (A, hundreds of MB of
libraries), Alpine's FFmpeg (B, every codec Alpine builds) and a prebuilt
static FFmpeg (C, `mwader/static-ffmpeg` is 126 MB compressed on its own).

Stages in `Dockerfile`:
1. `ffmpeg` (`alpine:3.24`): x264 (pinned commit) + FFmpeg 9.0.2,
   `--disable-everything`, then only what we use. Static musl binaries,
   stripped: ffmpeg 14.6 MB + ffprobe 14.4 MB. About 2.5 min on 16 cores,
   cached afterwards.
2. `build` (`node:24.22.1-alpine3.24`): `npm ci`, `npm run bundle`
   (`scripts/bundle.js`, esbuild: one file each for the CLI and the server).
3. `test`: `npm run check` against this FFmpeg on Linux (101 tests, nothing
   skipped, including CLI Ctrl+C and server SIGTERM), then a smoke test of
   the bundles. `docker build --target test .`
4. Runtime (`alpine:3.24` + `libstdc++` + the `node` binary copied from the
   node image): no npm/yarn, no `node_modules`. Non-root user `node`.
   `HOST=0.0.0.0 PORT=3000 WORK_DIR=/tmp/vd`. Health check on `/health`.
   `docker/entrypoint.sh`: `serve` (default) starts the server, anything
   else goes to the CLI. Node runs as PID 1 and handles SIGTERM itself.

FFmpeg components enabled (an input format not listed fails cleanly with
422 / `FFMPEG_FAILED`; add it to the configure flags and rebuild):
- Demuxers: mov (MOV/MP4/M4V/3GP), matroska (MKV/WebM), avi, mpegts,
  mpegps, flv, ogg, wav. Muxers: mp4, mov.
- Decoders: h264, hevc, vp8, vp9, prores, mpeg4, mpeg2video, mjpeg; aac,
  mp3, opus, vorbis, flac, alac, ac3, eac3, pcm. **No AV1 decoding** (it
  needs libdav1d, another library to build). Add it if AV1 uploads show up.
- Encoders: libx264, aac. Filters: scale, fps, aresample, transpose, hflip,
  vflip, loop. `lavfi`, `testsrc2` and `sine` are enabled only so the test
  suite can generate clips with the same FFmpeg (a few KB).

Size, measured (compressed = what a pull downloads):

| Step | Compressed | Uncompressed |
|---|---|---|
| `node:24-alpine` + FFmpeg + `node_modules` | 77.3 MB | 320 MB |
| Base: plain Alpine + `node` binary (no npm/yarn) | 68.4 MB | 196 MB |
| App bundled with esbuild (no `node_modules`) | **65.5 MB** | **168 MB** |

What's left: the `node` binary (126 MB uncompressed) is the floor, then
FFmpeg (29 MB). Building FFmpeg as shared libraries would stop ffmpeg and
ffprobe each carrying their own copy, an estimated ~4 MB compressed more.
Not done yet.

- Usage: `docker run -p 3000:3000 vd-oprezer`, or
  `docker run --rm -v "$PWD:/data" -w /data vd-oprezer convert clip.mov -p ecommerce`.
  On Linux hosts, add `--user "$(id -u):$(id -g)"` so outputs in the
  mounted folder belong to you.
- Verified by hand: a job over SSE and its download, `docker stop` (exit 0
  in 0.6 s), CLI convert and probe on a mounted folder, health check healthy.
- libx264 makes this a GPL build of FFmpeg: fine for running a service,
  with GPL obligations if the image is distributed.

## 10. CI ✅

**GitHub Actions, one Docker job** (`.github/workflows/ci.yml`), on pushes
to `main` and on pull requests: `docker build --target test .`, then the
runtime image. Chosen over adding a native Windows job (B: repeats the
`npm run check` Esteban runs locally before a change is done, with a
Chocolatey FFmpeg that isn't 9.0.2 and signal tests that skip there
anyway) and a native Ubuntu job (C: apt's FFmpeg 6.1 has every codec, so
it would miss a filter or codec not enabled in the Dockerfile, the main
thing CI should catch here).

- CI tests what ships: same FFmpeg, Node and Alpine, nothing skipped
  (CLI Ctrl+C, server SIGTERM), plus the bundle smoke test.
- Layer cache in the GitHub Actions cache (`type=gha,mode=max`), so the
  FFmpeg stage (~10 min on a 4-core runner) is rebuilt only when its
  Dockerfile lines change, or after 7 days unused (GitHub evicts it).
- A new push to the same branch or PR cancels the run still going.
  `contents: read` only; nothing is pushed anywhere.
- Not done yet: Dependabot/Renovate, branch protection requiring the
  check, a Windows job once others contribute. Publishing: decision 11.

## 11. CD ✅

**Pushing a version tag publishes the runtime image to GHCR**
(`.github/workflows/cd.yml`). Chosen over publishing every push to `main`
(an image per commit; nothing marks a release) and Docker Hub (a second
account plus a token secret; GHCR uses the workflow's `GITHUB_TOKEN`).

```
git tag v0.2.0 && git push origin v0.2.0
docker pull ghcr.io/elx3020/vd_oprezer:0.2.0     # also :0.2 and :latest
```

- Release steps: bump `version` in `package.json`, commit, tag `v<version>`,
  push the tag. The job fails if the tag and `package.json` disagree,
  because `vd-oprezer version` prints the `package.json` version.
- The `test` stage runs again before the push: a tag can point at any
  commit. It reads main's GHA cache, so a tag on a commit CI already built
  rebuilds almost nothing. The job doesn't write to the cache (other refs
  couldn't read a tag's cache).
- Tags from `docker/metadata-action`: `1.2.3`, `1.2` and `latest`. A
  pre-release tag (`v1.3.0-rc.1`) gets only its own tag, not `1.3` or
  `latest`. OCI labels link the package to the repository.
- Permissions: `contents: read`, `packages: write`. No secrets to set up.
- Check the package's visibility under the repository's Packages after
  the first publish. If it's public, the GPL note in decision 9 applies:
  that's distributing a GPL build of FFmpeg.
- Not done yet: arm64 images (FFmpeg would build under QEMU emulation,
  much slower, or on an arm64 runner), signing/attestations, GitHub
  Releases with notes.

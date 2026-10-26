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
| 12 | Web demo | ✅ done | `web/`: vanilla TypeScript + Vite on GitHub Pages, backend adapter, flow + expert log; opt-in CORS in the server |
| 13 | Auth key & config visibility | ✅ done | Optional `AUTH_KEY` read at runtime, `Authorization: Bearer`; redacted config in the startup log and `GET /config`; local `.env.local`; the web demo sends the key (fetch-based SSE) |

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
- Job ids are random UUIDs, so job URLs can't be guessed (auth is optional, decision 13).
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
- Not done yet: publishing the image (GHCR on tags), Dependabot/Renovate,
  branch protection requiring the check, a Windows job once others contribute.

## 12. Web demo ✅

**What and why.** A public demo page on GitHub Pages where anyone can try
the service: pick a video, pick a preset, watch it convert, see the size
before and after, preview the result and download it. By default it runs
against Esteban's own demo server. It shows off the API, but it's for
regular visitors, not only developers: plain words by default, plus an
**expert mode** that shows the technical trail (requests, live job events,
timings) for anyone who wants to follow the process and the outcome.

The web app is **independent** of core, cli and server. It lives in `web/`
with its own `package.json` and CI, and imports nothing from `src/`. The UI
talks to a small **backend contract** (what any video-conversion service
does). One adapter maps that contract onto vd-oprezer's HTTP API; another
service means another adapter, with no UI change.

Esteban's choices:
- **Stack: vanilla TypeScript + Vite**, plain CSS, no runtime dependencies.
  Chosen over Preact + Vite (~5 KB, components and signals) and React +
  Vite (~50 KB+): one screen with a few states doesn't need a framework,
  and the adapter is plain TypeScript either way, so moving to Preact later
  rewrites only the view.
- **Layout: flow + side log.** Chosen over one column with a "Technical
  details" box per step, and a step-by-step wizard.
- **Audience:** visitors trying the API, with an expert mode. **Backend:**
  his own public demo server by default, any URL in expert mode.
- **Result view:** size before and after, plus a preview of the converted
  video.

Goals:
- A visitor on the Pages site converts a clip on the demo server end to
  end, and expert mode shows every step of it.
- Connecting another backend = one new adapter file + changing the import
  in `web/src/main.ts`. Nothing else in the UI changes.
- A push to `main` that changes `web/` deploys the site; server changes
  don't, and web changes don't run the server's Docker CI.

Out of scope this round: hosting/deploying the demo server, auth or
per-visitor rate limits, custom `crf`/`maxSize` in the UI, a history of
past conversions, several files at once, an original-vs-result
side-by-side, translations.

Would make it a failure even if it works: UI code that knows vd-oprezer's
URLs or JSON (that belongs in the adapter only); jargon or raw error codes
in the default (non-expert) view; `web/` importing from `src/`.

### 12a. Opt-in CORS in the server

The server sends no CORS headers today, so a page on another origin can't
call it. Add:

- `ServerConfig.corsOrigins?: string[]`. Default: none, so no CORS headers
  (same as today). `main.ts` reads `CORS_ORIGINS`, comma-separated; `*`
  allows any origin. An origin is scheme + host (+ port), no path: the
  Pages site `https://<user>.github.io/vd_oprezer/` sends
  `Origin: https://<user>.github.io`.
- An `onRequest` hook: when the request's `Origin` is allowed, set
  `Access-Control-Allow-Origin` (that origin, or `*`) and `Vary: Origin`.
  Set them with `reply.raw.setHeader`, not `reply.header()`: the SSE route
  hijacks the reply and calls `writeHead` itself, so headers kept by
  Fastify's reply never reach that response. Node merges `setHeader`
  headers into `writeHead`.
- Preflight: browsers send `OPTIONS` first for `DELETE /jobs/:id`, and
  also for `POST /jobs`: an `XMLHttpRequest` with upload-progress listeners
  is always preflighted. Plain `GET`s and `EventSource` aren't. The
  multipart content type is CORS-safelisted, so no `Allow-Headers` is
  needed. Answer an allowed preflight with 204,
  `Access-Control-Allow-Methods: GET, POST, DELETE` and
  `Access-Control-Max-Age: 86400`. Fastify has no `OPTIONS` routes, so it
  would 404 without this.
- Error responses (400, 404, 409, 413, 503) need the header too, or the
  browser hides them and the page only sees a network error. The hook runs
  before any route, so they get it.
- No cookies or auth, so no `Allow-Credentials`. No exposed headers: the
  Job body already carries the id and the download name.
- Own hook (about 20 lines) over `@fastify/cors` (Claude's call, same
  reasoning as SSE and the limiter in 7 and 8). Switch if we need more of
  CORS than this.
- Tests in `server/index.test.ts`: allowed origin gets the header on JSON,
  on the SSE stream and on a 413 and a 503; another origin gets none;
  preflight for POST and DELETE answers 204; with no `corsOrigins`, nothing
  changes.
  `main.test.ts` or a unit test for parsing `CORS_ORIGINS`.
- Suggested demo server settings (docs only, Claude's guess):
  `MAX_UPLOAD_MB=100`, `MAX_QUEUED=5`, `JOB_TTL_MIN=15`, `CONCURRENCY=1`,
  `CORS_ORIGINS=https://<user>.github.io`, served over https (Pages is
  https, and browsers block calls from it to plain-http remote servers).

### 12b. The web app (`web/`)

**Screen** (layout B):

- Header: name, one-line pitch, **Expert** toggle.
- Left, always shown — the flow:
  1. Drop zone / browse ("up to 100 MB" when a limit is configured).
  2. Preset cards from the backend: label + one-line description.
  3. **Convert** button.
  4. Progress: an **Uploading** bar (bytes sent), then **Converting**
     (server percent), then a short **Preparing preview** while the result
     downloads. **Cancel** throughout.
  5. Done: "48.2 MB → 12.1 MB (75% smaller)", a `<video controls>` preview
     of the result, **Download**, **Convert another**.
  6. Failed: one plain sentence (below) + **Try again**.
- Right, expert mode only — the **activity log**: one line per request or
  event (time, label, status, duration, e.g. `POST /jobs 202 · 3.1 s`,
  `job running 42%`); click a line to see its full JSON. The backend URL
  field (with **Reset**) sits at the top of this panel. Also logged: the
  result's resolution and duration, read from the preview's
  `loadedmetadata`. Under ~800 px wide, the log stacks below the flow.
- Expert mode is off by default; the choice and a custom backend URL are
  remembered in `localStorage` (every access in try/catch, the page works
  without it).
- If loading presets fails on start, the flow shows "Can't reach the demo
  server" and expert mode shows why. Changing the URL reloads presets.
- Under the drop zone, one line: the video is deleted from the server once
  it's converted and downloaded (true: the adapter deletes the job, and
  `JOB_TTL_MIN` catches the rest).
- Accessibility: the drop zone wraps a real `<input type="file">` (keyboard
  and screen readers work), bars are `<progress>`, the status line is an
  `aria-live="polite"` region, presets are radio buttons styled as cards.

**Backend contract** (`web/src/backend.ts`), the only thing the UI knows
about a backend:

```ts
export interface Preset { id: string; label: string; description: string }

export type Phase = "uploading" | "queued" | "converting" | "downloading";

export interface LogEntry { label: string; status?: number | string; ms?: number; data?: unknown }

export interface ConvertEvents {
  /** fraction is 0–1 when the backend knows it. */
  progress(phase: Phase, fraction?: number): void;
  /** One line in the expert log; the app adds the time and renders it. */
  log(entry: LogEntry): void;
}

export interface Backend {
  presets(): Promise<Preset[]>;
  /** Resolves with the converted video; rejects with BackendError, or an AbortError on cancel. */
  convert(file: File, presetId: string, events: ConvertEvents, signal: AbortSignal): Promise<{ blob: Blob; filename: string }>;
}

/** For "rejected", message is written for visitors and shown as is. */
export type ErrorKind = "too_large" | "busy" | "unsupported" | "rejected" | "failed" | "expired" | "unreachable";
export class BackendError extends Error { constructor(readonly kind: ErrorKind, message: string) { super(message) } }

export type CreateBackend = (baseUrl: string) => Backend;
```

One `convert` call that ends with the file fits job-style APIs (like ours)
and plain request/response ones alike. The adapter turns its backend's
errors into an `ErrorKind`; the UI owns the wording:

| Kind | vd-oprezer cause | Visitor sees |
|---|---|---|
| `too_large` | 413 | This file is too big for the demo (limit: N MB). |
| `busy` | 503 `QUEUE_FULL` | The demo server is busy. Try again in a minute. |
| `unsupported` | 422 `PROBE_FAILED`, or job error `PROBE_FAILED` (jobs probe after the 202) | That file doesn't look like a video we can read. |
| `rejected` | 400, job error `INVALID_ARGUMENT` (no video stream, too short/long for a Reel) | The server's message, e.g. `Input is 2.1s long; "instagram-reel" accepts 3s to 900s.` |
| `failed` | job `failed`, other 5xx | The conversion failed. |
| `expired` | 404, SSE `deleted` | The result expired on the server. Please convert again. |
| `unreachable` | network error (also CORS or mixed content), 502/504 from a proxy | Can't reach the demo server. |

The server's own message always goes to the expert log.

**vd-oprezer adapter** (`web/src/adapters/vd-oprezer.ts`):

1. `presets()`: `GET /presets` → `{ id, label, description }` per entry;
   label made from the id (`instagram-reel` → "Instagram reel").
2. `convert()`:
   - `POST /jobs` as `FormData` (`preset`, then `file`) with
     **`XMLHttpRequest`**, because `fetch` can't report upload progress.
     `upload.onprogress` → `uploading`. Log the 202 and the Job.
   - `EventSource` on `/jobs/:id/events`: each `job` event → `queued` or
     `converting` (progress / 100), and a log line. `done` → next step.
     `failed` → `BackendError` from `job.error`. `deleted` → `expired`.
     An `error` with `readyState === CLOSED` (404) → `expired`. An `error`
     while `CONNECTING` is a dropped connection that EventSource retries by
     itself; if it hasn't reconnected (`open`) within 30 s, give up →
     `unreachable` (the job is deleted like a cancel). Not a plain "30 s
     without events" timer: a queued job gets no events while it waits
     (keep-alive comments don't fire any). **Always `close()` it** when it ends:
     EventSource reconnects otherwise (see 8).
   - `GET /jobs/:id/output` with `fetch`, reading the body stream to report
     `downloading` against `job.sizeBytes`. Return the blob and
     `job.filename` (already `<name>-<preset>.mp4`).
   - Then `DELETE /jobs/:id`, best effort, so the demo server frees the
     file now instead of after `JOB_TTL_MIN`.
   - On abort at any point once the job exists: `xhr.abort()` / close the
     stream / abort the fetch, `DELETE /jobs/:id` (best effort), reject with
     an `AbortError`.
3. The result is downloaded once: the preview (`URL.createObjectURL`) and
   the Download link (`<a download=filename>`) share that blob. A
   `download` link to another origin's URL is ignored by browsers, and
   this avoids fetching the video twice. Revoke the object URL on
   **Convert another**. Shortcut: the result sits in browser memory, fine
   at demo sizes; stream to disk if limits grow a lot.

**Configuration** (Vite build-time env, read in `main.ts` only):
- `VITE_BACKEND_URL`: default backend URL. Local default
  `http://localhost:3000`; the Pages build gets it from the repository
  variable `DEMO_BACKEND_URL`.
- `VITE_MAX_UPLOAD_MB` (optional): the demo server's `MAX_UPLOAD_MB`. The
  page checks `file.size` before uploading and shows the limit under the
  drop zone. It's also a safety net: a server that answers 413 before it
  has read the whole upload can show up in the browser as a network error.
- Swapping the backend: `main.ts` imports one adapter
  (`import { createBackend } from "./adapters/vd-oprezer.js"`). Write
  `adapters/<name>.ts` implementing `CreateBackend` and change that
  import. Shortcut: no adapter registry or env switch until a second
  adapter exists.

**Files** (Claude's call, the builder may adjust):

```
web/
  package.json      devDependencies only: vite, typescript, tsx, @types/node
  tsconfig.json     lib dom + es2024, strict, types ["node"] for tests
  vite.config.ts    base: "./" (works under /vd_oprezer/ on Pages and on a custom domain)
  index.html
  README.md         run it, point it at a server, write an adapter
  src/
    main.ts         composition root: env, localStorage, picks the adapter, wires state and view
    backend.ts      the contract above
    app.ts          state + transitions, no DOM (app.test.ts)
    view.ts         render(state) → DOM, event handlers → app
    style.css       plain CSS, light/dark via prefers-color-scheme
    adapters/
      vd-oprezer.ts (vd-oprezer.test.ts)
```

**States** (`app.ts`): `idle` (no file) → `ready` (file + preset) →
`uploading` → `queued` → `converting` → `downloading` → `done` |
`failed`. Cancel from any running state → `ready` (same file and preset).
**Try again** → `ready`; **Convert another** → `idle`. The log lives in the
state too, kept across conversions.

**Tests and checks** (`web/`, `npm run check` = `tsc --noEmit` + tests +
`vite build`):
- `node:test` via tsx, the same runner as the main repo.
- `adapters/vd-oprezer.test.ts`: the adapter against fakes of
  `XMLHttpRequest`, `EventSource` and `fetch` put on `globalThis` in the
  test, with no injection in production code. Covers: preset mapping;
  the full run (upload progress → queued → converting 50% → done →
  download progress → DELETE); a failed job → `failed`, an
  `INVALID_ARGUMENT` job → `rejected` with the server's message; 413, 503,
  422, 400, 404, 502, a network error and 30 s of reconnecting → their
  kinds; abort while uploading → upload aborted and no DELETE (no job
  exists yet; the server drops the partial upload); abort while converting
  → DELETE + AbortError; the EventSource closed on every end.
- `app.test.ts`: transitions, including cancel, try again, convert another.
- Shortcuts: no DOM tests (the view is checked by hand; add Playwright if
  it grows), no ESLint in `web/` yet.
- By hand, before calling it done: `CORS_ORIGINS=http://localhost:5173
  npm run dev:server`, `npm run dev` in `web/`; convert a lavfi clip, cancel
  one, try one over the limit, stop the server mid-run, check the expert
  log, a phone-width window and dark mode.

**Root repo changes:**
- `eslint.config.js`: ignore `web/**` (web has its own checks; the root
  config would otherwise lint `web/dist`).
- `.dockerignore`: add `web` (the image never uses it, and `web/node_modules`
  would bloat the build context).
- `.gitignore`: add `.superpowers/`. (`node_modules/` and `dist/` already
  match inside `web/`.)
- `.github/workflows/ci.yml`: `paths-ignore: ["web/**",
  ".github/workflows/web.yml"]`, so web-only changes skip the Docker build.

### 12c. Pages workflow (`.github/workflows/web.yml`)

- Runs on pull requests and pushes to `main` that touch `web/**` or this
  file, plus `workflow_dispatch`.
- Job `check`: checkout, setup-node 24 with npm cache
  (`web/package-lock.json`), `npm ci` and `npm run check` in `web/` with
  `VITE_BACKEND_URL: ${{ vars.DEMO_BACKEND_URL }}` and
  `VITE_MAX_UPLOAD_MB: ${{ vars.DEMO_MAX_UPLOAD_MB }}`. On `main` only,
  upload `web/dist` with `actions/upload-pages-artifact`.
- Job `deploy` (push to `main` only, needs `check`): `actions/deploy-pages`,
  environment `github-pages`, `permissions: pages: write, id-token: write`.
  Everything else `contents: read`.
- Concurrency: PR runs cancel older runs of the same ref; deploys don't
  cancel each other (group `pages`, `cancel-in-progress: false`), as GitHub
  recommends.
- One-time setup, by hand (goes in `web/README.md`): Settings → Pages →
  Source: **GitHub Actions**; repository variables `DEMO_BACKEND_URL` and
  `DEMO_MAX_UPLOAD_MB`; on the demo server, `CORS_ORIGINS` with the Pages
  origin.

### What building it showed

- Implemented as designed: `src/server` (CORS hook + `CORS_ORIGINS`),
  `web/` (Vite 8, TypeScript 6, 25 tests), `.github/workflows/web.yml`,
  `paths-ignore` in `ci.yml`. Plan: `docs/superpowers/plans/2026-10-25-web-demo.md`.
- Bug found by hand: an unreadable upload showed "The conversion failed."
  Jobs probe after the 202, so `PROBE_FAILED` arrives as the job's error
  code, not as a 422. The adapter now maps job error codes too
  (`PROBE_FAILED` → `unsupported`, `INVALID_ARGUMENT` → `rejected`).
- **The 413 question:** in Chromium, an upload over the server's limit gets
  the real 413 and the "too big" message, not a network error. So
  `VITE_MAX_UPLOAD_MB` stays optional (it still saves the upload).
  Firefox and Safari not checked yet.
- Checked by hand against real FFmpeg (Chromium): convert + preview +
  download, cancel (job deleted), 413, a 2 s clip on `instagram-reel`
  (server's message shown), a non-video file, server stopped mid-encode
  ("Can't reach" 30 s after the drop), switching and resetting the backend
  URL, expert mode remembered, 390 px wide, dark mode, keyboard only.
- Smaller calls made while building: one progress bar whose label changes
  with the phase; the presets error adds "Reload the page to try again.";
  the adapter doesn't DELETE failed jobs (no output to free; the TTL
  cleans the record); presets are logged by `main.ts` (the contract's
  `presets()` has no log channel); `workflow_dispatch` also deploys, to
  redeploy after changing the repository variables.
- A fresh review then found three more, fixed with tests: a backend URL
  changed while presets were still loading never loaded them; a refused
  event stream (a proxy's 502 while the server is down) read as "expired",
  so the adapter now asks `GET /jobs/:id` for the real status; a network
  drop mid-download showed "conversion failed" and left the job behind.
  Smaller polish it listed (stale-run guards, freeing the blob when the
  preset changes on a result, plainer text for non-JSON 400/503, a hint when
  a custom URL is set and expert mode is off, a malformed event, validating
  `VITE_BACKEND_URL` at build time) is not done yet.
- Not done yet: the demo server itself, Firefox/Safari checks, DOM tests
  (Playwright) and ESLint in `web/`, an adapter registry (wait for a second
  adapter).

---

## 13. Auth key & config visibility ✅

**Optional key from the runtime env (`AUTH_KEY`), not baked in at build
time.** A Docker `ARG`/`ENV` or an esbuild `define` would leave the key in
the image (`docker history`, `docker inspect`, or plain text in the bundle),
and CD publishes every `v*` tag to GHCR. A BuildKit secret mount still
writes the key into the published image. Read at runtime it never touches
the image and changes without a rebuild (`docker run -e AUTH_KEY=...`).

```
GET /config   the server's settings after defaults; authKey "***" or null
```

- `ServerConfig.authKey?: string`. Unset or empty = no auth, as before.
  Set = every request needs `Authorization: Bearer <key>`, otherwise 401
  `UNAUTHORIZED` with `WWW-Authenticate: Bearer`, before the upload is read.
- Compared with `timingSafeEqual` on SHA-256 hashes, so neither the key nor
  its length leaks through timing.
- Open without the key: `GET /health` (the Docker `HEALTHCHECK` has none;
  it only returns FFmpeg versions) and `OPTIONS` (browsers send preflights
  without credentials). The auth hook runs after the CORS hook, so a 401
  still has CORS headers; preflights now allow the `authorization` header.
- Startup log: one `config` line (Fastify logger, before "Server listening")
  with the same settings plus `workDir`, `ffmpegPath` and `ffprobePath`.
  `GET /config` leaves those paths out: server paths never reach clients.
  With a key set, `/config` needs it too.
- Tests: `server/index.test.ts` (no key by default, 401 for missing/wrong
  key without encoding, right key, `/config` redaction, `/health` open,
  preflight + CORS on 401) and `main.test.ts` (`AUTH_KEY` from env, config
  log line redacted).

### 13a. Local env file and the web demo's key

Chosen: the key from the dev env plus an expert-mode field; `fetch`-based
SSE; `CORS_ORIGINS=*` for local dev.

- **`.env.local`** (repo root, gitignored by `.env.*`; copy it from the committed `.env.example`): `AUTH_KEY` (random)
  and `CORS_ORIGINS=*`. `npm run dev:server` loads it with Node's own
  `--env-file-if-exists` (works through tsx), so no dotenv dependency.
  `*` rather than a localhost pattern: zero server code, any Vite port
  works, and the key still guards the API.
- **Where the page gets the key:** `vite.config.ts` reads `AUTH_KEY` from
  that same file only under `vite dev` and defines `__DEV_API_KEY__`;
  builds get `""`, so no key reaches the Pages bundle. Not a `VITE_*`
  variable on purpose: Vite would compile any of those into a build.
  Expert mode has an "API key" field next to the URL: **Connect** applies
  both, **Reset** goes back to the defaults. It's kept in `localStorage`
  (plain text; fine for a demo) only when it differs from the default.
- **Adapter:** `createBackend(baseUrl, apiKey?)` sends
  `Authorization: Bearer` on every request (fetch, the XHR upload, the
  keepalive DELETE). `EventSource` can't send headers, so the job stream is
  read with `fetch` + a small parser (`event:`/`data:` lines only, which is
  all the server sends). Reconnects are ours now: retry every 1 s until
  30 s after the drop, as before. A refused stream is final and its status
  is known directly (404 expired, 401 unauthorized, a proxy's 502
  unreachable), so the extra `GET /jobs/:id` to ask why is gone. The
  preview already used a blob URL, so `<video>` needed no change.
- **401** is a new error kind, `unauthorized`: "The server needs an API key.
  Enter it in expert mode." Also shown instead of "Can't reach the demo
  server" when loading presets is refused.
- `npm run dev:web` now forwards arguments to Vite (`-- --port 5180`).
- Tests: adapter (key on every request and none without it, 401 on upload
  and stream, refused streams, reconnect then give up, abort while
  waiting to reconnect, keep-alive comments), app state (key in
  `urlChanged`, presets reload on a key change, the message). Checked by
  hand in Chromium against the real server with `.env.local`: convert end
  to end, wrong key → the message above, Reset → presets load again; the
  production build doesn't contain the key.

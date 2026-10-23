# Decisions

Each step: compare options → Esteban chooses → implement with tests →
`npm run check` → update this file.

| # | Decision | Status | Choice |
|---|----------|--------|--------|
| 1 | Project shape & language | ✅ done | Single package, TypeScript, Node 24, ESM, npm; boundary guardrails |
| 2 | How core runs FFmpeg | ✅ done | `node:child_process` spawn, no runtime deps |
| 3 | Testing | ✅ done | `node:test` via tsx, no new deps |
| 4 | CLI framework | ✅ done | commander 15 + `@commander-js/extra-typings` |
| 5 | **Presets & validation** | ⏭ next | — |
| 6 | HTTP server & uploads | open | — |
| 7 | Job queue | open | — |
| 8 | Progress reporting to HTTP clients | open | — |
| 9 | Docker image | open | — |
| 10 | CI | open | — |

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
  there. It hasn't run yet; it will run in Docker/CI (decisions 9 and 10).
- Later, if wanted: `@inquirer/prompts` for interactive prompts.

## 5–10

Initial thoughts from the first discussion, to be confirmed:
- 5 Presets: plain data objects validated with zod; one schema shared by CLI
  flags and the HTTP body. Check current YouTube/Instagram specs before defining presets.
- 6 Server: express 5 + multer/busboy; `createApp(config)` in `server/index.ts`.
- 7 Queue: `p-queue` in-process to start; BullMQ + Redis only if we need
  multiple workers or persistence.
- 8 Progress to clients: Server-Sent Events.
- 9 Docker: `node:24-slim` + FFmpeg (maybe a static build for newer encoders);
  one image, `convert`/`serve` entrypoints.

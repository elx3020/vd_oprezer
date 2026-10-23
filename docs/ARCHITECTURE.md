# Architecture

vd_oprezer ("video optimizer resizer") is **one npm package with three modules**.
Each module is written as if it were already its own package, so splitting
into separate releases later is mostly moving folders.

```
src/
  core/     library: presets, FFmpeg args, run, probe       → future @vd-oprezer/core
  cli/      terminal interface (bin: vd-oprezer)            → future @vd-oprezer/cli
  server/   HTTP service                                    → future @vd-oprezer/server
```

Dependency direction is one-way:

```
cli ──┐
      ├──► core
server┘
```

core depends on nothing of ours. cli and server never import each other.

## Guardrails

| # | Rule | Enforced by |
|---|------|-------------|
| 1 | Each module's **public API is its `index.ts`**. Everything else is private. | Convention + rule 2 |
| 2 | cli/server import core **only via `"#core"`**, never `../core/...`. `#core` maps to `src/core/index.ts` only, so deep imports like `#core/internal` can't resolve. | `package.json` `imports` + ESLint |
| 3 | **No relative path crosses a module boundary** (`../server`, `../../cli`...). | ESLint `no-restricted-imports` |
| 4 | **Each module has its own dependency allowlist** in `modules.config.js`. Importing an npm package not on the list is a lint error. | ESLint (generated from `modules.config.js`) |
| 5 | **`package.json` dependencies and `modules.config.js` must agree.** No unclaimed deps, no phantom deps. | `npm run check:deps` |
| 6 | **core never touches the process**: no `process.env/argv/exit/stdout...`, no `console`. Config comes in as arguments; results go out as return values, errors and events. | ESLint |
| 7 | **`main.ts` is the composition root** of cli and server: the only place that reads env/argv and starts things. `index.ts` exports pure functions (`run(args)`, `createApp(config)`) with no side effects on import. | Convention |
| 8 | Builtins use the **`node:` prefix** (`node:fs`, not `fs`). | ESLint (rule 4 allowlist) |
| 9 | **Tests sit next to the code** (`src/core/foo.test.ts`), so they move with their module. | Convention |
| 10 | `dist/` mirrors `src/` (`dist/core`, `dist/cli`, `dist/server`). | `tsconfig.json` |

`npm run check` runs typecheck + lint + deps check + tests. Run it before every
commit (and in CI later).

### Adding a dependency

1. `npm install <pkg>`
2. Add `<pkg>` to the `deps` of the module(s) that use it in `modules.config.js`
3. `npm run check`

Skip step 2 and lint fails in that module and `check:deps` reports it.

### How `#core` works

`package.json`:

```json
"imports": {
  "#core": { "source": "./src/core/index.ts", "default": "./dist/core/index.js" }
}
```

- **Dev** (`tsx --conditions=source`) and **typecheck** (`customConditions: ["source"]`)
  resolve to the TypeScript source, so there's no build step while developing.
- **Runtime** (`node dist/...`) resolves to the compiled JS.

## The engine (core)

`createEngine({ ffmpegPath?, ffprobePath?, runner? })` returns
`{ versions, probe, transcode }`. FFmpeg runs through Node's built-in
`child_process.spawn`. core's only runtime dependency is zod (decision 5).

| Behaviour | Why |
|---|---|
| Progress comes from `-progress pipe:1` (key=value lines); percent = `out_time / duration` (duration from ffprobe). | Machine-readable output, no parsing of human-oriented log text. |
| Cancel with an `AbortSignal`; time out with `AbortSignal.timeout(ms)`. A cancelled job rejects with `signal.reason`. | One mechanism for Ctrl+C, HTTP client disconnects and timeouts. |
| On abort FFmpeg is killed at once (SIGKILL), and the promise settles only after it has exited. | The output is discarded anyway; the file is closed before we delete it (Windows). |
| FFmpeg writes to `.<name>.<id>.partial.<ext>` next to the output, which is renamed into place on success and deleted on failure. | No half-written files under the real name, and an existing output stays intact until the new one is complete. |
| Inputs must be local files. | FFmpeg also accepts URLs and other protocols; the server must never let a client make it fetch arbitrary URLs. |
| Expected failures throw `VdError` with a stable `code` (`INPUT_NOT_FOUND`, `OUTPUT_EXISTS`, `FFMPEG_FAILED`...) plus the stderr tail. | The CLI maps codes to exit codes, the server to HTTP statuses. |
| The process runner is injectable (`runner`). | Unit tests can use a fake without FFmpeg installed. |

## Presets (core)

`PRESETS` are typed data. `parseEncodeOptions(unknown)` validates user
choices with zod (`encodeOptionsSchema`) and throws `INVALID_ARGUMENT`
listing every problem. `buildArgs(options, mediaInfo)` returns the FFmpeg
arguments, adapted to the probed input: it scales the displayed size,
caps the frame rate and rejects durations a preset doesn't accept. Pass
it to the engine as `args: (info) => buildArgs(options, info)`. Raw FFmpeg
arguments are never part of the schema, so HTTP clients can't inject them.

## The CLI

`run(argv, ctx)` in `cli/index.ts` builds a commander program per call, with
`exitOverride` and output routed to `ctx.stdout`/`ctx.stderr`, so it never
exits the process and tests can capture what it prints. `main.ts` supplies
argv, env (`FFMPEG_PATH`, `FFPROBE_PATH`), the package version and the
Ctrl+C AbortSignal. Arguments after `--` are split off before parsing and go
to FFmpeg untouched. Exit codes: 0 ok, 1 failure, 2 usage, 130 cancelled.

## Tests

`node:test` + `node:assert/strict`, run by `tsx --conditions=source --test`.
Files sit next to the code as `*.test.ts` and are left out of the build
(`tsconfig.build.json`). `*.integration.test.ts` runs real FFmpeg on clips
generated with lavfi in a temp dir, and skips itself when FFmpeg isn't on PATH.

cli/server `main.ts` wire process signals to the AbortSignal and abort on
`exit` too, so FFmpeg never keeps running as an orphan.

## Splitting into separate packages (when needed)

1. Move `src/<name>/` → `packages/<name>/src/` for each module.
2. Create `packages/<name>/package.json`:
   - `name`: `@vd-oprezer/<name>`
   - `dependencies`: the `deps` list from `modules.config.js`, plus
     `"@vd-oprezer/core"` for cli and server
   - core: move today's `#core` block from `imports` to `exports["."]`
   - cli: move `bin` here
3. Find/replace `"#core"` → `"@vd-oprezer/core"` (it appears only in cli/server).
4. Add an npm/pnpm workspace root, a `tsconfig.base.json`, and one small
   `tsconfig.json` per package that extends it.
5. Point the boundary rules in `eslint.config.js` at `packages/*/src` (or drop
   rule 4, since per-package `dependencies` now do that job).
6. Update the Dockerfile to copy `packages/`.

None of the module code changes: imports inside a module are relative,
and imports across modules all go through one alias.

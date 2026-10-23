# vd_oprezer

Video optimizer & resizer: a CLI and an HTTP service around FFmpeg, with
presets (web, YouTube, Instagram...), shipped as one Docker image.
TypeScript, Node 24, ESM, single npm package. Developed on Windows
(PowerShell); the Docker image is Linux.

Read before changing anything:
- `docs/ARCHITECTURE.md`: module boundaries, guardrails, engine behaviour
- `docs/DECISIONS.md`: what is decided, what is next, and the plan for each step

## How we work

- **One decision at a time.** For the next open item in `docs/DECISIONS.md`:
  present 2–4 options with trade-offs and a recommendation, then **wait for
  Esteban to choose** before implementing. Don't bundle several decisions.
- **Tests are part of every change.** No feature or bug fix without tests
  in the same change. Bug fix = a failing test first, then the fix.
- **Done means `npm run check` passes** (typecheck + lint + boundaries + deps + tests).
- After implementing, update `docs/DECISIONS.md` (status + short rationale)
  and `docs/ARCHITECTURE.md` if behaviour changed.
- Don't commit unless asked.

## Commands

```
npm run dev:cli -- <args>   # CLI from source (tsx, "source" condition)
npm run dev:server          # server from source, watch mode (never exits)
npm test                    # node:test via tsx; FFmpeg tests skip if not on PATH
npm run test:watch
npm run check               # must pass before a change is done
npm run build               # tsc → dist/
```

## Rules the tooling enforces (don't work around them)

- Modules: `src/core` (library), `src/cli`, `src/server`. Each module's public
  API is its `index.ts`; `main.ts` is the composition root (the only place that
  reads env/argv/signals).
- cli/server import core only as `"#core"`. No relative imports across modules.
  cli and server never import each other.
- Every npm package a module imports must be listed for that module in
  `modules.config.js` (and be in package.json). Add it there first.
- core never touches `process.*` or `console`. Config comes in as arguments;
  results go out as return values, `VdError`s and callbacks.
- Builtins use the `node:` prefix. Relative imports use `.js` extensions.
- Tests sit next to the code (`src/core/progress.test.ts`) so they move with
  their module.

## Gotchas already learned

- TypeScript 6: `types` defaults to `[]`, so `"types": ["node"]` in tsconfig is required.
- tsx/npm relay Ctrl+C, so one key press can arrive twice; `cli/main.ts` ignores
  repeats within 1 s. FFmpeg ignores SIGPIPE, so if Node dies without killing
  it, FFmpeg keeps running: always abort the signal on exit.
- FFmpeg 6+ ignores `-metadata:s:v rotate=90`. To make a rotated test clip use
  `ffmpeg -display_rotation 90 -i in.mp4 -c copy out.mp4`.
- Generate test media with lavfi instead of committing binaries, e.g.
  `ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=30 -f lavfi -i sine=frequency=440 -t 5 -c:v libx264 -preset ultrafast -c:a aac -shortest src.mp4`

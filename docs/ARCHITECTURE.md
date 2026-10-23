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

`npm run check` runs typecheck + lint + deps check. Run it before every commit
(and in CI later).

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

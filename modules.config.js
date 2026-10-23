// Single source of truth for module boundaries.
//
// Every folder in src/ is a future package. This file says, per module,
// which npm packages it may import. ESLint enforces it on every import,
// and scripts/check-deps.js makes sure package.json and this file agree.
//
// When the repo is split into separate packages, each module's `deps`
// list becomes that package's "dependencies" (see docs/ARCHITECTURE.md).
//
// Always allowed in every module: `node:*` builtins and relative imports
// that stay inside the module. cli and server may also import `#core`.

/** @type {Record<string, { deps: string[], importsCore: boolean }>} */
export const MODULES = {
  // Pure library: presets, FFmpeg argument building, running, probing.
  core: { deps: [], importsCore: false },

  // Command-line interface. Talks to users via the terminal.
  // commander is extra-typings' peer: we import only the typed wrapper.
  cli: { deps: ["@commander-js/extra-typings", "commander"], importsCore: true },

  // HTTP service. Talks to users via HTTP.
  server: { deps: [], importsCore: true },
};

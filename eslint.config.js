import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { MODULES } from "./modules.config.js";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const names = Object.keys(MODULES);

/**
 * Import rules for one module (src/<name>/**):
 *  1. Allowlist: only node:* builtins, relative paths, #core (if allowed)
 *     and the npm packages listed in modules.config.js.
 *  2. No relative path may climb into another module (../core, ../../server...).
 */
function boundary(name) {
  const { deps, importsCore } = MODULES[name];
  const allowed = [
    "node:",
    "\\.{1,2}/",
    ...(importsCore ? ["#core$"] : []),
    ...deps.map((d) => `${escapeRe(d)}(/|$)`),
  ];
  const others = names.filter((n) => n !== name).join("|");

  return {
    files: [`src/${name}/**/*.ts`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `^(?!${allowed.join("|")}).*`,
              message:
                `"${name}" may not import this. Allowed: node:* builtins, relative files inside src/${name}` +
                (importsCore ? ", #core" : "") +
                `, and the deps listed for "${name}" in modules.config.js. ` +
                `Adding a dependency? Add it there first.`,
            },
            {
              regex: `^(\\.\\./)+(${others})(/|$)`,
              message: importsCore
                ? `Don't reach into another module with a relative path. Use "#core" (its public API) instead; cli and server must never import each other.`
                : `core must not depend on cli or server.`,
            },
          ],
        },
      ],
    },
  };
}

export default tseslint.config(
  // web/ is its own package with its own checks.
  { ignores: ["dist/**", "dist-bundle/**", "node_modules/**", "web/**"] },
  js.configs.recommended,

  // Type-aware linting for the TypeScript sources (catches un-awaited promises,
  // which matter a lot once we spawn FFmpeg processes).
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      // node:test's describe/it return promises the runner itself awaits.
      "@typescript-eslint/no-floating-promises": [
        "error",
        { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["describe", "it", "test", "suite"] }] },
      ],
    },
  },

  // Module boundaries.
  ...names.map(boundary),

  // core is a library: it gets config as arguments and reports via return
  // values, thrown errors and events. It never touches the process directly,
  // so it can be published and embedded anywhere.
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-console": "error",
      "no-restricted-properties": [
        "error",
        ...["env", "argv", "exit", "exitCode", "stdout", "stderr", "stdin", "cwd"].map((property) => ({
          object: "process",
          property,
          message: "core must not touch the process. Take it as a parameter, or let cli/server handle it.",
        })),
      ],
    },
  },

  // Plain JS config/scripts at the repo root run in Node.
  {
    files: ["*.js", "scripts/**/*.js"],
    languageOptions: { globals: globals.node },
  },
);

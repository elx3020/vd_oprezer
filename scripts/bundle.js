// Bundles the CLI and the server into one file each (dist-bundle/), so the
// Docker image needs no node_modules. Paths mirror src/, so main.ts still
// finds ../../package.json.
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli/main.ts", "src/server/main.ts"],
  outbase: "src",
  outdir: "dist-bundle",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Resolve "#core" to the TypeScript source, like tsx does.
  conditions: ["source"],
  // Fastify and friends are CommonJS and call require() for Node builtins,
  // which an ESM bundle doesn't have on its own.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
});

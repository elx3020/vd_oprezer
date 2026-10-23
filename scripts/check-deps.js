// Keeps package.json "dependencies" and modules.config.js in sync, so the
// per-module dependency lists stay trustworthy for a future split.
//
//  - every runtime dependency must be claimed by at least one module
//  - every dependency a module claims must be in package.json
import { readFileSync } from "node:fs";
import { MODULES } from "../modules.config.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const installed = new Set(Object.keys(pkg.dependencies ?? {}));
const errors = [];

const claimed = new Set();
for (const [name, { deps }] of Object.entries(MODULES)) {
  for (const dep of deps) {
    claimed.add(dep);
    if (!installed.has(dep)) {
      errors.push(`"${name}" lists "${dep}" in modules.config.js, but it is not in package.json dependencies.`);
    }
  }
}
for (const dep of installed) {
  if (!claimed.has(dep)) {
    errors.push(`"${dep}" is in package.json dependencies but no module claims it in modules.config.js.`);
  }
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join("\n"));
  process.exit(1);
}
console.log(`✓ dependencies match modules.config.js (${installed.size} runtime deps)`);

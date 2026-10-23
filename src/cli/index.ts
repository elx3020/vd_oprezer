// Public API of the cli module: build and run the CLI without side effects
// at import time, so it can be tested and later published as its own package.
import { coreInfo } from "#core";

/** Runs the CLI with the given arguments and returns the exit code. */
export function run(args: string[]): number {
  const info = coreInfo();
  console.log(`vd-oprezer cli → ${info.name} (args: ${JSON.stringify(args)})`);
  return 0;
}

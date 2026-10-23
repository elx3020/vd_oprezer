#!/usr/bin/env node
// Composition root for the CLI: the only file that reads the real process.
import { run } from "./index.js";

process.exitCode = run(process.argv.slice(2));

// Public API of core. cli and server import ONLY what is exported here,
// through the "#core" alias. Anything not exported is private to core.

export {
  createEngine,
  type CallOptions,
  type Engine,
  type EngineConfig,
  type EngineVersions,
  type TranscodeOptions,
  type TranscodeResult,
} from "./engine.js";
export { VdError, isVdError, type VdErrorCode, type VdErrorDetails } from "./errors.js";
export {
  PRESETS,
  buildArgs,
  encodeOptionsSchema,
  outputDimensions,
  parseEncodeOptions,
  type EncodeOptions,
  type Preset,
  type PresetName,
} from "./presets.js";
export { parseProbeOutput, type AudioStreamInfo, type MediaInfo, type VideoStreamInfo } from "./probe.js";
export { createProgressParser, type Progress } from "./progress.js";
export { spawnRunner, type RunOptions, type RunResult, type Runner } from "./runner.js";

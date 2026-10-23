// Public API of core. cli and server import ONLY what is exported here,
// through the "#core" alias. Anything not exported is private to core.
//
// Placeholder until decision 2 (how we run FFmpeg) adds the real API.

export interface CoreInfo {
  name: string;
  ready: boolean;
}

export function coreInfo(): CoreInfo {
  return { name: "vd_oprezer core", ready: false };
}

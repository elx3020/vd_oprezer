// Public API of the server module. Will export createApp(config) once the
// HTTP framework is chosen (decision 5); main.ts then only reads env and listens.
import { coreInfo } from "#core";

export interface ServerConfig {
  port: number;
}

export function describeServer(config: ServerConfig): string {
  return `vd-oprezer server → ${coreInfo().name} (port ${config.port})`;
}

// Public API of the server module. Will export createApp(config) once the
// HTTP framework is chosen (decision 5); main.ts then only reads env and listens.
import { createEngine, type EngineConfig } from "#core";

export interface ServerConfig extends EngineConfig {
  port: number;
}

export async function describeServer(config: ServerConfig): Promise<string> {
  const { ffmpeg } = await createEngine(config).versions();
  return `vd-oprezer server (port ${config.port}) using ${ffmpeg}`;
}

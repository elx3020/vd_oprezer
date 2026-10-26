// The backend contract: the only thing the UI knows about a backend. An
// adapter (src/adapters/) maps it onto one service's HTTP API.

export interface Preset {
  id: string;
  label: string;
  description: string;
}

export type Phase = "uploading" | "queued" | "converting" | "downloading";

export interface LogEntry {
  label: string;
  status?: number | string;
  ms?: number;
  data?: unknown;
}

export interface ConvertEvents {
  /** fraction is 0–1 when the backend knows it. */
  progress(phase: Phase, fraction?: number): void;
  /** One line in the expert log; the app adds the time and renders it. */
  log(entry: LogEntry): void;
}

export interface Backend {
  presets(): Promise<Preset[]>;
  /** Resolves with the converted video; rejects with BackendError, or an AbortError on cancel. */
  convert(file: File, presetId: string, events: ConvertEvents, signal: AbortSignal): Promise<{ blob: Blob; filename: string }>;
}

/** For "rejected", message is written for visitors and shown as is. */
export type ErrorKind = "too_large" | "busy" | "unsupported" | "rejected" | "failed" | "expired" | "unreachable";

export class BackendError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export type CreateBackend = (baseUrl: string) => Backend;

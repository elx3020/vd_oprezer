// The page's state and how actions change it. Pure: no DOM, no storage, no
// network. main.ts dispatches actions and view.ts renders the result.
import type { ErrorKind, LogEntry, Phase, Preset } from "./backend.js";

export type Status =
  | { name: "idle" | "ready" }
  | { name: Phase; fraction?: number }
  | { name: "done"; url: string; filename: string; outputBytes: number }
  | { name: "failed"; kind: ErrorKind; message: string };

export interface LogLine extends LogEntry {
  /** Epoch ms. */
  at: number;
}

export interface State {
  backendUrl: string;
  /** "" = none. */
  apiKey: string;
  expert: boolean;
  presets: Preset[] | "loading" | { error: string; kind?: ErrorKind };
  file?: File;
  presetId?: string;
  status: Status;
  log: LogLine[];
}

export type Action =
  | { type: "presetsLoaded"; presets: Preset[] }
  | { type: "presetsFailed"; error: string; kind?: ErrorKind }
  | { type: "fileChosen"; file: File }
  | { type: "presetChosen"; id: string }
  | { type: "started" }
  | { type: "progress"; phase: Phase; fraction?: number }
  | { type: "finished"; url: string; filename: string; outputBytes: number }
  | { type: "failed"; kind: ErrorKind; message: string }
  | { type: "cancelled" }
  | { type: "tryAgain" }
  | { type: "another" }
  | { type: "log"; entry: LogEntry; at: number }
  | { type: "expertToggled" }
  /** key undefined = keep the current one. */
  | { type: "urlChanged"; url: string; key?: string };

const PHASES: readonly string[] = ["uploading", "queued", "converting", "downloading"] satisfies Phase[];

export function initialState(backendUrl: string, expert: boolean, apiKey = ""): State {
  return { backendUrl, apiKey, expert, presets: "loading", status: { name: "idle" }, log: [] };
}

export function isRunning(status: Status): boolean {
  return PHASES.includes(status.name);
}

/** idle or ready, depending on whether there is something to convert. */
const waiting = (state: State): Status => ({ name: state.file && state.presetId ? "ready" : "idle" });

export function reduce(state: State, action: Action): State {
  const running = isRunning(state.status);
  switch (action.type) {
    case "presetsLoaded": {
      const keep = action.presets.some((p) => p.id === state.presetId);
      const next = { ...state, presets: action.presets, presetId: keep ? state.presetId : action.presets[0]?.id };
      return isWaiting(state) ? { ...next, status: waiting(next) } : next;
    }
    case "presetsFailed":
      return { ...state, presets: action.kind ? { error: action.error, kind: action.kind } : { error: action.error } };
    case "fileChosen": {
      if (running) return state;
      const next = { ...state, file: action.file };
      return { ...next, status: waiting(next) };
    }
    case "presetChosen": {
      if (running) return state;
      const next = { ...state, presetId: action.id };
      return { ...next, status: waiting(next) };
    }
    case "started":
      return state.status.name === "ready" ? { ...state, status: { name: "uploading", fraction: 0 } } : state;
    case "progress":
      if (!running) return state;
      return { ...state, status: action.fraction === undefined ? { name: action.phase } : { name: action.phase, fraction: action.fraction } };
    case "finished":
      return { ...state, status: { name: "done", url: action.url, filename: action.filename, outputBytes: action.outputBytes } };
    case "failed":
      return { ...state, status: { name: "failed", kind: action.kind, message: action.message } };
    case "cancelled":
    case "tryAgain":
      return { ...state, status: waiting(state) };
    case "another": {
      const next = { ...state, file: undefined };
      return { ...next, status: waiting(next) };
    }
    case "log":
      return { ...state, log: [...state.log, { ...action.entry, at: action.at }] };
    case "expertToggled":
      return { ...state, expert: !state.expert };
    case "urlChanged":
      if (running || !isHttpUrl(action.url)) return state;
      return { ...state, backendUrl: action.url, apiKey: action.key ?? state.apiKey, presets: "loading" };
  }
}

/** After an action: does main need to fetch presets? Also when the URL or key changed while an earlier load was still running. */
export function shouldLoadPresets(before: State, after: State): boolean {
  return after.presets === "loading" && (before.presets !== "loading" || after.backendUrl !== before.backendUrl || after.apiKey !== before.apiKey);
}

const isWaiting = (state: State) => state.status.name === "idle" || state.status.name === "ready";

function isHttpUrl(value: string): boolean {
  return URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol);
}

export const formatMb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/** "48.2 MB → 12.1 MB (75% smaller)" */
export function summary(inputBytes: number, outputBytes: number): string {
  const saved = Math.round((1 - outputBytes / inputBytes) * 100);
  const change = saved > 0 ? `${saved}% smaller` : saved < 0 ? `${-saved}% larger` : "about the same size";
  return `${formatMb(inputBytes)} → ${formatMb(outputBytes)} (${change})`;
}

/** What a visitor reads for each error kind. */
export function messageFor(kind: ErrorKind, message: string, maxUploadMb?: number): string {
  switch (kind) {
    case "too_large":
      return maxUploadMb ? `This file is too big for the demo (limit: ${maxUploadMb} MB).` : "This file is too big for the demo.";
    case "busy":
      return "The demo server is busy. Try again in a minute.";
    case "unsupported":
      return "That file doesn't look like a video we can read.";
    case "rejected":
      return message;
    case "failed":
      return "The conversion failed.";
    case "expired":
      return "The result expired on the server. Please convert again.";
    case "unreachable":
      return "Can't reach the demo server.";
    case "unauthorized":
      return "The server needs an API key. Enter it in expert mode.";
  }
}

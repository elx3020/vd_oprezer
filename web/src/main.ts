// Composition root: the only file that reads build settings and localStorage,
// picks the backend adapter and creates object URLs.
import "./style.css";
// The swap point: another backend = another adapter implementing CreateBackend.
// shortcut: no adapter registry until there is a second adapter.
import { createBackend } from "./adapters/vd-oprezer.js";
import { initialState, reduce, shouldLoadPresets, type Action, type State } from "./app.js";
import { BackendError, type ConvertEvents, type LogEntry } from "./backend.js";
import { mountView } from "./view.js";

const defaultUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";
const maxUploadMb = Number(import.meta.env.VITE_MAX_UPLOAD_MB) || undefined;

// Storage can be missing or throw (private windows, blocked site data): the page works without it.
const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Not remembered; nothing else depends on it.
    }
  },
};

let state: State = initialState(storage.get("vd-demo:url") ?? defaultUrl, storage.get("vd-demo:expert") === "1");
let backend = createBackend(state.backendUrl);
let controller: AbortController | undefined;
let objectUrl: string | undefined;

const log = (entry: LogEntry) => dispatch({ type: "log", entry, at: Date.now() });

function revoke() {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined;
}

async function loadPresets() {
  const current = backend;
  try {
    const presets = await current.presets();
    if (current !== backend) return; // the URL changed meanwhile
    log({ label: "presets loaded", data: presets });
    dispatch({ type: "presetsLoaded", presets });
  } catch (error) {
    if (current !== backend) return;
    const message = (error as Error).message;
    log({ label: "presets failed", status: error instanceof BackendError ? error.kind : undefined, data: message });
    dispatch({ type: "presetsFailed", error: message });
  }
}

async function convert() {
  const { file, presetId } = state;
  if (!file || !presetId || state.status.name !== "ready") return;
  revoke();
  if (maxUploadMb && file.size > maxUploadMb * 1024 ** 2) {
    log({ label: "not uploaded: over the limit", data: { bytes: file.size, limitMb: maxUploadMb } });
    return dispatch({ type: "failed", kind: "too_large", message: "" });
  }
  controller = new AbortController();
  const { signal } = controller;
  dispatch({ type: "started" });
  try {
    const events: ConvertEvents = { progress: (phase, fraction) => dispatch({ type: "progress", phase, fraction }), log };
    const { blob, filename } = await backend.convert(file, presetId, events, signal);
    objectUrl = URL.createObjectURL(blob);
    dispatch({ type: "finished", url: objectUrl, filename, outputBytes: blob.size });
  } catch (error) {
    if (signal.aborted) return dispatch({ type: "cancelled" });
    if (!(error instanceof BackendError)) log({ label: "unexpected error", data: String(error) });
    dispatch({ type: "failed", kind: error instanceof BackendError ? error.kind : "failed", message: (error as Error).message });
  }
}

function dispatch(action: Action) {
  const before = state;
  state = reduce(state, action);
  if (state.backendUrl !== before.backendUrl) {
    storage.set("vd-demo:url", state.backendUrl === defaultUrl ? null : state.backendUrl);
    backend = createBackend(state.backendUrl);
  }
  if (state.expert !== before.expert) storage.set("vd-demo:expert", state.expert ? "1" : null);
  if (shouldLoadPresets(before, state)) void loadPresets();
  render(state);
}

const render = mountView(
  document,
  {
    file: (file) => {
      if (state.status.name === "done") revoke();
      dispatch({ type: "fileChosen", file });
    },
    preset: (id) => dispatch({ type: "presetChosen", id }),
    convert: () => void convert(),
    cancel: () => controller?.abort(),
    tryAgain: () => dispatch({ type: "tryAgain" }),
    another: () => {
      revoke();
      dispatch({ type: "another" });
    },
    expert: () => dispatch({ type: "expertToggled" }),
    url: (value) => dispatch({ type: "urlChanged", url: value }),
    resetUrl: () => dispatch({ type: "urlChanged", url: defaultUrl }),
    videoInfo: (width, height, durationS) => log({ label: `result ${width}×${height}, ${durationS.toFixed(1)} s` }),
  },
  { maxUploadMb, defaultUrl },
);

render(state);
void loadPresets();

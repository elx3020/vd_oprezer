// The DOM side: binds the static markup in index.html to handlers once, and
// returns render(state), which updates elements in place. Nodes are never
// replaced (except preset rows and new log lines), so focus, the file input
// and video playback survive updates. Server text only ever goes in via
// textContent.
import { formatMb, isRunning, messageFor, summary, type LogLine, type State } from "./app.js";
import type { Phase } from "./backend.js";

export interface Handlers {
  file(file: File): void;
  preset(id: string): void;
  convert(): void;
  cancel(): void;
  tryAgain(): void;
  another(): void;
  expert(): void;
  url(value: string, key: string): void;
  resetUrl(): void;
  videoInfo(width: number, height: number, durationS: number): void;
}

const PHASE_TEXT: Record<Phase, string> = {
  uploading: "Uploading",
  queued: "Waiting for the server",
  converting: "Converting",
  downloading: "Preparing the preview",
};

const DROP_TEXT = "Drop a video here, or choose a file";

/** Binds handlers once and returns render(state), which updates the static markup in place. */
export function mountView(doc: Document, handlers: Handlers, opts: { maxUploadMb?: number; defaultUrl: string }): (state: State) => void {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const el = {
    expert: $<HTMLInputElement>("expert"),
    drop: $("drop"),
    file: $<HTMLInputElement>("file"),
    dropText: $("drop-text"),
    limitNote: $("limit-note"),
    presets: $("presets"),
    presetsError: $("presets-error"),
    convertStep: $("convert-step"),
    convert: $<HTMLButtonElement>("convert"),
    running: $("running"),
    phase: $("phase"),
    bar: $<HTMLProgressElement>("bar"),
    cancel: $<HTMLButtonElement>("cancel"),
    result: $("result"),
    summary: $("summary"),
    beforeBar: $("before-bar"),
    afterBar: $("after-bar"),
    video: $<HTMLVideoElement>("video"),
    download: $<HTMLAnchorElement>("download"),
    another: $<HTMLButtonElement>("another"),
    failure: $("failure"),
    failureText: $("failure-text"),
    tryAgain: $<HTMLButtonElement>("try-again"),
    status: $("status"),
    logPanel: $("log-panel"),
    urlForm: $<HTMLFormElement>("url-form"),
    url: $<HTMLInputElement>("url"),
    key: $<HTMLInputElement>("key"),
    connect: $<HTMLButtonElement>("connect"),
    resetUrl: $<HTMLButtonElement>("reset-url"),
    log: $<HTMLOListElement>("log"),
  };

  el.expert.addEventListener("change", () => handlers.expert());
  el.file.addEventListener("change", () => {
    const file = el.file.files?.[0];
    if (file) handlers.file(file);
    el.file.value = ""; // picking the same file again still fires change
  });
  el.drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.drop.classList.add("over");
  });
  el.drop.addEventListener("dragleave", () => el.drop.classList.remove("over"));
  el.drop.addEventListener("drop", (e) => {
    e.preventDefault();
    el.drop.classList.remove("over");
    const file = e.dataTransfer?.files[0];
    if (file && !el.file.disabled) handlers.file(file);
  });
  el.presets.addEventListener("change", (e) => handlers.preset((e.target as HTMLInputElement).value));
  el.convert.addEventListener("click", () => handlers.convert());
  el.cancel.addEventListener("click", () => handlers.cancel());
  el.another.addEventListener("click", () => handlers.another());
  el.tryAgain.addEventListener("click", () => handlers.tryAgain());
  el.urlForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (el.url.reportValidity()) handlers.url(el.url.value.trim(), el.key.value.trim());
  });
  el.resetUrl.addEventListener("click", () => handlers.resetUrl());
  el.video.addEventListener("loadedmetadata", () => handlers.videoInfo(el.video.videoWidth, el.video.videoHeight, el.video.duration));

  el.limitNote.textContent = `${opts.maxUploadMb ? `Up to ${opts.maxUploadMb} MB. ` : ""}Your video is deleted from the server once it's converted and downloaded.`;
  el.url.placeholder = opts.defaultUrl;

  let shownPresets: State["presets"] | undefined;
  let shownLog = 0;
  let shownUrl: string | undefined;
  let shownKey: string | undefined;
  let shownVideo: string | undefined;
  let shownStatus = "";

  return function render(state: State) {
    const { status } = state;
    const running = isRunning(status);

    doc.body.classList.toggle("expert", state.expert);
    el.expert.checked = state.expert;
    el.logPanel.hidden = !state.expert;

    el.file.disabled = running;
    el.dropText.textContent = state.file ? `${state.file.name} (${formatMb(state.file.size)})` : DROP_TEXT;

    if (state.presets !== shownPresets) {
      shownPresets = state.presets;
      el.presets.replaceChildren(...presetRows(doc, state.presets));
      el.presetsError.hidden = state.presets === "loading" || Array.isArray(state.presets);
      el.presets.hidden = !el.presetsError.hidden;
      if (!el.presetsError.hidden) el.presetsError.textContent = presetsError(state.presets);
    }
    for (const input of el.presets.querySelectorAll("input")) {
      input.checked = input.value === state.presetId;
      input.disabled = running;
    }

    el.convertStep.hidden = !(status.name === "idle" || status.name === "ready");
    el.convert.disabled = status.name !== "ready";

    el.running.hidden = !running;
    if (running) {
      const fraction = "fraction" in status ? status.fraction : undefined;
      el.phase.textContent = PHASE_TEXT[status.name as Phase] + (fraction === undefined ? "…" : ` ${Math.round(fraction * 100)}%`);
      if (fraction === undefined) el.bar.removeAttribute("value");
      else el.bar.value = fraction;
    }

    el.result.hidden = status.name !== "done";
    if (status.name === "done") {
      if (shownVideo !== status.url) {
        shownVideo = status.url;
        el.video.src = status.url;
      }
      el.download.href = status.url;
      el.download.download = status.filename;
      const input = state.file?.size ?? status.outputBytes;
      el.summary.textContent = summary(input, status.outputBytes);
      const max = Math.max(input, status.outputBytes, 1);
      el.beforeBar.style.width = `${(input / max) * 100}%`;
      el.afterBar.style.width = `${(status.outputBytes / max) * 100}%`;
    } else if (shownVideo) {
      shownVideo = undefined;
      el.video.removeAttribute("src");
      el.video.load();
    }

    el.failure.hidden = status.name !== "failed";
    if (status.name === "failed") el.failureText.textContent = messageFor(status.kind, status.message, opts.maxUploadMb);

    // Announce state changes, not every percent.
    const announce = running ? PHASE_TEXT[status.name as Phase] : status.name === "done" ? `Done. ${el.summary.textContent}` : status.name === "failed" ? el.failureText.textContent : "";
    if (announce !== shownStatus) el.status.textContent = shownStatus = announce ?? "";

    el.url.disabled = el.key.disabled = el.connect.disabled = el.resetUrl.disabled = running;
    if (state.backendUrl !== shownUrl) {
      shownUrl = state.backendUrl;
      el.url.value = state.backendUrl;
    }
    if (state.apiKey !== shownKey) {
      shownKey = state.apiKey;
      el.key.value = state.apiKey;
    }

    if (state.log.length > shownLog) {
      el.log.append(...state.log.slice(shownLog).map((line) => logLine(doc, line)));
      shownLog = state.log.length;
      el.log.scrollTop = el.log.scrollHeight;
    }
  };
}

function presetsError(presets: State["presets"]): string {
  const kind = typeof presets === "object" && "kind" in presets ? presets.kind : undefined;
  return kind === "unauthorized" ? messageFor(kind, "") : "Can't reach the demo server. Reload the page to try again.";
}

function presetRows(doc: Document, presets: State["presets"]): HTMLElement[] {
  if (presets === "loading") {
    const note = doc.createElement("p");
    note.className = "note";
    note.textContent = "Loading presets…";
    return [note];
  }
  if (!Array.isArray(presets)) return [];
  return presets.map((preset) => {
    const row = doc.createElement("label");
    row.className = "preset";
    const input = doc.createElement("input");
    input.type = "radio";
    input.name = "preset";
    input.value = preset.id;
    const name = doc.createElement("span");
    name.className = "preset-name";
    name.textContent = preset.label;
    const description = doc.createElement("span");
    description.className = "preset-desc";
    description.textContent = preset.description;
    row.append(input, name, description);
    return row;
  });
}

/** One log line; lines with data expand to their JSON (native <details>, no JS). */
function logLine(doc: Document, line: LogLine): HTMLLIElement {
  const item = doc.createElement("li");
  const time = doc.createElement("time");
  time.dateTime = new Date(line.at).toISOString();
  time.textContent = new Date(line.at).toLocaleTimeString([], { hour12: false });
  const text = [line.label, line.status, line.ms === undefined ? undefined : `${line.ms} ms`].filter((part) => part !== undefined).join("  ");
  if (line.data === undefined) {
    item.append(time, text);
    return item;
  }
  const details = doc.createElement("details");
  const head = doc.createElement("summary");
  head.append(time, text);
  const pre = doc.createElement("pre");
  pre.textContent = typeof line.data === "string" ? line.data : JSON.stringify(line.data, null, 2);
  details.append(head, pre);
  item.append(details);
  return item;
}

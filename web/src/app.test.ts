import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initialState, isRunning, messageFor, reduce, shouldLoadPresets, summary, type Action } from "./app.js";

const MB = 1024 ** 2;
const file = new File(["x"], "clip.mov");
const presets = [
  { id: "web", label: "Web", description: "d" },
  { id: "youtube", label: "Youtube", description: "d" },
];
const loaded = reduce(initialState("http://localhost:3000", false), { type: "presetsLoaded", presets });
const ready = reduce(loaded, { type: "fileChosen", file });
const running = reduce(ready, { type: "started" });

describe("summary", () => {
  it("says smaller, larger, or about the same", () => {
    assert.equal(summary(48.2 * MB, 12.1 * MB), "48.2 MB → 12.1 MB (75% smaller)");
    assert.equal(summary(10 * MB, 11.2 * MB), "10.0 MB → 11.2 MB (12% larger)");
    assert.equal(summary(10 * MB, 10.02 * MB), "10.0 MB → 10.0 MB (about the same size)");
  });
});

describe("messageFor", () => {
  it("uses the visitor copy, the limit when known, and passes rejected messages through", () => {
    assert.equal(messageFor("too_large", "", 100), "This file is too big for the demo (limit: 100 MB).");
    assert.equal(messageFor("too_large", ""), "This file is too big for the demo.");
    assert.equal(messageFor("busy", "x"), "The demo server is busy. Try again in a minute.");
    assert.equal(messageFor("unsupported", "x"), "That file doesn't look like a video we can read.");
    const reason = 'Input is 2.1s long; "instagram-reel" accepts 3s to 900s.';
    assert.equal(messageFor("rejected", reason), reason);
    assert.equal(messageFor("failed", "x"), "The conversion failed.");
    assert.equal(messageFor("expired", "x"), "The result expired on the server. Please convert again.");
    assert.equal(messageFor("unreachable", "x"), "Can't reach the demo server.");
    assert.equal(messageFor("unauthorized", "x"), "The server needs an API key. Enter it in expert mode.");
  });
});

describe("reduce", () => {
  it("starts loading presets, idle, with an empty log", () => {
    const state = initialState("http://localhost:3000", true);
    assert.equal(state.presets, "loading");
    assert.deepEqual(state.status, { name: "idle" });
    assert.deepEqual(state.log, []);
    assert.equal(state.expert, true);
    assert.equal(state.apiKey, "");
    assert.equal(initialState("http://localhost:3000", false, "k").apiKey, "k");
  });

  it("preselects the first preset; choosing a file then makes it ready", () => {
    assert.equal(loaded.presetId, "web");
    assert.deepEqual(ready.status, { name: "ready" });
    assert.equal(reduce(ready, { type: "presetChosen", id: "youtube" }).presetId, "youtube");
  });

  it("keeps a chosen preset when presets reload, unless the new backend lacks it", () => {
    const chosen = reduce(loaded, { type: "presetChosen", id: "youtube" });
    assert.equal(reduce(chosen, { type: "presetsLoaded", presets }).presetId, "youtube");
    const other = [{ id: "small", label: "Small", description: "d" }];
    assert.equal(reduce(chosen, { type: "presetsLoaded", presets: other }).presetId, "small");
  });

  it("records a failed presets load", () => {
    assert.deepEqual(reduce(loaded, { type: "presetsFailed", error: "HTTP 502" }).presets, { error: "HTTP 502" });
    assert.deepEqual(reduce(loaded, { type: "presetsFailed", error: "Missing key", kind: "unauthorized" }).presets, { error: "Missing key", kind: "unauthorized" });
  });

  it("runs: started → uploading 0, progress phases, finished → done", () => {
    assert.deepEqual(running.status, { name: "uploading", fraction: 0 });
    assert.equal(isRunning(running.status), true);
    assert.deepEqual(reduce(running, { type: "progress", phase: "converting", fraction: 0.4 }).status, { name: "converting", fraction: 0.4 });
    assert.deepEqual(reduce(running, { type: "progress", phase: "queued" }).status, { name: "queued" });
    const done = reduce(running, { type: "finished", url: "blob:x", filename: "clip-web.mp4", outputBytes: 4 });
    assert.deepEqual(done.status, { name: "done", url: "blob:x", filename: "clip-web.mp4", outputBytes: 4 });
    assert.equal(isRunning(done.status), false);
  });

  it("ignores progress when nothing is running", () => {
    assert.equal(reduce(ready, { type: "progress", phase: "converting", fraction: 0.5 }), ready);
  });

  it("cancelled → ready with the same file and preset; tryAgain → ready; another → idle without file", () => {
    const cancelled = reduce(running, { type: "cancelled" });
    assert.deepEqual(cancelled.status, { name: "ready" });
    assert.equal(cancelled.file, file);
    assert.equal(cancelled.presetId, "web");

    const failed = reduce(running, { type: "failed", kind: "busy", message: "m" });
    assert.deepEqual(failed.status, { name: "failed", kind: "busy", message: "m" });
    assert.deepEqual(reduce(failed, { type: "tryAgain" }).status, { name: "ready" });

    const another = reduce(reduce(running, { type: "finished", url: "blob:x", filename: "f", outputBytes: 1 }), { type: "another" });
    assert.deepEqual(another.status, { name: "idle" });
    assert.equal(another.file, undefined);
    assert.equal(another.presetId, "web");
  });

  it("ignores fileChosen, presetChosen and urlChanged while running", () => {
    const actions: Action[] = [
      { type: "fileChosen", file: new File(["y"], "b.mov") },
      { type: "presetChosen", id: "youtube" },
      { type: "urlChanged", url: "https://x.example" },
    ];
    for (const action of actions) assert.equal(reduce(running, action), running);
  });

  it("ignores started unless ready", () => {
    assert.equal(reduce(loaded, { type: "started" }), loaded);
    assert.equal(reduce(running, { type: "started" }), running);
  });

  it("choosing a new file after a result starts over from ready", () => {
    const done = reduce(running, { type: "finished", url: "blob:x", filename: "f", outputBytes: 1 });
    assert.deepEqual(reduce(done, { type: "fileChosen", file }).status, { name: "ready" });
  });

  it("accepts only http(s) URLs, and reloads presets on a change", () => {
    assert.equal(reduce(loaded, { type: "urlChanged", url: "localhost:3000" }), loaded);
    assert.equal(reduce(loaded, { type: "urlChanged", url: "not a url" }), loaded);
    const changed = reduce(loaded, { type: "urlChanged", url: "https://demo.example/api/" });
    assert.equal(changed.backendUrl, "https://demo.example/api/");
    assert.equal(changed.presets, "loading");
    assert.equal(changed.apiKey, "", "no key given: keeps the current one");
  });

  it("changes the API key with the URL (Connect, Reset) and reloads presets", () => {
    const keyed = reduce(loaded, { type: "urlChanged", url: loaded.backendUrl, key: "k" });
    assert.equal(keyed.apiKey, "k");
    assert.equal(keyed.presets, "loading");
    assert.equal(reduce(keyed, { type: "urlChanged", url: keyed.backendUrl }).apiKey, "k");
    assert.equal(reduce(running, { type: "urlChanged", url: running.backendUrl, key: "k" }), running);
  });

  it("loads presets after a URL change, even while an earlier load is still running", () => {
    const starting = initialState("http://a.example", false); // presets "loading"
    assert.equal(shouldLoadPresets(starting, reduce(starting, { type: "urlChanged", url: "http://b.example" })), true);
    assert.equal(shouldLoadPresets(loaded, reduce(loaded, { type: "urlChanged", url: loaded.backendUrl })), true); // retry
    assert.equal(shouldLoadPresets(starting, reduce(starting, { type: "urlChanged", url: starting.backendUrl })), false);
    assert.equal(shouldLoadPresets(starting, reduce(starting, { type: "urlChanged", url: starting.backendUrl, key: "k" })), true);
    assert.equal(shouldLoadPresets(loaded, reduce(loaded, { type: "expertToggled" })), false);
  });

  it("toggles expert mode", () => {
    assert.equal(reduce(loaded, { type: "expertToggled" }).expert, true);
  });

  it("appends log lines with their time and keeps them across conversions", () => {
    const logged = reduce(running, { type: "log", entry: { label: "POST /jobs", status: 202 }, at: 1000 });
    assert.deepEqual(logged.log, [{ label: "POST /jobs", status: 202, at: 1000 }]);
    assert.equal(reduce(reduce(logged, { type: "cancelled" }), { type: "another" }).log.length, 1);
  });
});

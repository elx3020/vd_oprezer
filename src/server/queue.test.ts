import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLimiter } from "./queue.js";

/** A task that runs until release() is called, recording start order and peak concurrency. */
function tasks() {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  let active = 0;
  let peak = 0;
  const task = (name: string) => () =>
    new Promise<string>((resolve) => {
      started.push(name);
      peak = Math.max(peak, ++active);
      releases.set(name, () => {
        active--;
        resolve(name);
      });
    });
  const release = async (name: string) => {
    releases.get(name)?.();
    await new Promise((r) => setImmediate(r));
  };
  return { started, task, release, peak: () => peak };
}

describe("createLimiter", () => {
  it("runs at most `concurrency` tasks at once, in FIFO order", async () => {
    const limiter = createLimiter(2);
    const t = tasks();
    const results = ["a", "b", "c", "d"].map((name) => limiter.run(t.task(name)));
    await t.release("none");
    assert.deepEqual(t.started, ["a", "b"]);
    assert.deepEqual([limiter.running, limiter.waiting], [2, 2]);

    await t.release("b");
    assert.deepEqual(t.started, ["a", "b", "c"]);
    for (const name of ["a", "c", "d"]) await t.release(name);
    assert.deepEqual(await Promise.all(results), ["a", "b", "c", "d"]);
    assert.equal(t.peak(), 2);
    assert.deepEqual([limiter.running, limiter.waiting], [0, 0]);
  });

  it("removes a waiting task when its signal aborts", async () => {
    const limiter = createLimiter(1);
    const t = tasks();
    void limiter.run(t.task("a"));
    const controller = new AbortController();
    const b = limiter.run(t.task("b"), controller.signal);
    void limiter.run(t.task("c"));
    controller.abort();
    await assert.rejects(b, { name: "AbortError" });
    assert.equal(limiter.waiting, 1);

    await t.release("a");
    assert.deepEqual(t.started, ["a", "c"]);
  });

  it("rejects at once when the signal is already aborted", async () => {
    await assert.rejects(createLimiter(1).run(() => Promise.resolve(1), AbortSignal.abort()), { name: "AbortError" });
  });

  it("frees the slot when a task fails", async () => {
    const limiter = createLimiter(1);
    await assert.rejects(limiter.run(() => Promise.reject(new Error("boom"))), /boom/);
    assert.equal(await limiter.run(() => Promise.resolve("next")), "next");
  });
});

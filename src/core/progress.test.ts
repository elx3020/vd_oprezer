import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProgressParser, type Progress } from "./progress.js";

function parse(durationMs: number | undefined, text: string): Progress[] {
  const reports: Progress[] = [];
  const onLine = createProgressParser(durationMs, (p) => reports.push(p));
  for (const line of text.trim().split("\n")) onLine(line);
  return reports;
}

describe("createProgressParser", () => {
  it("reports once per block with percent, eta and stats", () => {
    const reports = parse(
      20_000,
      `
frame=240
fps=48.1
bitrate=1520.3kbits/s
total_size=1900544
out_time_us=10000000
speed=2x
progress=continue`,
    );
    assert.deepEqual(reports, [
      {
        outTimeMs: 10_000,
        durationMs: 20_000,
        percent: 50,
        speed: 2,
        etaMs: 5_000,
        frame: 240,
        fps: 48.1,
        totalSizeBytes: 1_900_544,
        bitrateKbps: 1520.3,
        done: false,
      },
    ]);
  });

  it("starts each block fresh", () => {
    const [first, second] = parse(10_000, "frame=1\nout_time_us=1000000\nprogress=continue\nout_time_us=2000000\nprogress=continue");
    assert.equal(first?.frame, 1);
    assert.equal(second?.frame, undefined);
    assert.equal(second?.percent, 20);
  });

  it("ends at 100 % with eta 0", () => {
    const [last] = parse(20_000, "out_time_us=19960000\nspeed=3x\nprogress=end");
    assert.equal(last?.percent, 100);
    assert.equal(last?.etaMs, 0);
    assert.equal(last?.done, true);
  });

  it("leaves percent and eta undefined when the duration is unknown", () => {
    const [p] = parse(undefined, "out_time_us=5000000\nspeed=1x\nprogress=continue");
    assert.equal(p?.outTimeMs, 5_000);
    assert.equal(p?.percent, undefined);
    assert.equal(p?.etaMs, undefined);
  });

  it("treats N/A as unknown (FFmpeg prints it before the first frame)", () => {
    const [p] = parse(10_000, "out_time_us=N/A\nspeed=N/A\nbitrate=N/A\nprogress=continue");
    assert.equal(p?.outTimeMs, 0);
    assert.equal(p?.percent, 0);
    assert.equal(p?.speed, undefined);
    assert.equal(p?.etaMs, undefined);
    assert.equal(p?.bitrateKbps, undefined);
  });

  it("clamps percent to 100 when output runs past the probed duration", () => {
    const [p] = parse(10_000, "out_time_us=10500000\nprogress=continue");
    assert.equal(p?.percent, 100);
  });

  it("falls back to out_time_ms, which FFmpeg also reports in microseconds", () => {
    const [p] = parse(10_000, "out_time_ms=4000000\nprogress=continue");
    assert.equal(p?.outTimeMs, 4_000);
  });

  it("ignores lines that are not key=value", () => {
    assert.deepEqual(parse(10_000, "garbage\n\nnoise"), []);
  });
});

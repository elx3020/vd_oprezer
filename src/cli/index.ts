// Public API of the cli module: run the CLI without side effects at import
// time, so it can be tested and later published as its own package.
//
// TEMPORARY hand-rolled argument handling to exercise the engine.
// Replaced by a real CLI framework in decision 4.
import { createEngine, isVdError, type EngineConfig, type Progress } from "#core";

export interface CliContext extends EngineConfig {
  /** Aborted on Ctrl+C by main.ts. */
  signal?: AbortSignal;
}

export const EXIT = { ok: 0, error: 1, usage: 2, aborted: 130 } as const;

const USAGE = `Usage (temporary):
  vd-oprezer version
  vd-oprezer probe <input>
  vd-oprezer convert <input> <output> [--overwrite] [-- <ffmpeg encoding args...>]

Example:
  vd-oprezer convert in.mov out.mp4 -- -c:v libx264 -crf 23 -c:a aac -b:a 128k`;

/** Runs the CLI with the given arguments and resolves to the exit code. */
export async function run(argv: string[], ctx: CliContext = {}): Promise<number> {
  const engine = createEngine(ctx);
  const { signal } = ctx;
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case "version": {
        const v = await engine.versions({ signal });
        console.log(`${v.ffmpeg}\n${v.ffprobe}`);
        return EXIT.ok;
      }

      case "probe": {
        const [input] = rest;
        if (!input) return usage();
        console.log(JSON.stringify(await engine.probe(input, { signal }), null, 2));
        return EXIT.ok;
      }

      case "convert": {
        const sep = rest.indexOf("--");
        const own = sep === -1 ? rest : rest.slice(0, sep);
        const ffArgs = sep === -1 ? [] : rest.slice(sep + 1);
        const overwrite = own.includes("--overwrite");
        const [input, output] = own.filter((a) => a !== "--overwrite");
        if (!input || !output) return usage();

        const result = await engine.transcode({ input, output, args: ffArgs, overwrite, signal, onProgress: renderProgress });
        process.stderr.write("\n");
        const ratio = result.input.sizeBytes ? ` (${Math.round((result.sizeBytes / result.input.sizeBytes) * 100)}% of input)` : "";
        console.log(`✓ ${result.output}: ${formatBytes(result.sizeBytes)}${ratio} in ${(result.elapsedMs / 1000).toFixed(1)}s`);
        return EXIT.ok;
      }

      default:
        return usage();
    }
  } catch (error) {
    if (signal?.aborted) {
      process.stderr.write("\n✗ cancelled\n");
      return EXIT.aborted;
    }
    if (isVdError(error)) {
      process.stderr.write(`\n✗ ${error.message}\n`);
      return EXIT.error;
    }
    throw error;
  }
}

function usage(): number {
  console.error(USAGE);
  return EXIT.usage;
}

function renderProgress(p: Progress): void {
  if (!process.stderr.isTTY && !p.done) return;
  const pct = p.percent === undefined ? "  ?%" : `${p.percent.toFixed(0).padStart(3)}%`;
  const speed = p.speed === undefined ? "" : ` ${p.speed.toFixed(2)}x`;
  const eta = p.etaMs === undefined ? "" : ` eta ${Math.ceil(p.etaMs / 1000)}s`;
  process.stderr.write(`\r${pct}${speed}${eta}`.padEnd(32));
}

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

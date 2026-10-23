// Public API of the cli module: run the CLI without side effects at import
// time, so it can be tested and later published as its own package.
import path from "node:path";
import { Command, CommanderError } from "@commander-js/extra-typings";
import { createEngine, isVdError, type EngineConfig, type MediaInfo, type Progress } from "#core";

/** Where the CLI writes: a process stream, or a fake in tests. */
export interface Output {
  write(text: string): unknown;
  isTTY?: boolean;
}

export interface CliContext extends EngineConfig {
  /** Aborted on Ctrl+C by main.ts. */
  signal?: AbortSignal;
  /** vd-oprezer's own version, shown by `--version` and `version`. */
  version?: string;
  /** Results. Default: process.stdout. */
  stdout?: Output;
  /** Progress, errors and help on errors. Default: process.stderr. */
  stderr?: Output;
}

export const EXIT = { ok: 0, error: 1, usage: 2, aborted: 130 } as const;

/** Runs the CLI with the given arguments and resolves to the exit code. */
export async function run(argv: string[], ctx: CliContext = {}): Promise<number> {
  const { signal, version = "unknown", stdout = process.stdout, stderr = process.stderr } = ctx;
  const engine = createEngine(ctx);
  const out = (text: string) => stdout.write(`${text}\n`);
  let code: number = EXIT.ok;

  // Everything after the first "--" goes to FFmpeg untouched; commander
  // would otherwise take it as more inputs.
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const ffArgs = sep === -1 ? [] : argv.slice(sep + 1);

  // Subcommands inherit exitOverride and the output config from here, so
  // commander throws instead of calling process.exit.
  const program = new Command("vd-oprezer")
    .description("Optimize and resize videos with FFmpeg.")
    .version(version)
    .exitOverride()
    .configureOutput({ writeOut: (s) => stdout.write(s), writeErr: (s) => stderr.write(s) });

  program
    .command("version")
    .description("show vd-oprezer, ffmpeg and ffprobe versions")
    .action(async () => {
      const v = await engine.versions({ signal });
      out(`vd-oprezer ${version}\n${v.ffmpeg}\n${v.ffprobe}`);
    });

  program
    .command("probe")
    .description("show what ffprobe reports about a file")
    .argument("<input>")
    .option("--json", "print the full result as JSON")
    .action(async (input, { json }) => {
      const info = await engine.probe(input, { signal });
      out(json ? JSON.stringify(info, null, 2) : summary(info));
    });

  program
    .command("convert")
    .description("encode one or more files; arguments after -- go to FFmpeg as-is")
    .argument("<inputs...>")
    .option("-o, --output <file>", "output file (one input only)")
    .option("--out-dir <dir>", "write each output into this directory, keeping its file name")
    .option("--overwrite", "replace outputs that already exist")
    .addHelpText("after", "\nExample:\n  vd-oprezer convert in.mov -o out.mp4 -- -c:v libx264 -crf 23 -c:a aac -b:a 128k")
    .action(async (inputs, opts, command) => {
      if (!opts.output === !opts.outDir) command.error("error: pass either --output or --out-dir");
      if (opts.output && inputs.length > 1) command.error("error: --output takes one input; use --out-dir for several");

      for (const input of inputs) {
        // ponytail: --out-dir keeps the input's name, so two inputs with the same name collide; the presets step decides naming.
        const output = opts.output ?? path.join(opts.outDir ?? "", path.basename(input));
        const onProgress = stderr.isTTY ? (p: Progress) => stderr.write(progressLine(p)) : undefined;
        try {
          const res = await engine.transcode({ input, output, args: ffArgs, overwrite: opts.overwrite, signal, onProgress });
          if (onProgress) stderr.write("\n");
          const ratio = res.input.sizeBytes ? ` (${Math.round((res.sizeBytes / res.input.sizeBytes) * 100)}% of input)` : "";
          out(`✓ ${res.output}: ${formatBytes(res.sizeBytes)}${ratio} in ${(res.elapsedMs / 1000).toFixed(1)}s`);
        } catch (error) {
          if (signal?.aborted || !isVdError(error)) throw error;
          // One bad file doesn't stop the batch; the exit code reports it.
          stderr.write(`${onProgress ? "\n" : ""}✗ ${input}: ${error.message}\n`);
          code = EXIT.error;
        }
      }
    });

  try {
    await program.parseAsync(own, { from: "user" });
    return code;
  } catch (error) {
    // Commander has already printed help, the version, or the usage error.
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT.ok : EXIT.usage;
    if (signal?.aborted) {
      stderr.write("\n✗ cancelled\n");
      return EXIT.aborted;
    }
    if (isVdError(error)) {
      stderr.write(`✗ ${error.message}\n`);
      return EXIT.error;
    }
    throw error;
  }
}

function summary(info: MediaInfo): string {
  const { video: v, audio: a } = info;
  return [
    `format:   ${info.formatName}`,
    `duration: ${info.durationMs === undefined ? "unknown" : `${(info.durationMs / 1000).toFixed(1)}s`}`,
    `size:     ${info.sizeBytes === undefined ? "unknown" : formatBytes(info.sizeBytes)}`,
    `video:    ${v ? `${v.codec} ${v.width}x${v.height}${v.fps ? ` ${v.fps}fps` : ""}${v.rotation ? ` rotated ${v.rotation}°` : ""}` : "none"}`,
    `audio:    ${a ? `${a.codec}${a.channels ? ` ${a.channels}ch` : ""}${a.sampleRate ? ` ${a.sampleRate}Hz` : ""}` : "none"}`,
  ].join("\n");
}

function progressLine(p: Progress): string {
  const pct = p.percent === undefined ? "  ?%" : `${p.percent.toFixed(0).padStart(3)}%`;
  const speed = p.speed === undefined ? "" : ` ${p.speed.toFixed(2)}x`;
  const eta = p.etaMs === undefined ? "" : ` eta ${Math.ceil(p.etaMs / 1000)}s`;
  return `\r${pct}${speed}${eta}`.padEnd(32);
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

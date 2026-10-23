// Public API of the cli module: run the CLI without side effects at import
// time, so it can be tested and later published as its own package.
import path from "node:path";
import { Command, CommanderError } from "@commander-js/extra-typings";
import {
  PRESETS,
  buildArgs,
  createEngine,
  isVdError,
  parseEncodeOptions,
  type EncodeOptions,
  type EngineConfig,
  type MediaInfo,
  type PresetName,
  type Progress,
} from "#core";

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
    .command("presets")
    .description("list presets, or show one preset's settings")
    .argument("[name]")
    .action((name, _opts, command) => {
      if (name === undefined) {
        for (const [key, preset] of Object.entries(PRESETS)) out(`${key.padEnd(16)}${preset.description}`);
      } else if (Object.hasOwn(PRESETS, name)) {
        out(JSON.stringify(PRESETS[name as PresetName], null, 2));
      } else {
        command.error(`error: unknown preset '${name}'. Available: ${Object.keys(PRESETS).join(", ")}`);
      }
    });

  program
    .command("convert")
    .description("encode one or more files with a preset; arguments after -- go to FFmpeg last, as-is")
    .argument("<inputs...>")
    .option("-p, --preset <name>", `${Object.keys(PRESETS).join(", ")} (default: web)`)
    .option("--crf <n>", "quality, 0-51: lower is better and bigger (default: the preset's)")
    .option("--max-size <px>", "shrink so the short side is at most this, e.g. 720 (default: the preset's)")
    .option("-o, --output <file>", "output file (one input only; default: <name>-<preset>.mp4 next to the input)")
    .option("--out-dir <dir>", "write <name>.mp4 for each input into this directory")
    .option("--overwrite", "replace outputs that already exist")
    .addHelpText("after", "\nExamples:\n  vd-oprezer convert clip.mov -p ecommerce\n  vd-oprezer convert *.mov -p web --max-size 720 --out-dir out")
    .action(async (inputs, opts, command) => {
      if (opts.output && opts.outDir) command.error("error: pass --output or --out-dir, not both");
      if (opts.output && inputs.length > 1) command.error("error: --output takes one input; use --out-dir for several");
      const options = encodeOptions({ preset: opts.preset, crf: opts.crf, maxSize: opts.maxSize }, command);

      for (const input of inputs) {
        // ponytail: --out-dir names outputs after the input, so two inputs with the same name collide (OUTPUT_EXISTS).
        const name = path.parse(input).name;
        const output =
          opts.output ?? (opts.outDir ? path.join(opts.outDir, `${name}.mp4`) : path.join(path.dirname(input), `${name}-${options.preset}.mp4`));
        const onProgress = stderr.isTTY ? (p: Progress) => stderr.write(progressLine(p)) : undefined;
        try {
          const args = (info: MediaInfo) => [...buildArgs(options, info), ...ffArgs];
          const res = await engine.transcode({ input, output, args, overwrite: opts.overwrite, signal, onProgress });
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

/** parseEncodeOptions, reporting problems as a usage error (exit 2). */
function encodeOptions(raw: unknown, command: { error(message: string): never }): EncodeOptions {
  try {
    return parseEncodeOptions(raw);
  } catch (error) {
    if (!isVdError(error)) throw error;
    return command.error(`error: ${error.message}`);
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

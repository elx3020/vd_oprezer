# Diagrams

UML views of the codebase, in Mermaid (GitHub renders them). Keep them in
sync with the code: a change that adds, removes or renames a module, file,
exported type/function, route, job state or flow updates the matching
diagram in the same change. Prose and rules live in `ARCHITECTURE.md`.

1. [Components](#1-components)
2. [core: classes](#2-core-classes)
3. [server: classes](#3-server-classes)
4. [cli: classes](#4-cli-classes)
5. [web demo: classes](#5-web-demo-classes)
6. [Sequence: CLI convert](#6-sequence-cli-convert)
7. [Sequence: async job from the web demo](#7-sequence-async-job-from-the-web-demo)
8. [Sequence: POST /convert and POST /probe](#8-sequence-post-convert-and-post-probe)
9. [States: server job](#9-states-server-job)
10. [States: web demo](#10-states-web-demo)
11. [Deployment: Docker image](#11-deployment-docker-image)

## 1. Components

Arrows are imports / calls. cli and server reach core only through `#core`
(`src/core/index.ts`); the web demo reaches the server only over HTTP.

```mermaid
flowchart LR
  subgraph pkg["npm package vd-oprezer (src/)"]
    direction LR
    subgraph cli["cli"]
      cliMain["main.ts<br/>(argv, env, signals)"] --> cliIndex["index.ts<br/>run(argv, ctx)"]
    end
    subgraph server["server"]
      srvMain["main.ts<br/>(env, signals, listen)"] --> srvIndex["index.ts<br/>createApp(config)"]
      srvIndex --> jobs["jobs.ts"]
      srvIndex --> queue["queue.ts"]
      srvIndex --> srvErrors["errors.ts"]
      jobs --> srvErrors
      jobs -. "type Limiter" .-> queue
    end
    subgraph core["core (#core)"]
      coreIndex["index.ts"] --> engine["engine.ts"]
      coreIndex --> presets["presets.ts"]
      coreIndex --> probe["probe.ts"]
      coreIndex --> progress["progress.ts"]
      coreIndex --> runner["runner.ts"]
      coreIndex --> errors["errors.ts"]
      engine --> probe
      engine --> progress
      engine --> runner
      engine --> errors
      presets --> errors
    end
    cliIndex -- "#core" --> coreIndex
    srvIndex -- "#core" --> coreIndex
    jobs -- "#core" --> coreIndex
    srvErrors -- "#core" --> coreIndex
  end

  subgraph web["web/ (separate package)"]
    webMain["main.ts"] --> app["app.ts"]
    webMain --> view["view.ts"]
    webMain --> adapter["adapters/vd-oprezer.ts"]
    webMain --> backend["backend.ts"]
    view --> app
    app -. types .-> backend
    adapter --> backend
  end

  commander[["@commander-js/extra-typings"]]
  fastify[["fastify + @fastify/multipart"]]
  zod[["zod"]]
  ffmpeg[("ffmpeg / ffprobe<br/>child processes")]

  cliIndex --> commander
  srvIndex --> fastify
  presets --> zod
  runner -- spawn --> ffmpeg
  adapter -- "HTTP (XHR, fetch, SSE)" --> srvIndex
```

## 2. core: classes

Factory functions and plain objects, drawn as classes. `«factory»` marks a
function that returns the object it points to.

```mermaid
classDiagram
  direction LR

  class createEngine {
    <<factory>>
    createEngine(config: EngineConfig) Engine
  }
  class EngineConfig {
    <<interface>>
    ffmpegPath?: string
    ffprobePath?: string
    runner?: Runner
  }
  class Engine {
    <<interface>>
    versions(options?: CallOptions) Promise~EngineVersions~
    probe(input: string, options?: CallOptions) Promise~MediaInfo~
    transcode(options: TranscodeOptions) Promise~TranscodeResult~
  }
  class CallOptions {
    <<interface>>
    signal?: AbortSignal
  }
  class TranscodeOptions {
    <<interface>>
    input: string
    output: string
    args: string[] or (MediaInfo) => string[]
    overwrite?: boolean
    onProgress?: (Progress) => void
  }
  class TranscodeResult {
    <<interface>>
    output: string
    sizeBytes: number
    elapsedMs: number
    input: MediaInfo
  }
  class EngineVersions {
    <<interface>>
    ffmpeg: string
    ffprobe: string
  }

  class Runner {
    <<type>>
    call(command, args, options?: RunOptions) Promise~RunResult~
  }
  class spawnRunner {
    <<const Runner>>
    kills with SIGKILL on abort
  }
  class RunOptions {
    <<interface>>
    signal?: AbortSignal
    onStdoutLine?: (line) => void
  }
  class RunResult {
    <<interface>>
    exitCode: number or null
    stdout: string
    stderr: string
  }

  class MediaInfo {
    <<interface>>
    formatName: string
    durationMs?: number
    sizeBytes?: number
    bitRate?: number
    video?: VideoStreamInfo
    audio?: AudioStreamInfo
    streamCount: number
  }
  class VideoStreamInfo {
    <<interface>>
    codec: string
    width: number
    height: number
    fps?: number
    bitRate?: number
    pixFmt?: string
    rotation: number
  }
  class AudioStreamInfo {
    <<interface>>
    codec: string
    channels?: number
    sampleRate?: number
    bitRate?: number
  }
  class probe_ts["probe.ts"] {
    <<module>>
    parseProbeOutput(json: string) MediaInfo
  }

  class Progress {
    <<interface>>
    outTimeMs: number
    durationMs?: number
    percent?: number
    speed?: number
    etaMs?: number
    frame?: number
    fps?: number
    totalSizeBytes?: number
    bitrateKbps?: number
    done: boolean
  }
  class progress_ts["progress.ts"] {
    <<module>>
    createProgressParser(durationMs, onProgress) (line) => void
  }

  class Preset {
    <<interface>>
    description: string
    crf: number
    speed: veryfast..slower
    maxSize?: number
    maxFps?: number
    maxBitrateKbps?: number
    gopSeconds?: number
    bframes?: number
    audioKbps: number or false
    stripMetadata?: boolean
    durationS?: min, max
  }
  class EncodeOptions {
    <<zod output>>
    preset: PresetName = "web"
    crf?: number 0-51
    maxSize?: number 16-8192
  }
  class presets_ts["presets.ts"] {
    <<module>>
    PRESETS: web, ecommerce, youtube, instagram-reel
    encodeOptionsSchema
    parseEncodeOptions(input: unknown) EncodeOptions
    buildArgs(options, input: MediaInfo) string[]
    outputDimensions(options, input: MediaInfo) width, height
  }

  class VdError {
    code: VdErrorCode
    details: VdErrorDetails
    isVdError(error, code?)$ boolean
  }
  class VdErrorCode {
    <<enumeration>>
    FFMPEG_NOT_FOUND
    INPUT_NOT_FOUND
    OUTPUT_EXISTS
    INVALID_ARGUMENT
    PROBE_FAILED
    FFMPEG_FAILED
  }
  class VdErrorDetails {
    <<interface>>
    command?: string
    exitCode?: number or null
    stderr?: string
  }
  Error <|-- VdError

  createEngine ..> Engine : returns
  createEngine --> EngineConfig
  EngineConfig --> Runner
  spawnRunner ..|> Runner
  Runner ..> RunOptions
  Runner ..> RunResult
  Engine ..> CallOptions
  CallOptions <|-- TranscodeOptions
  Engine ..> TranscodeOptions
  Engine ..> TranscodeResult
  Engine ..> EngineVersions
  Engine ..> probe_ts : parses ffprobe JSON
  Engine ..> progress_ts : parses FFmpeg -progress output
  Engine ..> VdError : throws
  TranscodeResult --> MediaInfo
  TranscodeOptions ..> Progress
  progress_ts ..> Progress
  probe_ts ..> MediaInfo
  MediaInfo *-- VideoStreamInfo
  MediaInfo *-- AudioStreamInfo
  presets_ts ..> Preset
  presets_ts ..> EncodeOptions
  presets_ts ..> MediaInfo
  presets_ts ..> VdError : throws INVALID_ARGUMENT
  VdError --> VdErrorCode
  VdError --> VdErrorDetails
```

## 3. server: classes

```mermaid
classDiagram
  direction LR

  class createApp {
    <<factory>>
    createApp(config: ServerConfig) FastifyInstance
    -receive(req, input) filename, options
    -sendFile(reply, file, filename, onClosed?)
    -assertRoom()
    -findJob(id) Job
  }
  class ServerConfig {
    <<interface>>
    maxUploadBytes?: number = 2 GiB
    workDir?: string = os tmpdir
    concurrency?: number = 1
    maxQueued?: number = 20
    jobTtlMs?: number = 1 h
    signal?: AbortSignal
    logger?: FastifyServerOptions.logger
    corsOrigins?: string[]
    authKey?: string
  }
  class Routes {
    <<HTTP>>
    GET /health
    GET /presets
    GET /config
    POST /convert
    POST /probe
    POST /jobs
    GET /jobs/:id
    GET /jobs/:id/output
    GET /jobs/:id/events (SSE)
    DELETE /jobs/:id
    OPTIONS * (only with CORS)
  }
  class Hooks {
    <<Fastify hooks>>
    onReady: log config, wipe and create work dirs
    onRequest: CORS headers (opt-in)
    onRequest: Bearer auth (opt-in)
    preClose: abort encodes and streams
    onClose: await jobs.settled, delete work dir
    errorHandler: AbortError to 499/503, else publicError
  }

  class createJobs {
    <<factory>>
    createJobs(config: JobsConfig) Jobs
  }
  class JobsConfig {
    <<interface>>
    engine: Engine
    limiter: Limiter
    dir: string
    ttlMs: number
    signal: AbortSignal
    log: FastifyBaseLogger
  }
  class Jobs {
    get(id) Job or undefined
    subscribe(id, listener: JobListener) unsubscribe
    paths(id) dir, upload, output
    submit(init: id, options, filename) Job
    remove(id) Promise~boolean~
    settled() Promise
  }
  class Entry {
    <<private>>
    job: Job
    controller: AbortController
    done: Promise~void~
    expiry?: Timeout
    listeners: Set~JobListener~
  }
  class Job {
    <<interface>>
    id: string
    status: JobStatus
    options: EncodeOptions
    filename: string
    progress: number 0-100
    createdAt: string
    finishedAt?: string
    sizeBytes?: number
    width?: number
    height?: number
    durationMs?: number
    error?: code, message
  }
  class JobStatus {
    <<enumeration>>
    queued
    running
    done
    failed
  }
  class JobListener {
    <<type>>
    call(job: Job or undefined) void
  }

  class createLimiter {
    <<factory>>
    createLimiter(concurrency) Limiter
  }
  class Limiter {
    <<interface>>
    run~T~(fn, signal?) Promise~T~
    running: number
    waiting: number
  }

  class HttpError {
    statusCode: number
    code: string
  }
  class errors_ts["errors.ts"] {
    <<module>>
    publicError(error) status, code, message
  }
  Error <|-- HttpError

  class Engine {
    <<core>>
  }
  class EngineConfig {
    <<core>>
  }

  EngineConfig <|-- ServerConfig
  createApp --> ServerConfig
  createApp *-- Routes
  createApp *-- Hooks
  createApp ..> Engine : createEngine(config)
  createApp *-- Jobs
  createApp *-- Limiter
  createApp ..> HttpError : throws
  createApp ..> errors_ts
  createJobs ..> Jobs : returns
  createJobs --> JobsConfig
  JobsConfig --> Engine
  JobsConfig --> Limiter
  Jobs "1" *-- "*" Entry
  Entry --> Job
  Entry o-- JobListener
  Job --> JobStatus
  Jobs ..> errors_ts : failed job error
  createLimiter ..> Limiter : returns
  errors_ts ..> HttpError
```

## 4. cli: classes

```mermaid
classDiagram
  direction LR

  class main_ts["main.ts"] {
    <<composition root>>
    reads package.json version, argv, FFMPEG_PATH, FFPROBE_PATH
    SIGINT/SIGTERM: abort, second press after 1 s exits 130
    exit: abort (kills FFmpeg)
  }
  class index_ts["index.ts"] {
    run(argv: string[], ctx: CliContext) Promise~number~
    EXIT: ok 0, error 1, usage 2, aborted 130
    -encodeOptions(raw, command) EncodeOptions
    -summary(info: MediaInfo) string
    -progressLine(p: Progress) string
    -formatBytes(n) string
  }
  class Commands {
    <<commander>>
    version
    probe [input] --json
    presets [name]
    convert [inputs...] -p --crf --max-size -o --out-dir --overwrite -- ffmpeg args
  }
  class CliContext {
    <<interface>>
    signal?: AbortSignal
    version?: string
    stdout?: Output
    stderr?: Output
  }
  class Output {
    <<interface>>
    write(text: string) unknown
    isTTY?: boolean
  }
  class EngineConfig {
    <<core>>
  }
  class Engine {
    <<core>>
  }

  main_ts ..> index_ts : run()
  index_ts *-- Commands
  index_ts --> CliContext
  EngineConfig <|-- CliContext
  CliContext --> Output
  index_ts ..> Engine : createEngine(ctx)
```

## 5. web demo: classes

```mermaid
classDiagram
  direction LR

  class Backend {
    <<interface>>
    presets() Promise~Preset[]~
    convert(file, presetId, events: ConvertEvents, signal) Promise~blob, filename~
  }
  class CreateBackend {
    <<type>>
    call(baseUrl, apiKey?) Backend
  }
  class ConvertEvents {
    <<interface>>
    progress(phase: Phase, fraction?) void
    log(entry: LogEntry) void
  }
  class Preset {
    <<interface>>
    id: string
    label: string
    description: string
  }
  class LogEntry {
    <<interface>>
    label: string
    status?: number or string
    ms?: number
    data?: unknown
  }
  class Phase {
    <<enumeration>>
    uploading
    queued
    converting
    downloading
  }
  class ErrorKind {
    <<enumeration>>
    too_large
    busy
    unsupported
    rejected
    failed
    expired
    unreachable
    unauthorized
  }
  class BackendError {
    kind: ErrorKind
  }
  Error <|-- BackendError
  BackendError --> ErrorKind

  class adapter["adapters/vd-oprezer.ts"] {
    createBackend: CreateBackend
    kindFor(status, code?) ErrorKind
    -request(path, init, events?) Response
    -upload(file, presetId, events, signal) Job (XHR)
    -watch(id, events, signal) Job (SSE via fetch, reconnects 30 s)
    -download(job, events, signal) Blob
    -remove(id, events) (DELETE, keepalive)
    -messages(body) event, data stream
  }
  adapter ..|> CreateBackend
  CreateBackend ..> Backend : returns
  adapter ..> BackendError : throws

  class State {
    <<interface>>
    backendUrl: string
    apiKey: string
    expert: boolean
    presets: Preset[] or loading or error
    file?: File
    presetId?: string
    status: Status
    log: LogLine[]
  }
  class Status {
    <<union>>
    idle / ready
    Phase + fraction?
    done: url, filename, outputBytes
    failed: kind, message
  }
  class LogLine {
    <<interface>>
    at: number
  }
  class Action {
    <<union>>
    presetsLoaded, presetsFailed
    fileChosen, presetChosen
    started, progress, finished, failed, cancelled
    tryAgain, another
    log, expertToggled, urlChanged
  }
  class app_ts["app.ts"] {
    <<pure>>
    initialState(backendUrl, expert, apiKey) State
    reduce(state, action) State
    shouldLoadPresets(before, after) boolean
    isRunning(status) boolean
    summary(inputBytes, outputBytes) string
    messageFor(kind, message, maxUploadMb?) string
    formatMb(bytes) string
  }
  LogEntry <|-- LogLine
  State *-- Status
  State *-- LogLine
  State --> Preset
  app_ts ..> State
  app_ts ..> Action

  class Handlers {
    <<interface>>
    file(file)
    preset(id)
    convert()
    cancel()
    tryAgain()
    another()
    expert()
    url(value, key)
    resetUrl()
    videoInfo(width, height, durationS)
  }
  class view_ts["view.ts"] {
    mountView(doc, handlers, opts) render(state)
  }
  view_ts --> Handlers
  view_ts ..> app_ts

  class main_ts["main.ts"] {
    <<composition root>>
    state: State
    backend: Backend
    controller?: AbortController
    objectUrl?: string
    dispatch(action)
    loadPresets()
    convert()
    storage: localStorage url, key, expert
  }
  main_ts ..> adapter : createBackend
  main_ts --> Backend
  main_ts ..> app_ts : reduce
  main_ts ..> view_ts : mountView
  main_ts ..|> Handlers : implements
```

## 6. Sequence: CLI convert

`vd-oprezer convert clip.mov -p web -- '-c:v' libx264`

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant Main as cli/main.ts
  participant Run as cli/index.ts run()
  participant Presets as core presets
  participant Engine as core Engine
  participant Runner as spawnRunner
  participant FF as ffprobe / ffmpeg

  User->>Main: argv
  Main->>Run: run(argv, {signal, version, ffmpegPath, ffprobePath})
  Run->>Run: split argv at "--" (rest goes to FFmpeg)
  Run->>Presets: parseEncodeOptions({preset, crf, maxSize})
  Presets-->>Run: EncodeOptions (or INVALID_ARGUMENT, exit 2)
  loop each input
    Run->>Engine: transcode({input, output, args: info => buildArgs + ffArgs, signal, onProgress})
    Engine->>Engine: check input != output, output not existing
    Engine->>Runner: ffprobe -print_format json ...
    Runner->>FF: spawn
    FF-->>Runner: JSON
    Runner-->>Engine: RunResult
    Engine->>Engine: parseProbeOutput → MediaInfo, args(info)
    Engine->>Runner: ffmpeg ... -progress pipe:1 .name.id.partial.mp4
    Runner->>FF: spawn
    loop progress blocks
      FF-->>Runner: key=value lines
      Runner-->>Engine: onStdoutLine
      Engine-->>Run: onProgress(Progress)
      Run-->>User: "\r 42% 2.01x eta 8s" (TTY only)
    end
    FF-->>Runner: exit 0
    Engine->>Engine: rename partial → output, stat
    Engine-->>Run: TranscodeResult
    Run-->>User: "✓ out.mp4: 12.1 MB (25% of input) in 4.2s"
  end
  Run-->>Main: exit code 0/1
  opt Ctrl+C
    User->>Main: SIGINT
    Main->>Main: controller.abort()
    Runner->>FF: SIGKILL
    Engine->>Engine: delete partial
    Run-->>Main: 130
  end
```

## 7. Sequence: async job from the web demo

```mermaid
sequenceDiagram
  autonumber
  actor Visitor
  participant Main as web main.ts
  participant Adapter as adapters/vd-oprezer.ts
  participant App as server createApp
  participant Jobs as server Jobs
  participant Limiter as server Limiter
  participant Engine as core Engine

  Visitor->>Main: choose file + preset, Convert
  Main->>Adapter: convert(file, presetId, events, signal)
  Adapter->>App: POST /jobs (multipart, XHR, Bearer key)
  App->>App: onRequest: CORS, auth, then assertRoom()
  App->>App: receive(): stream upload, parseEncodeOptions
  App->>Jobs: submit({id, options, filename})
  Jobs->>Limiter: run(encode, jobSignal)
  App-->>Adapter: 202 Job {status: queued}
  Adapter->>App: GET /jobs/:id/events (fetch, SSE)
  App->>Jobs: subscribe(id, listener)
  App-->>Adapter: event: job (queued)
  Limiter->>Engine: transcode({upload, output, buildArgs, onProgress})
  Jobs-->>App: listener(job running, n%)
  App-->>Adapter: event: job (running n%)
  Adapter-->>Main: progress("converting", n/100)
  Engine-->>Jobs: TranscodeResult
  Jobs->>Jobs: status done, outputDimensions, start TTL, delete upload
  Jobs-->>App: listener(job done)
  App-->>Adapter: event: job (done), stream ends
  Adapter->>App: GET /jobs/:id/output
  App-->>Adapter: video/mp4 stream
  Adapter->>App: DELETE /jobs/:id (keepalive, best effort)
  App->>Jobs: remove(id)
  Adapter-->>Main: {blob, filename}
  Main-->>Visitor: preview, size summary, download link
  opt Cancel
    Visitor->>Main: Cancel
    Main->>Adapter: signal.abort()
    Adapter->>App: DELETE /jobs/:id
    Jobs->>Engine: controller.abort() → FFmpeg SIGKILL
  end
```

## 8. Sequence: POST /convert and POST /probe

```mermaid
sequenceDiagram
  autonumber
  participant Client
  participant App as server createApp
  participant Limiter
  participant Engine as core Engine

  Client->>App: POST /convert (multipart file, preset, crf, maxSize)
  App->>App: assertRoom(), mkdtemp convert/c-*
  App->>App: receive(): upload + parseEncodeOptions
  App->>Limiter: run(transcode, signal: shutdown + client close)
  Limiter->>Engine: transcode(...)
  Engine-->>App: TranscodeResult
  App->>App: outputDimensions(options, result.input)
  App-->>Client: 200 video/mp4 + X-Output-Width/Height/Duration-Ms
  App->>App: on response close: delete temp dir

  Client->>App: POST /probe (multipart file)
  App->>App: mkdtemp convert/p-*, receive()
  App->>Engine: probe(upload) (not queued)
  alt video stream and not an image format
    App-->>Client: 200 {formatName, width, height, durationMs}
  else image / no video
    App-->>Client: 422 NOT_A_VIDEO
  else ffprobe failed
    App-->>Client: 422 PROBE_FAILED
  end
  App->>App: delete temp dir
```

## 9. States: server job

```mermaid
stateDiagram-v2
  [*] --> queued : POST /jobs → submit()
  queued --> running : limiter slot free
  running --> done : transcode resolved
  running --> failed : VdError / other error
  queued --> failed : error before encode
  done --> [*] : TTL expired or DELETE
  failed --> [*] : TTL expired or DELETE
  queued --> [*] : DELETE or shutdown (aborted)
  running --> [*] : DELETE or shutdown (aborted, FFmpeg killed)
```

## 10. States: web demo

`Status` in `web/src/app.ts`, driven by `reduce(state, action)`.

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> ready : file and preset chosen
  ready --> idle : another (file cleared)
  ready --> uploading : started
  ready --> failed : over VITE_MAX_UPLOAD_MB
  state running {
    uploading --> queued : progress
    queued --> converting : progress
    converting --> downloading : progress
  }
  running --> done : finished
  running --> failed : failed (BackendError kind)
  running --> ready : cancelled
  done --> ready : another / new file
  failed --> ready : tryAgain
```

## 11. Deployment: Docker image

```mermaid
flowchart TB
  subgraph build["docker build (multi-stage)"]
    ffStage["ffmpeg stage<br/>(Alpine, static FFmpeg,<br/>--disable-everything + enabled list)"]
    buildStage["build stage<br/>(Node, npm ci, npm run bundle<br/>→ dist-bundle/)"]
    testStage["test stage<br/>(npm run check on Linux<br/>with the image's FFmpeg)"]
    nodeStage["node stage<br/>(node binary)"]
    buildStage --> testStage
  end

  subgraph image["runtime image (Alpine)"]
    entry["vd-oprezer<br/>(docker/entrypoint.sh)"]
    srv["node dist/server/main.js<br/>HOST=0.0.0.0 PORT=3000<br/>WORK_DIR=/tmp/vd"]
    cliBin["node dist/cli/main.js"]
    ffBins[("ffmpeg / ffprobe")]
    entry -- "serve (default CMD)" --> srv
    entry -- "anything else" --> cliBin
    srv --> ffBins
    cliBin --> ffBins
  end

  ffStage --> ffBins
  buildStage --> srv
  buildStage --> cliBin
  nodeStage --> image

  health["HEALTHCHECK<br/>wget /health"] --> srv
  pages["GitHub Pages<br/>web demo (web.yml)"] -- "HTTPS + CORS_ORIGINS, AUTH_KEY" --> srv
  ghcr["ghcr.io/elx3020/vd_oprezer<br/>(cd.yml on v* tags)"] -.-> image
```

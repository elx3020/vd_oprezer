# vd-oprezer web demo

A one-page demo of a video-conversion API: pick a video and a preset, watch
it upload and convert, compare sizes, preview and download the result.
**Expert mode** shows the technical trail (every request, every job event,
timings, the raw JSON) and lets you point the page at another server.

It is its own npm package: vanilla TypeScript + Vite, no runtime
dependencies, and it imports nothing from the rest of the repo. It talks to
backends only over HTTP, through an adapter. Design and reasoning:
[`docs/DECISIONS.md`](../docs/DECISIONS.md), decision 11.

## Run it against a local server

The server needs to allow the page's origin (CORS is off by default).

Bash:

```bash
# repo root
CORS_ORIGINS=http://localhost:5173 npm run dev:server
# web/
npm install
npm run dev            # http://localhost:5173
```

PowerShell:

```powershell
# repo root
$env:CORS_ORIGINS='http://localhost:5173'; npm run dev:server
# web/
npm install
npm run dev
```

The page uses `http://localhost:3000` unless `VITE_BACKEND_URL` says
otherwise. You can also change the URL in expert mode, and the browser
remembers it.

```
npm run check          # typecheck + tests + build (must pass)
npm test               # node:test via tsx
npm run build          # → dist/, static files for any host
```

## Build settings

Read at build time (Vite env):

| Variable | Meaning |
|---|---|
| `VITE_BACKEND_URL` | Default backend URL. Default: `http://localhost:3000` |
| `VITE_MAX_UPLOAD_MB` | Optional. The backend's upload limit: the page shows it and refuses bigger files before uploading |

## Connecting another backend

The UI only knows the contract in [`src/backend.ts`](src/backend.ts):
`presets()` and one `convert(file, presetId, events, signal)` call that
reports progress and log lines, and resolves with the converted video. It
also defines the `BackendError` kinds the UI turns into plain sentences.

1. Write `src/adapters/<name>.ts` exporting a `CreateBackend` (see
   [`vd-oprezer.ts`](src/adapters/vd-oprezer.ts) for a job + SSE API).
2. Test it next to it against fakes of the browser APIs it uses
   (see `vd-oprezer.test.ts`).
3. Change the one adapter import in [`src/main.ts`](src/main.ts).

Nothing else changes.

## Deploying to GitHub Pages

`.github/workflows/web.yml` checks pull requests that touch `web/` and
deploys on pushes to `main`. One-time setup:

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → Variables:**
   `DEMO_BACKEND_URL` (your demo server, `https://...`) and, optionally,
   `DEMO_MAX_UPLOAD_MB`. Then re-run the workflow (or use "Run workflow").
3. On the demo server, set `CORS_ORIGINS=https://<user>.github.io`, an
   origin with no path, even though the site lives under `/vd_oprezer/`.
   Serve it over **https**: browsers block calls from an https page to a
   plain-http remote server.

Suggested limits for a public demo server (anyone can upload; there is no
auth): `MAX_UPLOAD_MB=100`, `MAX_QUEUED=5`, `JOB_TTL_MIN=15`, `CONCURRENCY=1`.
Set `DEMO_MAX_UPLOAD_MB` to the same value as `MAX_UPLOAD_MB`.

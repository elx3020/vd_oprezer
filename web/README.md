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

The server needs to allow the page's origin (CORS is off by default), and
the page needs the server's key if it has one. A gitignored `.env.local` at
the repo root covers both. From the repo root (Bash or PowerShell):

```
cp .env.example .env.local # once, then set AUTH_KEY to a random string
npm --prefix web install   # once
npm run dev:server         # loads .env.local
npm run dev:web            # http://localhost:5173; vite dev reads AUTH_KEY from the same file
```

`npm run dev:web -- --port 5180` passes options to Vite. The page uses
`http://localhost:3000` unless `VITE_BACKEND_URL` says otherwise. Expert
mode lets you change the URL and the API key; the browser remembers both
(the key in `localStorage`, in plain text), and **Reset** goes back to the
defaults.

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

There is deliberately no build setting for the API key: anything in a static
build is public. Only `vite dev` fills in a default key (`AUTH_KEY` from the
repo root's `.env.local`, see `vite.config.ts`); builds start with none.

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

Suggested limits for a public demo server (leave `AUTH_KEY` unset so
visitors can use it; anyone can then upload): `MAX_UPLOAD_MB=100`, `MAX_QUEUED=5`, `JOB_TTL_MIN=15`, `CONCURRENCY=1`.
Set `DEMO_MAX_UPLOAD_MB` to the same value as `MAX_UPLOAD_MB`.

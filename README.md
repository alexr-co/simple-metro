# Simple Metro

A fast, real-time arrivals board for the Washington DC Metro.
**Live:** https://metro.alexr-co.com

## What it does
- Real-time train predictions, service incidents, and the full station list for the
  WMATA Metrorail system.
- Clean per-station URLs (e.g. `/stations/dca`, `/stations/dupont-circle`) with short
  aliases for airports and well-known stops.

## Architecture
Two deployables behind a single domain, joined at Cloudflare's edge:

- **Frontend** (`frontend/`) — React 19 + TypeScript + Vite SPA, deployed to
  **Firebase Hosting**.
- **API proxy** (`worker/`) — a **Cloudflare Worker** (TypeScript) that proxies the
  WMATA API. A **Durable Object** (`WmataCache`, pinned to the US East coast) holds a
  single globally strongly-consistent snapshot, pre-warmed by cron triggers:
  predictions (~every 20s via in-handler fan-out), incidents (every 5 min), and the
  station list (daily). One upstream call serves every user, so WMATA load stays tiny
  and constant (~4,600 calls/day) regardless of traffic.
- **Edge routing** — Cloudflare intercepts `metro.alexr-co.com/api/*` and dispatches to
  the Worker; all other paths fall through to the Firebase-hosted SPA.

Endpoints: `/api/wmata/stations`, `/api/wmata/incidents`,
`/api/wmata/predictions/:codes`.

## Local development
```bash
npm install                 # root tooling (firebase-tools)
npm --prefix frontend install
npm --prefix worker install

npm run dev:frontend        # Vite dev server
npm run dev:worker          # wrangler dev (Cloudflare Worker)
```

The Worker needs a WMATA API key as a secret (never committed):
```bash
cd worker && npx wrangler secret put WMATA_KEY
```

## Deploy
```bash
npm run deploy              # frontend (Firebase) + worker (Cloudflare)
```

## Tech
React 19 · TypeScript · Vite · Cloudflare Workers + Durable Objects · Firebase Hosting · WMATA API

# Simple Metro

A fast, real-time arrivals board for the Washington DC Metro.
**Live:** https://metro.alexr-co.com

## What it does
- Real-time train predictions for every WMATA Metrorail platform — up to 5 upcoming
  trains per direction with real predicted arrival times and car counts — plus service
  incidents and the full station list.
- Clean per-station URLs (e.g. `/stations/dca`, `/stations/dupont-circle`) with short
  aliases for airports and well-known stops.

## Architecture
Two deployables behind a single domain, joined at Cloudflare's edge:

- **Frontend** (`frontend/`) — React 19 + TypeScript + Vite SPA, deployed to
  **Firebase Hosting**.
- **API proxy** (`worker/`) — a **Cloudflare Worker** (TypeScript) that fetches from
  WMATA and serves a small, normalized JSON API. A **Durable Object** (`WmataCache`,
  pinned to the US East coast) holds a single globally strongly-consistent snapshot,
  pre-warmed by cron triggers: predictions (~every 20s via in-handler fan-out), incidents
  (every 5 min), and the station list (daily). One upstream fetch serves every user, so
  WMATA load stays small and constant (~9,000 calls/day, well under WMATA's 50k/day limit)
  regardless of traffic.
- **Edge routing** — Cloudflare intercepts `metro.alexr-co.com/api/*` and dispatches to
  the Worker; all other paths fall through to the Firebase-hosted SPA.

Endpoints: `/api/wmata/stations`, `/api/wmata/incidents`,
`/api/wmata/predictions/:codes`.

### Data sources
Predictions come from WMATA's **GTFS-Realtime** feeds — a public, binary (protobuf)
transit-data standard — instead of the legacy JSON prediction endpoint, which only
reports the nearest ~3 trains per platform:

- **TripUpdates** (`rail-gtfsrt-tripupdates.pb`) — real predicted arrival times for every
  upcoming train at every remaining stop (the same source wmata.com uses). This is the
  arrivals board, extended to ~45 minutes out.
- **VehiclePositions** (`rail-gtfsrt-vehiclepositions.pb`) — supplies each train's car
  count (6 or 8), joined onto its predictions by `trip_id`.

The Worker decodes both feeds with a small, **dependency-free protobuf reader** in
`worker/src/index.ts` that reads only the handful of fields we need — no `.proto` schema
compiler and no `protobufjs` dependency. If the GTFS-RT feed is ever unavailable, the
Worker falls back to WMATA's legacy `GetPrediction` JSON endpoint (nearest ~3 trains) so
the board never goes blank.

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
React 19 · TypeScript · Vite · Cloudflare Workers + Durable Objects · Firebase Hosting ·
WMATA GTFS-Realtime (protobuf)

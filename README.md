# Simple Metro

A fast, real-time arrivals board for the Washington DC Metro.
**Live:** https://metro.alexr-co.com

## What it does
- Real-time train predictions for every WMATA Metrorail platform — up to 5 upcoming
  trains per direction with real predicted arrival times and car counts — plus service
  incidents and the full station list.
- A per-station **Info tab**: whether the station is open now, first/last trains today,
  street address with a maps link, live elevator/escalator outages, and service alerts.
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
  and elevator/escalator status (every 5 min), and the station list plus first/last-train
  schedules (daily). One upstream fetch serves every user, so WMATA load stays small and
  constant (~9,000 calls/day, well under WMATA's 50k/day limit) regardless of traffic.
- **Edge routing** — Cloudflare intercepts `metro.alexr-co.com/api/*` and dispatches to
  the Worker; all other paths fall through to the Firebase-hosted SPA.

Endpoints: `/api/wmata/stations`, `/api/wmata/incidents`,
`/api/wmata/predictions/:codes`, `/api/wmata/station-times/:codes`,
`/api/wmata/elevator/:codes`.

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

The **Info tab** draws on the classic JSON endpoints, cached in the same Durable Object:
station address and coordinates come free from the daily `jStations` fetch; first/last
trains from a single daily `jStationTimes` call; and elevator/escalator outages from
`ElevatorIncidents`, refreshed every 5 minutes.

## Local development
```bash
npm install                 # root tooling (firebase-tools)
npm --prefix frontend install
npm --prefix worker install

npm run dev:frontend        # Vite dev server
npm run dev:worker          # wrangler dev (Cloudflare Worker)
```

In dev, Vite proxies `/api` to `wrangler dev` on :8787 (run both commands). For
local Worker data, put the WMATA key in `worker/.dev.vars` (gitignored):
`WMATA_KEY=…`. In production the key is a Cloudflare secret (never committed):
```bash
cd worker && npx wrangler secret put WMATA_KEY
```

`VITE_API_BASE` (build-time, optional): points the frontend at an absolute API
origin (e.g. the workers.dev URL) instead of same-origin `/api/wmata`. If it's
ever set to a cross-origin host, the CSP in `firebase.json` needs that host
added to `connect-src`.

Checks — the same ones CI runs before deploying:
```bash
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix worker run typecheck
npm --prefix worker run test      # vitest: protobuf reader, fuzzy matcher, validation
```

## Deploy
**Canonical path: push to `main`.** The `Deploy` GitHub Actions workflow runs
lint/typecheck/build/tests, then deploys the frontend to Firebase Hosting and
the Worker to Cloudflare. `npm run deploy` is the manual escape hatch — it does
the same two deploys from your machine using your local `firebase login` and
`wrangler login` credentials, but skips the checks.

Note on firebase-tools versions: CI pins `firebase-tools@13.35.1` because v14+
rejects the Workload Identity Federation ADC file ("Failed to authenticate…");
the root devDependency is v14, which is fine for manual deploys since those use
interactive login, not WIF.

### CI/CD configuration (GitHub repo settings)
The `Deploy` workflow needs:

| Kind | Name | Purpose |
|---|---|---|
| Variable | `WIF_PROVIDER` | Workload Identity Federation provider resource name (Firebase auth) |
| Variable | `WIF_SERVICE_ACCOUNT` | Service account email the WIF provider impersonates |
| Secret | `CLOUDFLARE_API_TOKEN` | API token with Workers deploy permission |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id |

The Worker's `WMATA_KEY` secret lives in Cloudflare (set once via
`wrangler secret put`) and persists across deploys — CI never touches it.
Actions in the workflows are pinned to commit SHAs; bump the SHA and the
version comment together when updating.

## Tech
React 19 · TypeScript · Vite · Cloudflare Workers + Durable Objects · Firebase Hosting ·
WMATA GTFS-Realtime (protobuf)

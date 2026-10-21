/* Client for the WMATA proxy on Cloudflare Workers.
   No API key in the browser; the proxy holds it server-side.

   Base URL resolution:
     - If VITE_API_BASE is set at build time, use it (absolute URL, e.g. the
       workers.dev URL during the cross-origin window before the Cloudflare
       route on metro.alexr-co.com is bound).
     - Otherwise '/api/wmata' — same-origin, served via the Worker route
       once Phase 4 is in place. In dev, Vite proxies /api → wrangler dev. */

import type {
  Station, Train, Incident, LineCode, StationTimes, ElevatorOutage,
} from './metro-data';

const BASE = import.meta.env.VITE_API_BASE
  ? `${String(import.meta.env.VITE_API_BASE).replace(/\/+$/, '')}/api/wmata`
  : '/api/wmata';

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${BASE}/${path}`, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
  return r.json() as Promise<T>;
}

export function getStations(signal?: AbortSignal): Promise<Station[]> {
  return getJson<Station[]>('stations', signal);
}

// Everything the arrivals board polls for, in one request. generatedAt (epoch
// ms) is when the proxy built the predictions snapshot — the rows' `min`
// values are baked in at that moment, so it's the honest "updated" time.
// nextInMs is how long until the proxy's next snapshot is due, so the caller
// can poll just after it lands.
export interface BoardResult {
  trains: Train[]; incidents: Incident[]; generatedAt: number; nextInMs: number;
}

export async function getBoard(codes: string[], signal?: AbortSignal): Promise<BoardResult> {
  const b = await getJson<{ trains: Train[]; incidents: Incident[]; ts: number; nextInMs: number }>(
    `board/${codes.join(',')}`, signal);
  return { trains: b.trains, incidents: b.incidents, generatedAt: b.ts, nextInMs: b.nextInMs };
}

export function getStationTimes(codes: string[], signal?: AbortSignal): Promise<StationTimes> {
  return getJson<StationTimes>(`station-times/${codes.join(',')}`, signal);
}

export function getElevator(codes: string[], signal?: AbortSignal): Promise<ElevatorOutage[]> {
  return getJson<ElevatorOutage[]>(`elevator/${codes.join(',')}`, signal);
}

// Re-export for convenience so consumers don't need to import from two places.
export type { Station, Train, Incident, LineCode, StationTimes, ElevatorOutage };

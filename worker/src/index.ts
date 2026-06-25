/* WMATA proxy on Cloudflare Workers.
 *
 * scheduled() — pre-warms the WmataCache Durable Object from WMATA on three
 *   cron schedules: predictions/All (every 20s via in-handler fan-out),
 *   incidents (every 5 min), stations (daily). One WMATA call serves every
 *   station, so upstream load is constant and tiny (~4,600/day) regardless
 *   of user count.
 *
 * fetch() — serves /api/wmata/{stations,incidents,predictions/:codes} by
 *   reading from the DO (strongly consistent globally — no per-POP 60s
 *   propagation lag like KV had). Predictions are filtered per request to
 *   the codes the caller asked for. If the DO is empty (just after first
 *   deploy), each route falls back to a direct WMATA fetch so users never
 *   see no data.
 */

import { DurableObject } from 'cloudflare:workers';

interface Env {
  WMATA_DO: DurableObjectNamespace<WmataCache>;
  WMATA_KEY: string;
}

// ── domain types (shape matches frontend/src/lib/metro-data.ts) ──────────────
type LineCode = 'RD' | 'OR' | 'SV' | 'BL' | 'YL' | 'GR';
const VALID_LINES: readonly LineCode[] = ['RD', 'OR', 'SV', 'BL', 'YL', 'GR'];
const isValidLine = (s: unknown): s is LineCode =>
  typeof s === 'string' && (VALID_LINES as readonly string[]).includes(s);

interface Station { name: string; codes: string[]; lines: LineCode[] }
interface Train {
  line: LineCode | null;
  dest: string;          // canonical full name resolved from destCode (e.g. "New Carrollton")
  destCode: string | null;  // station code, kept for downstream lookups
  cars: string | null;
  min: string;
  group: string;
  loc: string;
}
interface Incident { lines: LineCode[]; type: string; text: string }

// ── Durable Object: the single source of truth for the cached snapshot. ─────
// One global instance (named "global"), pinned to East-Coast North America
// because users + WMATA's infrastructure both live there. Reads are strongly
// consistent across every Cloudflare POP — no eventual consistency window.
export class WmataCache extends DurableObject<Env> {
  async getPredictions(): Promise<Train[] | undefined> {
    return this.ctx.storage.get<Train[]>('predictions:all');
  }
  async putPredictions(trains: Train[]): Promise<void> {
    await this.ctx.storage.put('predictions:all', trains);
  }
  async getIncidents(): Promise<Incident[] | undefined> {
    return this.ctx.storage.get<Incident[]>('incidents');
  }
  async putIncidents(incidents: Incident[]): Promise<void> {
    await this.ctx.storage.put('incidents', incidents);
  }
  async getStations(): Promise<Station[] | undefined> {
    return this.ctx.storage.get<Station[]>('stations');
  }
  async putStations(stations: Station[]): Promise<void> {
    await this.ctx.storage.put('stations', stations);
  }
}

function cache(env: Env): DurableObjectStub<WmataCache> {
  return env.WMATA_DO.get(env.WMATA_DO.idFromName('global'), { locationHint: 'enam' });
}

// ── WMATA upstream ───────────────────────────────────────────────────────────
const WMATA_BASE = 'https://api.wmata.com';

async function wmataGet<T>(path: string, key: string): Promise<T> {
  const r = await fetch(`${WMATA_BASE}/${path}`, {
    headers: { api_key: key, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`WMATA ${r.status} ${r.statusText} for ${path}`);
  return r.json() as Promise<T>;
}

// ── adapters: raw WMATA → frontend-facing shape ──────────────────────────────
interface RawStation {
  Code: string; Name: string;
  LineCode1: string | null; LineCode2: string | null;
  LineCode3: string | null; LineCode4: string | null;
}

// Canonical display-name overrides, keyed by station code so they're stable
// against WMATA renames. Applied during adaptStations so the override flows
// into every downstream consumer: picker dropdown, destination column,
// codeToName lookups, fuzzy index.
const NAME_OVERRIDES_BY_CODE: Record<string, string> = {
  E01: 'Mt Vernon Sq',                  // was: "Mt Vernon Sq-7th St"
  C10: 'Reagan National Airport',       // was: "Ronald Reagan Washington National Airport"
};

function adaptStations(raw: RawStation[]): Station[] {
  const byName = new Map<string, Station>();
  for (const st of raw) {
    const name = NAME_OVERRIDES_BY_CODE[st.Code] ?? st.Name;
    const lines = [st.LineCode1, st.LineCode2, st.LineCode3, st.LineCode4].filter(isValidLine);
    if (!byName.has(name)) byName.set(name, { name, codes: [], lines: [] });
    const rec = byName.get(name)!;
    if (!rec.codes.includes(st.Code)) rec.codes.push(st.Code);
    for (const l of lines) if (!rec.lines.includes(l)) rec.lines.push(l);
  }
  return [...byName.values()]
    .filter((s) => s.lines.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface RawTrain {
  Line: string;
  DestinationName?: string; Destination?: string; DestinationCode?: string;
  Car?: string; Min?: string; Group?: string; LocationCode?: string;
}
// dest here is the raw WMATA value — possibly abbreviated ("New Crlton"). The
// canonical full name gets swapped in inside refreshPredictions() once the
// stations map is available.
function adaptPredictions(raw: RawTrain[]): Train[] {
  return raw
    .map((t) => ({
      line: isValidLine(t.Line) ? t.Line : null,
      dest: t.DestinationName || t.Destination || '—',
      destCode: t.DestinationCode || null,
      cars: t.Car && t.Car !== '-' ? t.Car : null,
      min: t.Min || '—',
      group: t.Group || '1',
      loc: t.LocationCode || '',
    }))
    .filter((t) => t.dest && t.dest !== 'No Passenger' && t.dest !== 'Train');
}

interface RawIncident { LinesAffected?: string; IncidentType?: string; Description?: string }
function adaptIncidents(raw: RawIncident[]): Incident[] {
  return raw.map((i) => ({
    lines: String(i.LinesAffected ?? '').split(';').map((s) => s.trim()).filter(isValidLine),
    type: i.IncidentType ?? 'Advisory',
    text: i.Description ?? '',
  }));
}

// ── fetch + store routines (called by both scheduled and cold-DO fallback) ──
async function fetchAllPredictions(env: Env): Promise<Train[]> {
  const data = await wmataGet<{ Trains?: RawTrain[] }>(
    'StationPrediction.svc/json/GetPrediction/All', env.WMATA_KEY);
  return adaptPredictions(data.Trains ?? []);
}
async function fetchIncidents(env: Env): Promise<Incident[]> {
  const data = await wmataGet<{ Incidents?: RawIncident[] }>(
    'Incidents.svc/json/Incidents', env.WMATA_KEY);
  return adaptIncidents(data.Incidents ?? []);
}
async function fetchStations(env: Env): Promise<Station[]> {
  const data = await wmataGet<{ Stations?: RawStation[] }>(
    'Rail.svc/json/jStations', env.WMATA_KEY);
  return adaptStations(data.Stations ?? []);
}

// Fallback when WMATA returns a train with a blank DestinationCode (typical
// for short-turn / terminating trains). Keys are abbreviated dest strings
// WMATA puts on platform signs; values are the canonical full names that
// match the station picker. Lookup below is case-insensitive so ALL-CAPS
// variants like "REAGAN AIRPORT" match the title-cased entry. Extend this
// map when "unmapped destination" warnings show up in Worker logs for a
// previously-unseen short name.
const ABBREV_TO_NAME: Record<string, string> = {
  'New Crlton': 'New Carrollton',
  'NewCrlton': 'New Carrollton',
  'Pent City': 'Pentagon City',
  'Pent Cty': 'Pentagon City',
  'Pntgn City': 'Pentagon City',
  'Pntgn Cty': 'Pentagon City',
  'Vienna': 'Vienna/Fairfax-GMU',
  'Frnconia': 'Franconia-Springfield',
  'Franconia': 'Franconia-Springfield',
  'Hntngton': 'Huntington',
  "L'Enfant": "L'Enfant Plaza",
  'NY Av-Gldt U': 'NoMa-Gallaudet U',
  'NoMa-Gldt U': 'NoMa-Gallaudet U',
  'Foggy Bttm': 'Foggy Bottom-GWU',
  'Glnmt': 'Glenmont',
  'Mt Vrn Sq': 'Mt Vernon Sq',
  'Mt Vrn Sq-7th': 'Mt Vernon Sq',
  'Largo': 'Downtown Largo',
  'Dwn Largo': 'Downtown Largo',
  'Branch Av': 'Branch Ave',
  'Shady Grv': 'Shady Grove',
  'Shdy Grv': 'Shady Grove',
  'Wiehle': 'Wiehle-Reston East',
  'Reagan Natl': 'Reagan National Airport',
  'Reagan Air': 'Reagan National Airport',
  'Reagan Airport': 'Reagan National Airport',
  'Reagan Airpt': 'Reagan National Airport',
  'Natl Airport': 'Reagan National Airport',
  'Natl Airpt': 'Reagan National Airport',
  'RR Reagan': 'Reagan National Airport',
  'King St-OT': 'King St-Old Town',
  'Stdm-Armry': 'Stadium-Armory',
  'Stdm Armry': 'Stadium-Armory',
};
// Pre-built lowercase index for case-insensitive lookup.
const ABBREV_LOOKUP: Record<string, string> = Object.fromEntries(
  Object.entries(ABBREV_TO_NAME).map(([k, v]) => [k.toLowerCase(), v]),
);

// ── Fuzzy fallback ──────────────────────────────────────────────────────────
// Catches WMATA short names not in the static map. Scores the candidate
// against every canonical station name using:
//   • exact token match           (+4)   "reagan" == "reagan"
//   • token prefix (≥3 chars)     (+2)   "air" prefix of "airport"
//   • drop-vowels exact (≥2 chars)(+4)   "pntgn" == "pntgn" (Pentagon)
//   • drop-vowels prefix (≥3)     (+1)   "pntg" prefix of "pntgn"
// A match requires best ≥ 4 and at least 2 points clear of the runner-up,
// so single-token weak signals can't false-positive across multiple stations.
interface StationFuzzy { name: string; tokens: string[]; noVowels: string[] }

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}
function stripVowels(s: string): string {
  return s.replace(/[aeiou]/g, '');
}
function buildFuzzyIndex(stations: Station[]): StationFuzzy[] {
  return stations.map((s) => {
    const tokens = tokenize(s.name);
    return { name: s.name, tokens, noVowels: tokens.map(stripVowels) };
  });
}
function scoreAgainst(candTokens: string[], candNoVowels: string[], st: StationFuzzy): number {
  let score = 0;
  for (let i = 0; i < candTokens.length; i++) {
    const ct = candTokens[i], ctNV = candNoVowels[i];
    for (let j = 0; j < st.tokens.length; j++) {
      const t = st.tokens[j], tNV = st.noVowels[j];
      if (ct === t) score += 4;
      // Token prefix down to a single character — short initial-letter
      // abbreviations like "W Falls Ch" still need to score "w" against "west"
      // to break ties against stations that share only the longer tokens.
      else if (t.startsWith(ct)) score += 2;
      else if (ctNV.length >= 2 && ctNV === tNV) score += 4;
      else if (ctNV.length >= 3 && tNV.startsWith(ctNV)) score += 1;
    }
  }
  return score;
}
function fuzzyMatch(dest: string, index: StationFuzzy[]): string | undefined {
  const candTokens = tokenize(dest);
  if (candTokens.length === 0) return undefined;
  const candNoVowels = candTokens.map(stripVowels);
  let bestName: string | undefined;
  let best = 0, second = 0;
  for (const st of index) {
    const s = scoreAgainst(candTokens, candNoVowels, st);
    if (s > best) { second = best; best = s; bestName = st.name; }
    else if (s > second) { second = s; }
  }
  return (best >= 4 && best - second >= 2) ? bestName : undefined;
}

async function refreshPredictions(env: Env): Promise<Train[]> {
  const c = cache(env);
  const trains = await fetchAllPredictions(env);

  // Build a destCode → canonical-name map + fuzzy index from the cached
  // stations list. If stations is cold, refresh it once on the way through.
  const codeToName = new Map<string, string>();
  let fuzzyIndex: StationFuzzy[] = [];
  try {
    const cached = await c.getStations();
    const stations = (cached && cached.length > 0) ? cached : await refreshStations(env);
    for (const s of stations) {
      for (const code of s.codes) codeToName.set(code, s.name);
    }
    fuzzyIndex = buildFuzzyIndex(stations);
  } catch (e) {
    console.warn('stations unavailable for prediction enrichment; keeping raw dest', e);
  }

  // Memoize fuzzy lookups within this refresh — the same short name typically
  // appears across many trains in one batch.
  const fuzzyMemo = new Map<string, string | undefined>();
  const fuzzy = (dest: string): string | undefined => {
    if (fuzzyIndex.length === 0) return undefined;
    if (fuzzyMemo.has(dest)) return fuzzyMemo.get(dest);
    const result = fuzzyMatch(dest, fuzzyIndex);
    fuzzyMemo.set(dest, result);
    return result;
  };

  // Resolution priority:
  //   1. destCode lookup against the canonical station list (most precise)
  //   2. hardcoded short→long map (deterministic, fast)
  //   3. fuzzy token+vowel-drop match against canonical station names (catches
  //      WMATA abbreviation variants we haven't explicitly mapped)
  //   4. raw WMATA `dest` (last resort — logged so we can extend the map)
  const enriched: Train[] = trains.map((t) => {
    const fromCode = t.destCode ? codeToName.get(t.destCode) : undefined;
    const fromAbbrev = ABBREV_LOOKUP[t.dest.toLowerCase()];
    const fromFuzzy = (!fromCode && !fromAbbrev) ? fuzzy(t.dest) : undefined;
    if (!fromCode && !fromAbbrev && !fromFuzzy && !t.destCode) {
      console.warn('unmapped destination (fuzzy missed)', { dest: t.dest, line: t.line, loc: t.loc });
    }
    return { ...t, dest: fromCode || fromAbbrev || fromFuzzy || t.dest };
  });
  await c.putPredictions(enriched);
  return enriched;
}
async function refreshIncidents(env: Env): Promise<Incident[]> {
  const incidents = await fetchIncidents(env);
  await cache(env).putIncidents(incidents);
  return incidents;
}
async function refreshStations(env: Env): Promise<Station[]> {
  const stations = await fetchStations(env);
  await cache(env).putStations(stations);
  return stations;
}

// ── request validation ──────────────────────────────────────────────────────
// Codes path segment is `A01` or `A01,C01`. Accept up to 8 codes.
function parseCodes(seg: string): string[] | null {
  if (!/^[A-Z0-9]+(,[A-Z0-9]+){0,7}$/.test(seg)) return null;
  return seg.split(',');
}

// ── response helpers ────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, init: ResponseInit & { cacheControl?: string } = {}): Response {
  const { cacheControl, headers, ...rest } = init;
  return new Response(JSON.stringify(body), {
    ...rest,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
      ...CORS,
      ...headers,
    },
  });
}

// Edge cache windows — tightened for predictions since the DO is fresh and
// we want users to see WMATA updates as quickly as possible. The 5s window
// still absorbs hot-tab spam without hammering the DO.
const CC_PREDICTIONS = 'public, max-age=5, s-maxage=5, stale-while-revalidate=10';
const CC_INCIDENTS   = 'public, max-age=60, s-maxage=60, stale-while-revalidate=120';
const CC_STATIONS    = 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400';

// Strip prefix: the Worker should respond identically whether called via the
// metro.alexr-co.com/api/wmata/* route or its workers.dev URL at /wmata/*.
function subPath(rawPath: string): string {
  return rawPath.replace(/^\/+(api\/+)?/, '/').replace(/^\/wmata\/?/, '');
}

// ── handlers ────────────────────────────────────────────────────────────────
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Each cron pattern owns one refresh routine. waitUntil keeps the isolate
    // alive past the scheduled() return so the DO write actually completes.
    switch (controller.cron) {
      case '* * * * *': {
        // Cloudflare cron's minimum granularity is 1 min; for 20s polling we
        // fan out 3 fetches inside one minute via setTimeout. Total wallclock
        // ~40-46s (each fetch ~2s), leaving headroom before the next tick.
        const fanOut = async (): Promise<void> => {
          await refreshPredictions(env);
          await new Promise((r) => setTimeout(r, 20_000));
          await refreshPredictions(env);
          await new Promise((r) => setTimeout(r, 20_000));
          await refreshPredictions(env);
        };
        ctx.waitUntil(fanOut().catch((e) => console.error('predictions refresh failed', e)));
        return;
      }
      case '*/5 * * * *':
        ctx.waitUntil(refreshIncidents(env).then(() => undefined).catch((e) => console.error('incidents refresh failed', e)));
        return;
      case '17 6 * * *':
        ctx.waitUntil(refreshStations(env).then(() => undefined).catch((e) => console.error('stations refresh failed', e)));
        return;
      default:
        console.warn('unmatched cron', controller.cron);
    }
  },

  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json({ error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const url = new URL(req.url);
    const path = subPath(url.pathname);

    try {
      const c = cache(env);

      if (path === 'stations' || path === 'stations/') {
        const stations = (await c.getStations()) ?? (await refreshStations(env));
        return json(stations, { cacheControl: CC_STATIONS });
      }

      if (path === 'incidents' || path === 'incidents/') {
        const incidents = (await c.getIncidents()) ?? (await refreshIncidents(env));
        return json(incidents, { cacheControl: CC_INCIDENTS });
      }

      const predMatch = /^predictions\/([^/]+)\/?$/.exec(path);
      if (predMatch) {
        const codes = parseCodes(predMatch[1]);
        if (!codes) return json({ error: 'invalid_codes' }, { status: 400 });
        const all = (await c.getPredictions()) ?? (await refreshPredictions(env));
        const codeSet = new Set(codes);
        const subset = all.filter((t) => codeSet.has(t.loc));
        return json(subset, { cacheControl: CC_PREDICTIONS });
      }

      // Trivial liveness check, handy for uptime monitors.
      if (path === 'health' || path === '') {
        return json({ ok: true, ts: Date.now() }, { cacheControl: 'no-store' });
      }

      return json({ error: 'not_found', path }, { status: 404 });
    } catch (err) {
      console.error('handler failed', { path, err: String(err) });
      return json({ error: 'upstream_failed' }, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;

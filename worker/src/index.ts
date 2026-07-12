/* WMATA proxy on Cloudflare Workers.
 *
 * scheduled() — pre-warms the WmataCache Durable Object from WMATA on three
 *   cron schedules: predictions (every 20s via in-handler fan-out), incidents
 *   (every 5 min), stations (daily). Predictions come from WMATA's GTFS-Realtime
 *   TripUpdates feed — the same engine wmata.com uses — which gives real
 *   predicted arrival times for every upcoming train at every platform (not just
 *   the nearest ~3 like the legacy GetPrediction endpoint). GetPrediction is kept
 *   only as a fallback if the GTFS-RT feed is unavailable. One WMATA call of each
 *   kind serves every station, so upstream load is constant regardless of users.
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

interface StationAddress { street: string; city: string; state: string; zip: string }
interface Station {
  name: string; codes: string[]; lines: LineCode[];
  lat?: number; lon?: number; address?: StationAddress;
}
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

// Info-tab data. Both are near-static and cached in the DO (station times daily,
// elevator/escalator outages every 5 min alongside incidents).
type Weekday = 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday';
const WEEKDAYS: readonly Weekday[] =
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
interface SchedTrain { time: string; dest: string }   // dest = canonical station name
interface DaySched { open: string; first: SchedTrain[]; last: SchedTrain[] }
type WeekSched = Partial<Record<Weekday, DaySched>>;
type StationTimes = Record<string, WeekSched>;          // keyed by platform code
interface ElevatorOutage {
  station: string;                                       // platform code
  unit: 'ELEVATOR' | 'ESCALATOR';
  location: string;
  reason: string;
  returns: string | null;                               // ISO estimated return, if any
}

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
  async getStationTimes(): Promise<StationTimes | undefined> {
    return this.ctx.storage.get<StationTimes>('stationtimes');
  }
  async putStationTimes(times: StationTimes): Promise<void> {
    await this.ctx.storage.put('stationtimes', times);
  }
  async getElevator(): Promise<ElevatorOutage[] | undefined> {
    return this.ctx.storage.get<ElevatorOutage[]>('elevator');
  }
  async putElevator(outages: ElevatorOutage[]): Promise<void> {
    await this.ctx.storage.put('elevator', outages);
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
  Lat?: number; Lon?: number;
  Address?: { Street?: string; City?: string; State?: string; Zip?: string };
}

// Canonical display-name overrides, keyed by station code so they're stable
// against WMATA renames. Applied during adaptStations so the override flows
// into every downstream consumer: picker dropdown, destination column,
// codeToName lookups, fuzzy index.
const NAME_OVERRIDES_BY_CODE: Record<string, string> = {
  E01: 'Mt Vernon Sq',                  // was: "Mt Vernon Sq-7th St"
  C10: 'Reagan National Airport',       // was: "Ronald Reagan Washington National Airport"
  E03: 'U Street',                      // was: "U Street/African-Amer Civil War Memorial/Cardozo"
  N10: 'Dulles International Airport',  // was: "Washington Dulles International Airport"
};

// Re-apply the code-keyed overrides to an already-adapted station list.
// adaptStations applies them when it builds the snapshot, but the Durable Object
// snapshot is only rebuilt on the daily cron — so a newly deployed override
// wouldn't reach users for up to a day. Re-applying on the read path lets an
// override change take effect immediately against whatever snapshot is cached.
// Idempotent: on a fresh snapshot the names already match, so it's a no-op.
function applyNameOverrides(stations: Station[]): Station[] {
  return stations.map((s) => {
    const override = s.codes.map((code) => NAME_OVERRIDES_BY_CODE[code]).find(Boolean);
    return override && override !== s.name ? { ...s, name: override } : s;
  });
}

function adaptStations(raw: RawStation[]): Station[] {
  const byName = new Map<string, Station>();
  for (const st of raw) {
    const name = NAME_OVERRIDES_BY_CODE[st.Code] ?? st.Name;
    const lines = [st.LineCode1, st.LineCode2, st.LineCode3, st.LineCode4].filter(isValidLine);
    if (!byName.has(name)) byName.set(name, { name, codes: [], lines: [] });
    const rec = byName.get(name)!;
    if (!rec.codes.includes(st.Code)) rec.codes.push(st.Code);
    for (const l of lines) if (!rec.lines.includes(l)) rec.lines.push(l);
    // Location is identical across a transfer station's platforms; keep the
    // first non-empty. (Free — jStations already returns these fields.)
    if (rec.lat == null && typeof st.Lat === 'number' && st.Lat !== 0) {
      rec.lat = st.Lat; rec.lon = st.Lon;
    }
    if (!rec.address && st.Address?.Street) {
      rec.address = {
        street: st.Address.Street ?? '', city: st.Address.City ?? '',
        state: st.Address.State ?? '', zip: st.Address.Zip ?? '',
      };
    }
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
// canonical full name gets swapped in inside enrichPredictions() once the
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

// jStationTimes → per-code week schedule. Destination codes resolve to canonical
// names so the Info tab reads "to Shady Grove", not "to A15".
interface RawSchedTrain { Time?: string; DestinationStation?: string }
interface RawDaySched { OpeningTime?: string; FirstTrains?: RawSchedTrain[]; LastTrains?: RawSchedTrain[] }
type RawStationTime = { Code?: string; StationName?: string } & Partial<Record<Weekday, RawDaySched>>;

function adaptStationTimes(raw: RawStationTime[], codeToName: Map<string, string>): StationTimes {
  const mapTrains = (arr?: RawSchedTrain[]): SchedTrain[] =>
    (arr ?? []).filter((t) => t.Time).map((t) => ({
      time: t.Time!,
      dest: (t.DestinationStation && codeToName.get(t.DestinationStation)) || t.DestinationStation || '—',
    }));
  const mapDay = (d?: RawDaySched): DaySched | undefined =>
    d && d.OpeningTime ? { open: d.OpeningTime, first: mapTrains(d.FirstTrains), last: mapTrains(d.LastTrains) } : undefined;
  const out: StationTimes = {};
  for (const st of raw) {
    if (!st.Code) continue;
    const week: WeekSched = {};
    for (const day of WEEKDAYS) {
      const d = mapDay(st[day]);
      if (d) week[day] = d;
    }
    out[st.Code] = week;
  }
  return out;
}

// ElevatorIncidents → per-station outage list (accessibility).
interface RawElevator {
  UnitType?: string; StationCode?: string;
  LocationDescription?: string; SymptomDescription?: string; EstimatedReturnToService?: string;
}
function adaptElevator(raw: RawElevator[]): ElevatorOutage[] {
  return raw
    .filter((e) => e.StationCode && (e.UnitType === 'ELEVATOR' || e.UnitType === 'ESCALATOR'))
    .map((e) => ({
      station: e.StationCode!,
      unit: e.UnitType as 'ELEVATOR' | 'ESCALATOR',
      location: e.LocationDescription ?? '',
      reason: e.SymptomDescription ?? '',
      returns: e.EstimatedReturnToService || null,
    }));
}

// ── GTFS-Realtime TripUpdates: the primary prediction source ─────────────────
// WMATA publishes a protobuf feed of real-time trip predictions — for every
// active train, the predicted arrival time at each of its remaining stops. This
// is the same data wmata.com surfaces, and unlike the legacy GetPrediction
// endpoint (nearest ~3 trains per platform) it reaches ~45 min out. We decode it
// with a tiny hand-rolled protobuf reader (below) so the Worker stays
// dependency-free — we only need a handful of fields from the schema.
//
// GTFS-RT proto shape (fields we read):
//   FeedMessage { repeated FeedEntity entity = 2 }
//   FeedEntity  { TripUpdate trip_update = 3 }
//   TripUpdate  { TripDescriptor trip = 1; repeated StopTimeUpdate stop_time_update = 2 }
//   TripDescriptor  { string trip_id = 1; string route_id = 5; uint32 direction_id = 6 }
//   StopTimeUpdate  { StopTimeEvent arrival = 2; StopTimeEvent departure = 3; string stop_id = 4 }
//   StopTimeEvent   { int64 time = 2 }
//
// Car count comes from a companion feed, VehiclePositions, joined by trip_id:
//   FeedEntity      { VehiclePosition vehicle = 4 }
//   VehiclePosition { TripDescriptor trip = 1; VehicleDescriptor vehicle = 8 }
//   VehicleDescriptor { string license_plate = 3 }   // "8_7610-7611…" → 8 cars
// WMATA leaves the standard multi_carriage_details empty but encodes the consist
// size as the license_plate prefix (verified to always equal the actual car
// roster length). Only dispatched trains appear here, so far-future trips have
// no count yet — same reason WMATA can't show one either.

interface Cursor { buf: Uint8Array; pos: number }

// Base-128 varint. Uses float multiplication (not <<) for the high bytes so
// 64-bit values like Unix timestamps decode correctly past 2^32.
function readVarint(c: Cursor): number {
  let result = 0, shift = 0, byte: number;
  do {
    byte = c.buf[c.pos++] ?? 0;
    result += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (byte & 0x80);
  return result;
}
function readTag(c: Cursor): { field: number; wire: number } {
  const key = readVarint(c);
  return { field: Math.floor(key / 8), wire: key & 7 };
}
function readString(c: Cursor): string {
  const len = readVarint(c);
  const s = new TextDecoder().decode(c.buf.subarray(c.pos, c.pos + len));
  c.pos += len;
  return s;
}
// A sub-cursor over the next length-delimited field (a nested message).
function readMessage(c: Cursor): Cursor {
  const len = readVarint(c);
  const sub = { buf: c.buf.subarray(c.pos, c.pos + len), pos: 0 };
  c.pos += len;
  return sub;
}
function skipField(c: Cursor, wire: number): void {
  switch (wire) {
    case 0: readVarint(c); break;                              // varint
    case 1: c.pos += 8; break;                                 // 64-bit
    case 2: { const len = readVarint(c); c.pos += len; break; } // length-delimited
    case 5: c.pos += 4; break;                                 // 32-bit
    default: c.pos = c.buf.length;                             // unknown → bail out
  }
}

interface GtfsStop { code?: string; time?: number }
interface GtfsTrip { tripId?: string; routeId?: string; directionId?: number; stops: GtfsStop[] }

function parseStopTimeEvent(c: Cursor): number | undefined {
  let time: number | undefined;
  while (c.pos < c.buf.length) {
    const { field, wire } = readTag(c);
    if (field === 2 && wire === 0) time = readVarint(c);       // int64 time
    else skipField(c, wire);
  }
  return time;
}
function parseStopTimeUpdate(c: Cursor): GtfsStop {
  const stop: GtfsStop = {};
  let arrival: number | undefined, departure: number | undefined;
  while (c.pos < c.buf.length) {
    const { field, wire } = readTag(c);
    if (field === 4 && wire === 2) stop.code = stationCode(readString(c));
    else if (field === 2 && wire === 2) arrival = parseStopTimeEvent(readMessage(c));
    else if (field === 3 && wire === 2) departure = parseStopTimeEvent(readMessage(c));
    else skipField(c, wire);
  }
  stop.time = arrival ?? departure;   // first stop has departure only; terminus arrival only
  return stop;
}
function parseTripDescriptor(c: Cursor, trip: GtfsTrip): void {
  while (c.pos < c.buf.length) {
    const { field, wire } = readTag(c);
    if (field === 1 && wire === 2) trip.tripId = readString(c);
    else if (field === 5 && wire === 2) trip.routeId = readString(c);
    else if (field === 6 && wire === 0) trip.directionId = readVarint(c);
    else skipField(c, wire);
  }
}
function parseTripUpdate(c: Cursor): GtfsTrip {
  const trip: GtfsTrip = { stops: [] };
  while (c.pos < c.buf.length) {
    const { field, wire } = readTag(c);
    if (field === 1 && wire === 2) parseTripDescriptor(readMessage(c), trip);
    else if (field === 2 && wire === 2) trip.stops.push(parseStopTimeUpdate(readMessage(c)));
    else skipField(c, wire);
  }
  return trip;
}
function parseTripUpdateFeed(buf: Uint8Array): GtfsTrip[] {
  const c: Cursor = { buf, pos: 0 };
  const trips: GtfsTrip[] = [];
  while (c.pos < c.buf.length) {
    const { field, wire } = readTag(c);
    if (field === 2 && wire === 2) {              // FeedEntity
      const ent = readMessage(c);
      while (ent.pos < ent.buf.length) {
        const t = readTag(ent);
        if (t.field === 3 && t.wire === 2) trips.push(parseTripUpdate(readMessage(ent)));
        else skipField(ent, t.wire);
      }
    } else skipField(c, wire);
  }
  return trips;
}

// VehiclePositions → a trip_id → car-count map. Reads just the two fields we
// need: the trip descriptor's trip_id (the join key) and the vehicle
// descriptor's license_plate (whose "<n>_…" prefix is the car count).
function tripIdOf(c: Cursor): string | undefined {
  let id: string | undefined;
  while (c.pos < c.buf.length) {
    const { field, wire } = readTag(c);
    if (field === 1 && wire === 2) id = readString(c);
    else skipField(c, wire);
  }
  return id;
}
function carCountOf(c: Cursor): number | undefined {   // VehicleDescriptor
  let lp: string | undefined;
  while (c.pos < c.buf.length) {
    const { field, wire } = readTag(c);
    if (field === 3 && wire === 2) lp = readString(c);
    else skipField(c, wire);
  }
  const m = lp ? /^(\d+)_/.exec(lp) : null;
  return m ? Number(m[1]) : undefined;
}
function parseVehiclePosition(c: Cursor): { tripId?: string; cars?: number } {
  let tripId: string | undefined, cars: number | undefined;
  while (c.pos < c.buf.length) {
    const { field, wire } = readTag(c);
    if (field === 1 && wire === 2) tripId = tripIdOf(readMessage(c));       // trip descriptor
    else if (field === 8 && wire === 2) cars = carCountOf(readMessage(c));  // vehicle descriptor
    else skipField(c, wire);
  }
  return { tripId, cars };
}
function parseVehiclePositionFeed(buf: Uint8Array): Map<string, number> {
  const c: Cursor = { buf, pos: 0 };
  const out = new Map<string, number>();
  while (c.pos < c.buf.length) {
    const { field, wire } = readTag(c);
    if (field === 2 && wire === 2) {              // FeedEntity
      const ent = readMessage(c);
      while (ent.pos < ent.buf.length) {
        const t = readTag(ent);
        if (t.field === 4 && t.wire === 2) {       // FeedEntity.vehicle
          const { tripId, cars } = parseVehiclePosition(readMessage(ent));
          if (tripId && cars && cars > 0) out.set(tripId, cars);
        } else skipField(ent, t.wire);
      }
    } else skipField(c, wire);
  }
  return out;
}

// GTFS stop_ids embed the station code: "PF_A08_C" → "A08". No static GTFS
// lookup needed — the middle token is exactly WMATA's platform code.
function stationCode(stopId: string): string | undefined {
  return /^[A-Z]+_([A-Z]\d{2})_/.exec(stopId)?.[1];
}

const ROUTE_TO_LINE: Record<string, LineCode> = {
  RED: 'RD', ORANGE: 'OR', SILVER: 'SV', BLUE: 'BL', YELLOW: 'YL', GREEN: 'GR',
};

// How far out to surface predictions, and the per-platform-direction row cap.
// The cap bounds the stored snapshot: the whole system lives in one Durable
// Object value (128 KiB limit), and 186 platform-directions × this cap × ~100
// bytes/row must stay well under it. 5 keeps us ~85 KiB and still reaches the
// next train of each line at busy shared platforms (e.g. the 2nd Franconia at
// Pentagon City). The frontend slices to 6, so it renders whatever it's given.
const FEED_HORIZON_MIN = 45;
const MAX_PLATFORM_ROWS = 5;

// Sort key mirroring the frontend's minRank so the per-platform cap keeps the
// soonest trains.
const minRank = (m: string): number => {
  if (m === 'ARR') return -1;
  const n = parseInt(m, 10);
  return Number.isNaN(n) ? 999 : n;
};

// Convert decoded trips into the flat per-platform Train list the frontend
// expects. Each stop on a trip becomes a board row at that station, in the
// trip's travel direction (direction_id → group). The trip's final stop is its
// destination; we skip that stop itself (a train terminating at your platform
// isn't a boardable departure — its turnaround shows up as a separate trip).
function tripsToTrains(
  trips: GtfsTrip[], nowSec: number, codeToName: Map<string, string>, carsByTrip: Map<string, number>,
): Train[] {
  const rows: Train[] = [];
  for (const trip of trips) {
    const line = trip.routeId ? ROUTE_TO_LINE[trip.routeId] ?? null : null;
    const stops = trip.stops.filter((s) => s.code);
    if (stops.length === 0) continue;
    const destCode = stops[stops.length - 1].code ?? null;
    const dest = (destCode && codeToName.get(destCode)) || '—';
    const group = trip.directionId === 1 ? '2' : '1';
    // Car count joined by trip_id from VehiclePositions; absent for trains not
    // yet dispatched (typically the further-out trips).
    const carCount = trip.tripId ? carsByTrip.get(trip.tripId) : undefined;
    const cars = carCount && carCount > 0 ? String(carCount) : null;
    for (const s of stops) {
      if (!s.code || s.code === destCode || s.time == null) continue;
      const minutes = (s.time - nowSec) / 60;
      if (minutes < -0.5 || minutes > FEED_HORIZON_MIN) continue;
      rows.push({
        line, dest, destCode, cars,
        min: minutes < 0.5 ? 'ARR' : String(Math.round(minutes)),
        group, loc: s.code,
      });
    }
  }
  return capPerPlatform(rows);
}

// Keep only the soonest MAX_PLATFORM_ROWS per platform+direction so the stored
// snapshot stays small (the whole system in one DO value).
function capPerPlatform(rows: Train[]): Train[] {
  const byPlatform = new Map<string, Train[]>();
  for (const t of rows) {
    const k = `${t.loc}|${t.group}`;
    let arr = byPlatform.get(k);
    if (!arr) { arr = []; byPlatform.set(k, arr); }
    arr.push(t);
  }
  const out: Train[] = [];
  for (const arr of byPlatform.values()) {
    arr.sort((a, b) => minRank(a.min) - minRank(b.min));
    out.push(...arr.slice(0, MAX_PLATFORM_ROWS));
  }
  return out;
}

// Fallback dest resolution for the GetPrediction path (used only when GTFS-RT is
// unavailable). Keys are abbreviated dest strings WMATA puts on platform signs;
// values are the canonical full names that match the station picker. Lookup is
// case-insensitive so ALL-CAPS variants like "REAGAN AIRPORT" match. Extend this
// map when "unmapped destination" warnings show up in Worker logs.
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

// ── fetch + store routines (called by both scheduled and cold-DO fallback) ──
async function fetchTripUpdates(env: Env): Promise<GtfsTrip[]> {
  const r = await fetch(`${WMATA_BASE}/gtfs/rail-gtfsrt-tripupdates.pb`, {
    headers: { api_key: env.WMATA_KEY },
  });
  if (!r.ok) throw new Error(`WMATA ${r.status} ${r.statusText} for gtfs tripupdates`);
  return parseTripUpdateFeed(new Uint8Array(await r.arrayBuffer()));
}
async function fetchVehicleCars(env: Env): Promise<Map<string, number>> {
  const r = await fetch(`${WMATA_BASE}/gtfs/rail-gtfsrt-vehiclepositions.pb`, {
    headers: { api_key: env.WMATA_KEY },
  });
  if (!r.ok) throw new Error(`WMATA ${r.status} ${r.statusText} for gtfs vehiclepositions`);
  return parseVehiclePositionFeed(new Uint8Array(await r.arrayBuffer()));
}
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
async function fetchElevator(env: Env): Promise<ElevatorOutage[]> {
  const data = await wmataGet<{ ElevatorIncidents?: RawElevator[] }>(
    'Incidents.svc/json/ElevatorIncidents', env.WMATA_KEY);
  return adaptElevator(data.ElevatorIncidents ?? []);
}
// jStationTimes with no StationCode returns all 102 stations in one call.
async function fetchStationTimes(env: Env, codeToName: Map<string, string>): Promise<StationTimes> {
  const data = await wmataGet<{ StationTimes?: RawStationTime[] }>(
    'Rail.svc/json/jStationTimes', env.WMATA_KEY);
  return adaptStationTimes(data.StationTimes ?? [], codeToName);
}
async function refreshElevator(env: Env): Promise<ElevatorOutage[]> {
  const outages = await fetchElevator(env);
  await cache(env).putElevator(outages);
  return outages;
}
async function refreshStationTimes(env: Env): Promise<StationTimes> {
  const c = cache(env);
  const stations = applyNameOverrides((await c.getStations()) ?? (await refreshStations(env)));
  const codeToName = new Map<string, string>();
  for (const s of stations) for (const code of s.codes) codeToName.set(code, s.name);
  const times = await fetchStationTimes(env, codeToName);
  await c.putStationTimes(times);
  return times;
}

// Resolve GetPrediction's raw/abbreviated destinations to canonical station
// names. Only used on the fallback path — the GTFS-RT path resolves dest
// straight from the destination station code.
//   1. destCode lookup against the canonical station list (most precise)
//   2. hardcoded short→long map (deterministic, fast)
//   3. fuzzy token+vowel-drop match against canonical station names
//   4. raw WMATA `dest` (last resort — logged so we can extend the map)
function enrichPredictions(
  trains: Train[], codeToName: Map<string, string>, fuzzyIndex: StationFuzzy[],
): Train[] {
  const fuzzyMemo = new Map<string, string | undefined>();
  const fuzzy = (dest: string): string | undefined => {
    if (fuzzyIndex.length === 0) return undefined;
    if (fuzzyMemo.has(dest)) return fuzzyMemo.get(dest);
    const result = fuzzyMatch(dest, fuzzyIndex);
    fuzzyMemo.set(dest, result);
    return result;
  };
  return trains.map((t) => {
    const fromCode = t.destCode ? codeToName.get(t.destCode) : undefined;
    const fromAbbrev = ABBREV_LOOKUP[t.dest.toLowerCase()];
    const fromFuzzy = (!fromCode && !fromAbbrev) ? fuzzy(t.dest) : undefined;
    if (!fromCode && !fromAbbrev && !fromFuzzy && !t.destCode) {
      console.warn('unmapped destination (fuzzy missed)', { dest: t.dest, line: t.line, loc: t.loc });
    }
    return { ...t, dest: fromCode || fromAbbrev || fromFuzzy || t.dest };
  });
}

async function refreshPredictions(env: Env): Promise<Train[]> {
  const c = cache(env);

  // codeToName maps a destination station code → canonical name (for the
  // GTFS-RT dest column). fuzzyIndex is only needed for the GetPrediction
  // fallback. If stations is cold, refresh it once on the way through.
  const codeToName = new Map<string, string>();
  let fuzzyIndex: StationFuzzy[] = [];
  try {
    const cached = await c.getStations();
    const stations = applyNameOverrides(
      (cached && cached.length > 0) ? cached : await refreshStations(env));
    for (const s of stations) for (const code of s.codes) codeToName.set(code, s.name);
    fuzzyIndex = buildFuzzyIndex(stations);
  } catch (e) {
    console.warn('stations unavailable for prediction enrichment; keeping raw dest', e);
  }

  // Primary: GTFS-RT TripUpdates (real predictions, full horizon, all trains).
  // Fallback: legacy GetPrediction (nearest ~3 per platform) so the board never
  // goes blank if the protobuf feed hiccups.
  let trains: Train[];
  try {
    // Car counts (VehiclePositions) are a best-effort side channel: if that feed
    // fails we still serve predictions, just without the "N car" line.
    const [trips, carsByTrip] = await Promise.all([
      fetchTripUpdates(env),
      fetchVehicleCars(env).catch((e) => {
        console.warn('vehiclepositions failed; serving without car counts', e);
        return new Map<string, number>();
      }),
    ]);
    if (trips.length === 0) throw new Error('empty tripupdates feed');
    trains = tripsToTrains(trips, Date.now() / 1000, codeToName, carsByTrip);
  } catch (e) {
    console.warn('gtfs-rt tripupdates failed; falling back to GetPrediction', e);
    trains = enrichPredictions(await fetchAllPredictions(env), codeToName, fuzzyIndex);
  }

  await c.putPredictions(trains);
  return trains;
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
        ctx.waitUntil(
          Promise.all([refreshIncidents(env), refreshElevator(env)])
            .then(() => undefined)
            .catch((e) => console.error('incidents/elevator refresh failed', e)));
        return;
      case '17 6 * * *':
        // Sequential: station times resolves destination codes against the
        // freshly-refreshed station list.
        ctx.waitUntil(
          refreshStations(env)
            .then(() => refreshStationTimes(env))
            .then(() => undefined)
            .catch((e) => console.error('daily refresh failed', e)));
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
        const stations = applyNameOverrides(
          (await c.getStations()) ?? (await refreshStations(env)));
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

      const timesMatch = /^station-times\/([^/]+)\/?$/.exec(path);
      if (timesMatch) {
        const codes = parseCodes(timesMatch[1]);
        if (!codes) return json({ error: 'invalid_codes' }, { status: 400 });
        const all = (await c.getStationTimes()) ?? (await refreshStationTimes(env));
        const subset: StationTimes = {};
        for (const code of codes) if (all[code]) subset[code] = all[code];
        return json(subset, { cacheControl: CC_STATIONS });
      }

      const elevMatch = /^elevator\/([^/]+)\/?$/.exec(path);
      if (elevMatch) {
        const codes = parseCodes(elevMatch[1]);
        if (!codes) return json({ error: 'invalid_codes' }, { status: 400 });
        const all = (await c.getElevator()) ?? (await refreshElevator(env));
        const codeSet = new Set(codes);
        const subset = all.filter((e) => codeSet.has(e.station));
        return json(subset, { cacheControl: CC_INCIDENTS });
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

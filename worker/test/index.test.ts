import { describe, expect, it } from 'vitest';
import {
  parseCodes, subPath, stationCode,
  parseTripUpdateFeed, parseVehiclePositionFeed, tripsToTrains,
  fuzzyMatch, buildFuzzyIndex, adaptStations, nextBeat,
  type GtfsTrip, type Station,
} from '../src/index';

/* ── mini protobuf encoder ───────────────────────────────────────────────────
   Builds real wire-format bytes so the hand-rolled reader in src/index.ts is
   tested against the actual encoding, not against itself. */
function varint(n: number): number[] {
  const out: number[] = [];
  // % / floor instead of bitwise so values past 2^32 (64-bit timestamps)
  // encode correctly — mirrors the reader's float-based decoding.
  while (n >= 0x80) { out.push((n % 128) + 128); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
const key = (field: number, wire: number) => varint(field * 8 + wire);
const vint = (field: number, n: number) => [...key(field, 0), ...varint(n)];
const lenDelim = (field: number, bytes: number[]) =>
  [...key(field, 2), ...varint(bytes.length), ...bytes];
const str = (field: number, s: string) => lenDelim(field, [...new TextEncoder().encode(s)]);
const fixed64 = (field: number, bytes = [0, 0, 0, 0, 0, 0, 0, 0]) => [...key(field, 1), ...bytes];

// GTFS-RT message builders (field numbers from the schema comment in src).
const stopTimeEvent = (time: number) => vint(2, time);
const stopTimeUpdate = (stopId: string, o: { arrival?: number; departure?: number }) => [
  ...(o.arrival != null ? lenDelim(2, stopTimeEvent(o.arrival)) : []),
  ...(o.departure != null ? lenDelim(3, stopTimeEvent(o.departure)) : []),
  ...str(4, stopId),
];
const tripDescriptor = (tripId: string, routeId: string, directionId: number) =>
  [...str(1, tripId), ...str(5, routeId), ...vint(6, directionId)];
const tripUpdateEntity = (trip: number[], stops: number[][]) =>
  lenDelim(2, lenDelim(3, [...lenDelim(1, trip), ...stops.flatMap((s) => lenDelim(2, s))]));
const vehicleEntity = (tripId: string, licensePlate?: string) =>
  lenDelim(2, lenDelim(4, [
    ...lenDelim(1, str(1, tripId)),
    ...lenDelim(8, licensePlate ? str(3, licensePlate) : []),
  ]));
const feed = (...entities: number[][]) => new Uint8Array(entities.flat());

const NOW = 1_752_500_000; // any fixed Unix time (seconds)

describe('parseTripUpdateFeed', () => {
  it('decodes trips, stops, and 64-bit arrival times', () => {
    const bytes = feed(
      tripUpdateEntity(tripDescriptor('T1', 'RED', 1), [
        stopTimeUpdate('PF_A01_C', { arrival: 5_000_000_000 }),   // > 2^32
        stopTimeUpdate('PF_A02_C', { departure: NOW + 600 }),     // departure-only
        stopTimeUpdate('PF_B11_C', { arrival: NOW + 900 }),
      ]),
    );
    const trips = parseTripUpdateFeed(bytes);
    expect(trips).toHaveLength(1);
    expect(trips[0].tripId).toBe('T1');
    expect(trips[0].routeId).toBe('RED');
    expect(trips[0].directionId).toBe(1);
    expect(trips[0].stops).toEqual([
      { code: 'A01', time: 5_000_000_000 },
      { code: 'A02', time: NOW + 600 },
      { code: 'B11', time: NOW + 900 },
    ]);
  });

  it('prefers arrival over departure when both are present', () => {
    const bytes = feed(tripUpdateEntity(tripDescriptor('T1', 'RED', 0), [
      stopTimeUpdate('PF_A01_C', { arrival: NOW + 60, departure: NOW + 90 }),
    ]));
    expect(parseTripUpdateFeed(bytes)[0].stops[0].time).toBe(NOW + 60);
  });

  it('skips unknown fields of every wire type', () => {
    const noise = [
      ...vint(15, 42),              // varint
      ...fixed64(14),               // 64-bit
      ...str(13, 'ignore-me'),      // length-delimited
    ];
    const trip = [...lenDelim(1, [...tripDescriptor('T2', 'GREEN', 0), ...noise]), ...noise];
    const bytes = feed([...lenDelim(2, [...lenDelim(3, trip), ...noise]), ...noise].flat());
    const trips = parseTripUpdateFeed(bytes);
    expect(trips).toHaveLength(1);
    expect(trips[0].tripId).toBe('T2');
    expect(trips[0].routeId).toBe('GREEN');
  });

  it('returns [] for an empty feed', () => {
    expect(parseTripUpdateFeed(new Uint8Array())).toEqual([]);
  });
});

describe('parseVehiclePositionFeed', () => {
  it('maps trip_id → car count from the license_plate prefix', () => {
    const bytes = feed(
      vehicleEntity('T1', '8_7610-7611'),
      vehicleEntity('T2', '6_3000'),
      vehicleEntity('T3', 'no-prefix'),   // unparseable → omitted
      vehicleEntity('T4'),                // no plate → omitted
    );
    const cars = parseVehiclePositionFeed(bytes);
    expect(cars.get('T1')).toBe(8);
    expect(cars.get('T2')).toBe(6);
    expect(cars.has('T3')).toBe(false);
    expect(cars.has('T4')).toBe(false);
  });
});

describe('tripsToTrains', () => {
  const codeToName = new Map([
    ['A01', 'Metro Center'], ['A02', 'Farragut North'], ['B11', 'Glenmont'],
  ]);
  const trip = (stops: GtfsTrip['stops'], directionId = 1): GtfsTrip =>
    ({ tripId: 'T1', routeId: 'RED', directionId, stops });

  it('emits a row per boardable stop, skipping the terminal', () => {
    const rows = tripsToTrains(
      [trip([
        { code: 'A01', time: NOW + 300 },
        { code: 'A02', time: NOW + 600 },
        { code: 'B11', time: NOW + 900 },   // destination — not boardable
      ])],
      NOW, codeToName, new Map([['T1', 8]]));
    expect(rows).toEqual([
      { line: 'RD', dest: 'Glenmont', destCode: 'B11', cars: '8', min: '5', group: '2', loc: 'A01' },
      { line: 'RD', dest: 'Glenmont', destCode: 'B11', cars: '8', min: '10', group: '2', loc: 'A02' },
    ]);
  });

  it('marks imminent arrivals ARR and applies the 45-min horizon', () => {
    const rows = tripsToTrains(
      [trip([
        { code: 'A01', time: NOW + 10 },        // < 0.5 min → ARR
        { code: 'A02', time: NOW + 46 * 60 },   // past horizon → dropped
        { code: 'B11', time: NOW + 60 * 60 },
      ])],
      NOW, codeToName, new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ min: 'ARR', loc: 'A01', cars: null });
  });

  it('caps each platform+direction at 5 soonest rows', () => {
    const trips = Array.from({ length: 7 }, (_, i): GtfsTrip => ({
      tripId: `T${i}`, routeId: 'RED', directionId: 0,
      stops: [
        { code: 'A01', time: NOW + (7 - i) * 300 },  // 35,30,…,5 min out
        { code: 'B11', time: NOW + 3600 },
      ],
    }));
    const rows = tripsToTrains(trips, NOW, codeToName, new Map());
    const a01 = rows.filter((r) => r.loc === 'A01');
    expect(a01).toHaveLength(5);
    expect(a01.map((r) => r.min)).toEqual(['5', '10', '15', '20', '25']);
  });
});

describe('stationCode', () => {
  it('extracts the platform code from a GTFS stop_id', () => {
    expect(stationCode('PF_A08_C')).toBe('A08');
    expect(stationCode('STN_B35_1')).toBe('B35');
  });
  it('returns undefined for non-platform ids', () => {
    expect(stationCode('PF_A08')).toBeUndefined();
    expect(stationCode('A08')).toBeUndefined();
    expect(stationCode('')).toBeUndefined();
  });
});

describe('fuzzyMatch', () => {
  const index = buildFuzzyIndex([
    'Pentagon', 'Pentagon City', 'West Falls Church', 'East Falls Church',
    'Reagan National Airport', 'Franconia-Springfield', 'Metro Center',
  ].map((name): Station => ({ name, codes: [], lines: ['BL'] })));

  it.each([
    ['Pntgn City', 'Pentagon City'],       // vowel-drop exact
    ['W Falls Ch', 'West Falls Church'],   // initial-letter prefix breaks the tie
    ['Reagan Natl', 'Reagan National Airport'],
    ['Frnconia', 'Franconia-Springfield'],
  ])('resolves %s → %s', (abbrev, expected) => {
    expect(fuzzyMatch(abbrev, index)).toBe(expected);
  });

  it('refuses ambiguous and unmatchable inputs', () => {
    expect(fuzzyMatch('Falls Ch', index)).toBeUndefined();   // West vs East tie
    expect(fuzzyMatch('Zzzzz', index)).toBeUndefined();
    expect(fuzzyMatch('', index)).toBeUndefined();
  });
});

describe('parseCodes', () => {
  it('accepts one to eight comma-separated codes', () => {
    expect(parseCodes('A01')).toEqual(['A01']);
    expect(parseCodes('A01,C01')).toEqual(['A01', 'C01']);
    expect(parseCodes(Array(8).fill('A01').join(','))).toHaveLength(8);
  });
  it('rejects anything else', () => {
    expect(parseCodes(Array(9).fill('A01').join(','))).toBeNull();
    expect(parseCodes('a01')).toBeNull();
    expect(parseCodes('A01;C01')).toBeNull();
    expect(parseCodes('A01,')).toBeNull();
    expect(parseCodes('')).toBeNull();
  });
});

describe('subPath', () => {
  it('serves the same route via the custom-domain and workers.dev prefixes', () => {
    expect(subPath('/api/wmata/stations')).toBe('stations');
    expect(subPath('/wmata/predictions/A01')).toBe('predictions/A01');
    expect(subPath('/api/wmata/health')).toBe('health');
    expect(subPath('/wmata/')).toBe('');
  });
});

describe('adaptStations', () => {
  type Raw = Parameters<typeof adaptStations>[0][number];
  const raw = (over: Partial<Raw>): Raw => ({
    Code: 'A01', Name: 'Metro Center',
    LineCode1: 'RD', LineCode2: null, LineCode3: null, LineCode4: null,
    ...over,
  });

  it('merges transfer-station platforms and dedupes lines', () => {
    const out = adaptStations([
      raw({ Code: 'A01', LineCode1: 'RD', Lat: 38.9, Lon: -77.03 }),
      raw({ Code: 'C01', LineCode1: 'BL', LineCode2: 'OR', LineCode3: 'SV' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].codes).toEqual(['A01', 'C01']);
    expect(out[0].lines).toEqual(['RD', 'BL', 'OR', 'SV']);
    expect(out[0].lat).toBe(38.9);
  });

  it('applies code-keyed name overrides and drops lineless stations', () => {
    const out = adaptStations([
      raw({ Code: 'E01', Name: 'Mt Vernon Sq 7th St-Convention Center', LineCode1: 'GR' }),
      raw({ Code: 'X99', Name: 'Ghost', LineCode1: 'ZZ' }),   // no valid lines
    ]);
    expect(out.map((s) => s.name)).toEqual(['Mt Vernon Sq']);
  });
});

describe('nextBeat', () => {
  it('rounds up to the next 5s wall-clock boundary', () => {
    expect(nextBeat(1_000_001_000)).toBe(1_000_005_000);
    expect(nextBeat(1_000_004_999)).toBe(1_000_005_000);
  });
  it('moves a full interval ahead when already on a boundary', () => {
    expect(nextBeat(1_000_000_000)).toBe(1_000_005_000);
  });
});

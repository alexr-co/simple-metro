/* Line palette, station list, demo data. ES module — no globals. */

export type LineCode = 'RD' | 'OR' | 'SV' | 'BL' | 'YL' | 'GR';

export interface Line {
  name: string;
  color: string;
  ink: string;
}

export interface Station {
  name: string;
  codes: string[];      // every platform code at this station (transfer stations carry two)
  lines: LineCode[];
}

export interface Train {
  line: LineCode | null;
  dest: string;          // canonical full name, resolved server-side from destCode
  destCode: string | null;
  cars: string | null;
  min: string;           // "BRD" | "ARR" | "1".. | "—"
  group: string;         // WMATA direction group, "1" | "2"
  loc: string;           // platform code
}

export interface Incident {
  lines: LineCode[];
  type: string;
  text: string;
}

export const LINES: Record<LineCode, Line> = {
  RD: { name: 'Red',    color: '#C8102E', ink: '#fff' },
  OR: { name: 'Orange', color: '#E07A00', ink: '#fff' },
  SV: { name: 'Silver', color: '#8A9396', ink: '#fff' },
  BL: { name: 'Blue',   color: '#0070C0', ink: '#fff' },
  YL: { name: 'Yellow', color: '#F2C300', ink: '#14130E' },
  GR: { name: 'Green',  color: '#00A94F', ink: '#fff' },
};

const S = (name: string, codes: string[], lines: LineCode[]): Station => ({ name, codes, lines });

export const STATIONS: Station[] = [
  S('Shady Grove',            ['A15'], ['RD']),
  S('Rockville',              ['A14'], ['RD']),
  S('Twinbrook',              ['A13'], ['RD']),
  S('North Bethesda',         ['A12'], ['RD']),
  S('Grosvenor–Strathmore',   ['A11'], ['RD']),
  S('Medical Center',         ['A10'], ['RD']),
  S('Bethesda',               ['A09'], ['RD']),
  S('Friendship Heights',     ['A08'], ['RD']),
  S('Tenleytown–AU',          ['A07'], ['RD']),
  S('Van Ness–UDC',           ['A06'], ['RD']),
  S('Cleveland Park',         ['A05'], ['RD']),
  S('Woodley Park',           ['A04'], ['RD']),
  S('Dupont Circle',          ['A03'], ['RD']),
  S('Farragut North',         ['A02'], ['RD']),
  S('Metro Center',           ['A01', 'C01'], ['RD', 'BL', 'OR', 'SV']),
  S('Gallery Pl–Chinatown',   ['B01', 'F01'], ['RD', 'YL', 'GR']),
  S('Judiciary Square',       ['B02'], ['RD']),
  S('Union Station',          ['B03'], ['RD']),
  S('NoMa–Gallaudet U',       ['B35'], ['RD']),
  S('Rhode Island Ave',       ['B04'], ['RD']),
  S('Brookland–CUA',          ['B05'], ['RD']),
  S('Fort Totten',            ['B06', 'E06'], ['RD', 'YL', 'GR']),
  S('Takoma',                 ['B07'], ['RD']),
  S('Silver Spring',          ['B08'], ['RD']),
  S('Forest Glen',            ['B09'], ['RD']),
  S('Wheaton',                ['B10'], ['RD']),
  S('Glenmont',               ['B11'], ['RD']),
  S('McPherson Square',       ['C02'], ['BL', 'OR', 'SV']),
  S('Farragut West',          ['C03'], ['BL', 'OR', 'SV']),
  S('Foggy Bottom–GWU',       ['C04'], ['BL', 'OR', 'SV']),
  S('Rosslyn',                ['C05'], ['BL', 'OR', 'SV']),
  S('Arlington Cemetery',     ['C06'], ['BL']),
  S('Pentagon',               ['C07'], ['BL', 'YL']),
  S('Pentagon City',          ['C08'], ['BL', 'YL']),
  S('Crystal City',           ['C09'], ['BL', 'YL']),
  S('Ronald Reagan Washington National Airport', ['C10'], ['BL', 'YL']),
  S('Braddock Road',          ['C12'], ['BL', 'YL']),
  S('King St–Old Town',       ['C13'], ['BL', 'YL']),
  S('Eisenhower Avenue',      ['C14'], ['YL']),
  S('Huntington',             ['C15'], ['YL']),
  S('Van Dorn Street',        ['J02'], ['BL']),
  S('Franconia–Springfield',  ['J03'], ['BL']),
  S('Court House',            ['K01'], ['OR', 'SV']),
  S('Clarendon',              ['K02'], ['OR', 'SV']),
  S('Virginia Square–GMU',    ['K03'], ['OR', 'SV']),
  S('Ballston–MU',            ['K04'], ['OR', 'SV']),
  S('East Falls Church',      ['K05'], ['OR', 'SV']),
  S('West Falls Church',      ['K06'], ['OR']),
  S('Dunn Loring–Merrifield', ['K07'], ['OR']),
  S('Vienna/Fairfax–GMU',     ['K08'], ['OR']),
  S('McLean',                 ['N01'], ['SV']),
  S('Tysons',                 ['N02'], ['SV']),
  S('Greensboro',             ['N03'], ['SV']),
  S('Spring Hill',            ['N04'], ['SV']),
  S('Wiehle–Reston East',     ['N06'], ['SV']),
  S('Reston Town Center',     ['N07'], ['SV']),
  S('Herndon',                ['N08'], ['SV']),
  S('Innovation Center',      ['N09'], ['SV']),
  S('Washington Dulles Intl Airport', ['N10'], ['SV']),
  S('Loudoun Gateway',        ['N11'], ['SV']),
  S('Ashburn',                ['N12'], ['SV']),
  S('Smithsonian',            ['D02'], ['BL', 'OR', 'SV']),
  S('Federal Triangle',       ['D01'], ['BL', 'OR', 'SV']),
  S("L'Enfant Plaza",         ['D03', 'F03'], ['BL', 'OR', 'SV', 'YL', 'GR']),
  S('Federal Center SW',      ['D04'], ['BL', 'OR', 'SV']),
  S('Capitol South',          ['D05'], ['BL', 'OR', 'SV']),
  S('Eastern Market',         ['D06'], ['BL', 'OR', 'SV']),
  S('Potomac Ave',            ['D07'], ['BL', 'OR', 'SV']),
  S('Stadium–Armory',         ['D08'], ['BL', 'OR', 'SV']),
  S('Minnesota Ave',          ['D09'], ['OR']),
  S('Deanwood',               ['D10'], ['OR']),
  S('Cheverly',               ['D11'], ['OR']),
  S('Landover',               ['D12'], ['OR']),
  S('New Carrollton',         ['D13'], ['OR']),
  S('Benning Road',           ['G01'], ['BL', 'SV']),
  S('Capitol Heights',        ['G02'], ['BL', 'SV']),
  S('Addison Road',           ['G03'], ['BL', 'SV']),
  S('Morgan Boulevard',       ['G04'], ['BL', 'SV']),
  S('Downtown Largo',         ['G05'], ['BL', 'SV']),
  S('Mt Vernon Sq–7th St',    ['E01'], ['GR', 'YL']),
  S('Shaw–Howard U',          ['E02'], ['GR', 'YL']),
  S('U Street',               ['E03'], ['GR', 'YL']),
  S('Columbia Heights',       ['E04'], ['GR', 'YL']),
  S('Georgia Ave–Petworth',   ['E05'], ['GR', 'YL']),
  S('West Hyattsville',       ['E07'], ['GR', 'YL']),
  S('Hyattsville Crossing',   ['E08'], ['GR', 'YL']),
  S('College Park–U of Md',   ['E09'], ['GR', 'YL']),
  S('Greenbelt',              ['E10'], ['GR', 'YL']),
  S('Archives–Navy Memorial', ['F02'], ['GR', 'YL']),
  S('Waterfront',             ['F04'], ['GR']),
  S('Navy Yard–Ballpark',     ['F05'], ['GR']),
  S('Anacostia',              ['F06'], ['GR']),
  S('Congress Heights',       ['F07'], ['GR']),
  S('Southern Avenue',        ['F08'], ['GR']),
  S('Naylor Road',            ['F09'], ['GR']),
  S('Suitland',               ['F10'], ['GR']),
  S('Branch Ave',             ['F11'], ['GR']),
];

const TERMINALS: Record<LineCode, string[]> = {
  RD: ['Shady Grove', 'Glenmont'],
  OR: ['Vienna', 'New Carrollton'],
  SV: ['Ashburn', 'Downtown Largo'],
  BL: ['Franconia', 'Downtown Largo'],
  YL: ['Huntington', 'Mt Vernon Sq'],
  GR: ['Branch Ave', 'Greenbelt'],
};

// Park-Miller PRNG so the demo board doesn't reshuffle wildly every tick.
function rng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Demo predictions grouped per platform = station code + direction, so
// multi-code transfer stations show all four platforms.
export function demoPredictions(station: Station, tickSeed: number): Train[] {
  const rand = rng((tickSeed || 1) + station.name.length * 7);
  const lines = station.lines.length ? station.lines : (['RD'] as LineCode[]);
  const trains: Train[] = [];
  station.codes.forEach((code, ci) => {
    ([1, 2] as const).forEach((group) => {
      let prev = group === 1 ? 1 : 2;
      const n = 2 + Math.floor(rand() * 2);
      for (let i = 0; i < n; i++) {
        const line = lines[Math.floor(rand() * lines.length)];
        const terms = TERMINALS[line] ?? ['Downtown'];
        const dest = terms[(group - 1 + i) % terms.length];
        let min: string;
        if (i === 0 && ci === 0 && group === 1 && rand() > 0.6) min = 'BRD';
        else if (i === 0 && rand() > 0.7) min = 'ARR';
        else { prev += 1 + Math.floor(rand() * 5); min = String(prev); }
        trains.push({
          line, dest, destCode: null,
          cars: rand() > 0.5 ? '8' : '6',
          min, group: String(group), loc: code,
        });
      }
    });
  });
  return trains;
}

export function demoIncidents(station: Station): Incident[] {
  if (!station.lines.length) return [];
  if ((station.name.charCodeAt(0) + station.name.length) % 4 !== 0) return [];
  const line = station.lines[0];
  return [{
    lines: [line],
    type: 'Delay',
    text: `${LINES[line].name} Line: trains are single-tracking near ${station.name}; expect waits up to 10 minutes.`,
  }];
}
